import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { compareCodeUnits } from "./canonical.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const MAX_REQUEST_TARGET_BYTES = 4_096;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_RUNS = 1_000;
const MAX_JSON_ARTIFACT_BYTES = 1_048_576;
const MAX_EVENT_LINE_BYTES = 262_144;
const MAX_EVENT_SCAN_BYTES = 67_108_864;
const MAX_EVENT_RESPONSE_BYTES = 4_194_304;

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const REDACTED = "[REDACTED]";

export interface ObserverServerOptions {
  /** Directory that contains run directories, directly or below experiment directories. */
  dataDir: string;
  /** Used by startObserverServer. Defaults to the loopback interface. */
  host?: string;
  /** Used by startObserverServer. Defaults to 8787; zero requests an ephemeral port. */
  port?: number;
}

interface RunRecord {
  directory: string;
  relativeDirectory: string;
  manifest: Record<string, unknown>;
  runId: string;
}

interface RunDiscovery {
  records: RunRecord[];
  truncated: boolean;
}

class ObserverHttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ObserverHttpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Create a read-only evidence server without binding a socket.
 *
 * The server never follows child symlinks and never exposes artifact paths or
 * exception messages. Callers that need a listening socket can use
 * startObserverServer instead.
 */
export function createObserverServer(options: ObserverServerOptions): Server {
  const configuredDataDir = validateDataDir(options.dataDir);
  const server = createServer(
    {
      maxHeaderSize: 16_384,
      requireHostHeader: true,
    },
    (request, response) => {
      void handleRequest(configuredDataDir, request, response).catch((error: unknown) => {
        if (response.headersSent || response.writableEnded) {
          response.destroy();
          return;
        }
        if (error instanceof ObserverHttpError) {
          sendJson(response, error.status, { error: error.code });
          return;
        }
        sendJson(response, 500, { error: "internal_error" });
      });
    },
  );

  // Reject Expect: 100-continue without inviting a request body first.
  server.on("checkContinue", (request, response) => {
    void handleRequest(configuredDataDir, request, response).catch((error: unknown) => {
      if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
      }
      if (error instanceof ObserverHttpError) {
        sendJson(response, error.status, { error: error.code });
        return;
      }
      sendJson(response, 500, { error: "internal_error" });
    });
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  return server;
}

/** Create and bind a read-only evidence server. */
export async function startObserverServer(options: ObserverServerOptions): Promise<Server> {
  const host = validateHost(options.host ?? DEFAULT_HOST);
  const port = validatePort(options.port ?? DEFAULT_PORT);
  const server = createObserverServer(options);

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });

  return server;
}

async function handleRequest(
  configuredDataDir: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    sendJson(response, 405, { error: "method_not_allowed" });
    return;
  }

  if (request.headers["content-length"] !== undefined || request.headers["transfer-encoding"] !== undefined) {
    sendJson(response, 400, { error: "request_body_not_allowed" });
    return;
  }

  const target = request.url ?? "/";
  if (Buffer.byteLength(target, "utf8") > MAX_REQUEST_TARGET_BYTES) {
    sendJson(response, 414, { error: "request_target_too_long" });
    return;
  }
  rejectTraversalTarget(target);

  let url: URL;
  try {
    url = new URL(target, "http://observer.invalid");
  } catch {
    throw new ObserverHttpError(400, "invalid_request_target");
  }

  if (url.pathname === "/") {
    sendJson(response, 200, {
      service: "agent-native-universe-observer",
      status: "read-only",
      links: {
        health: "/healthz",
        readiness: "/readyz",
        runs: "/api/runs",
      },
    });
    return;
  }

  if (url.pathname === "/healthz") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (url.pathname === "/readyz") {
    try {
      await resolveDataRoot(configuredDataDir);
      sendJson(response, 200, { status: "ready" });
    } catch {
      sendJson(response, 503, { status: "not_ready" });
    }
    return;
  }

  if (url.pathname === "/api/runs") {
    ensureNoQuery(url);
    const root = await resolveDataRootOr503(configuredDataDir);
    const discovery = await discoverRuns(root);
    const runs = [];
    for (const record of discovery.records) {
      let summary: Record<string, unknown> | null = null;
      try {
        summary = await readOptionalJsonArtifact(record.directory, "summary.json", root);
      } catch {
        // Keep one damaged run from making the full read-only catalogue unavailable.
      }
      runs.push(runListItem(record.manifest, summary));
    }
    sendJson(response, 200, {
      count: runs.length,
      runs,
      truncated: discovery.truncated,
    });
    return;
  }

  const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (eventsMatch !== null) {
    const runId = decodeRunId(eventsMatch[1]);
    const { after, limit } = parseEventQuery(url);
    const root = await resolveDataRootOr503(configuredDataDir);
    const record = await findRun(root, runId);
    if (record === undefined) throw new ObserverHttpError(404, "run_not_found");
    const page = await readEventPage(record, root, after, limit);
    sendJson(response, 200, {
      runId,
      after,
      limit,
      events: page.events,
      nextAfter: page.nextAfter,
      hasMore: page.hasMore,
    });
    return;
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
  if (runMatch !== null) {
    ensureNoQuery(url);
    const runId = decodeRunId(runMatch[1]);
    const root = await resolveDataRootOr503(configuredDataDir);
    const record = await findRun(root, runId);
    if (record === undefined) throw new ObserverHttpError(404, "run_not_found");
    const summary = await readOptionalJsonArtifact(record.directory, "summary.json", root);
    sendJson(response, 200, {
      runId,
      manifest: record.manifest,
      summary,
    });
    return;
  }

  sendJson(response, 404, { error: "not_found" });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(redactEvidence(value));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body, "utf8"));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.end(body);
}

function validateDataDir(dataDir: string): string {
  if (typeof dataDir !== "string" || dataDir.trim().length === 0 || dataDir.includes("\0")) {
    throw new TypeError("Observer dataDir must be a non-empty path");
  }
  return resolve(dataDir);
}

function validateHost(host: string): string {
  if (host.trim().length === 0 || host.includes("\0") || host.length > 255) {
    throw new TypeError("Observer host must be a non-empty host name or address");
  }
  return host;
}

function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("Observer port must be an integer from 0 through 65535");
  }
  return port;
}

async function resolveDataRoot(configuredDataDir: string): Promise<string> {
  const root = await realpath(configuredDataDir);
  const info = await lstat(root);
  if (!info.isDirectory()) throw new Error("not a directory");
  return root;
}

async function resolveDataRootOr503(configuredDataDir: string): Promise<string> {
  try {
    return await resolveDataRoot(configuredDataDir);
  } catch {
    throw new ObserverHttpError(503, "not_ready");
  }
}

async function discoverRuns(root: string): Promise<RunDiscovery> {
  const pending: Array<{ directory: string; depth: number; relativeDirectory: string }> = [
    { directory: root, depth: 0, relativeDirectory: "" },
  ];
  const found: RunRecord[] = [];
  let entriesSeen = 0;
  let truncated = false;

  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;

    let entries;
    try {
      entries = await readdir(current.directory, { withFileTypes: true });
    } catch (error) {
      if (current.directory === root) throw error;
      continue;
    }
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));

    if (entriesSeen + entries.length > MAX_SCAN_ENTRIES) {
      entries = entries.slice(0, Math.max(0, MAX_SCAN_ENTRIES - entriesSeen));
      truncated = true;
    }
    entriesSeen += entries.length;

    const manifestEntry = entries.find((entry) => entry.name === "manifest.json" && entry.isFile());
    if (manifestEntry !== undefined) {
      try {
        const manifest = await readJsonArtifact(current.directory, manifestEntry.name, root);
        const runId = readRunId(manifest);
        if (runId !== undefined) {
          found.push({
            directory: current.directory,
            relativeDirectory: current.relativeDirectory,
            manifest,
            runId,
          });
        }
      } catch {
        // A malformed or oversized manifest is not evidence and is not listed.
      }
      if (found.length >= MAX_RUNS) {
        truncated = true;
        break;
      }
      continue;
    }

    if (current.depth >= MAX_SCAN_DEPTH || entriesSeen >= MAX_SCAN_ENTRIES) {
      if (current.depth >= MAX_SCAN_DEPTH && entries.some((entry) => entry.isDirectory())) truncated = true;
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const child = join(current.directory, entry.name);
      let canonicalChild: string;
      try {
        canonicalChild = await realpath(child);
      } catch {
        continue;
      }
      if (!isWithin(root, canonicalChild)) continue;
      pending.push({
        directory: canonicalChild,
        depth: current.depth + 1,
        relativeDirectory:
          current.relativeDirectory.length === 0
            ? entry.name
            : `${current.relativeDirectory}/${entry.name}`,
      });
    }
  }

  found.sort((left, right) => {
    const byRunId = compareCodeUnits(left.runId, right.runId);
    return byRunId !== 0
      ? byRunId
      : compareCodeUnits(left.relativeDirectory, right.relativeDirectory);
  });

  const unique: RunRecord[] = [];
  let previousRunId: string | undefined;
  for (const record of found) {
    if (record.runId === previousRunId) {
      truncated = true;
      continue;
    }
    unique.push(record);
    previousRunId = record.runId;
  }
  return { records: unique, truncated };
}

async function findRun(root: string, runId: string): Promise<RunRecord | undefined> {
  const discovery = await discoverRuns(root);
  return discovery.records.find((record) => record.runId === runId);
}

function readRunId(manifest: Record<string, unknown>): string | undefined {
  const runId = manifest.runId;
  return typeof runId === "string" && isSafeRunId(runId) ? runId : undefined;
}

function runListItem(
  manifest: Record<string, unknown>,
  summary: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    runId: manifest.runId,
    experimentId: scalarOrNull(manifest.experimentId),
    universeId: scalarOrNull(manifest.universeId),
    schemaVersion: scalarOrNull(manifest.schemaVersion),
    completed: summary !== null,
    ticks: summary === null ? null : scalarOrNull(summary.ticks),
    events: summary === null ? null : scalarOrNull(summary.events),
    summaryAvailable: summary !== null,
  };
}

function scalarOrNull(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

async function readJsonArtifact(
  directory: string,
  fileName: string,
  root: string,
): Promise<Record<string, unknown>> {
  const text = await readBoundedFile(directory, fileName, root, MAX_JSON_ARTIFACT_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ObserverHttpError(422, "invalid_artifact");
  }
  if (!isJsonObject(parsed)) throw new ObserverHttpError(422, "invalid_artifact");
  return parsed;
}

async function readOptionalJsonArtifact(
  directory: string,
  fileName: string,
  root: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonArtifact(directory, fileName, root);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function readBoundedFile(
  directory: string,
  fileName: string,
  root: string,
  maxBytes: number,
): Promise<string> {
  const file = await openSafeArtifact(directory, fileName, root);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ObserverHttpError(422, "invalid_artifact");
    if (info.size > maxBytes) throw new ObserverHttpError(413, "artifact_too_large");

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset <= maxBytes) {
      const result = await file.read(buffer, offset, maxBytes + 1 - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new ObserverHttpError(413, "artifact_too_large");
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await file.close();
  }
}

async function openSafeArtifact(directory: string, fileName: string, root: string) {
  const candidate = join(directory, fileName);
  const candidateInfo = await lstat(candidate);
  if (candidateInfo.isSymbolicLink() || !candidateInfo.isFile()) {
    throw new ObserverHttpError(422, "invalid_artifact");
  }

  const canonicalDirectory = await realpath(directory);
  const canonicalFile = await realpath(candidate);
  if (!isWithin(root, canonicalDirectory) || !isWithin(canonicalDirectory, canonicalFile)) {
    throw new ObserverHttpError(422, "invalid_artifact");
  }

  return open(canonicalFile, constants.O_RDONLY | constants.O_NOFOLLOW);
}

async function readEventPage(
  record: RunRecord,
  root: string,
  after: number,
  limit: number,
): Promise<{ events: Record<string, unknown>[]; nextAfter: number; hasMore: boolean }> {
  let file;
  try {
    file = await openSafeArtifact(record.directory, "events.jsonl", root);
  } catch (error) {
    if (isMissingFile(error)) {
      return { events: [], nextAfter: after, hasMore: false };
    }
    throw error;
  }

  const selected: Record<string, unknown>[] = [];
  let selectedBytes = 0;
  let hasMore = false;
  let scannedBytes = 0;
  let pending = "";
  let previousSeq = 0;

  const consumeLine = (rawLine: string): boolean => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return false;
    if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
      throw new ObserverHttpError(413, "event_line_too_large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    if (!isJsonObject(parsed) || !Number.isSafeInteger(parsed.seq) || (parsed.seq as number) <= previousSeq) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const seq = parsed.seq as number;
    previousSeq = seq;
    if (seq <= after) return false;

    if (selected.length >= limit) {
      hasMore = true;
      return true;
    }
    const redacted = redactEvidence(parsed) as Record<string, unknown>;
    const eventBytes = Buffer.byteLength(JSON.stringify(redacted), "utf8");
    if (selectedBytes + eventBytes > MAX_EVENT_RESPONSE_BYTES) {
      hasMore = true;
      return true;
    }
    selected.push(redacted);
    selectedBytes += eventBytes;
    return false;
  };

  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ObserverHttpError(422, "invalid_event_log");
    const stream = file.createReadStream({ autoClose: false, encoding: "utf8", highWaterMark: 65_536 });
    for await (const chunk of stream) {
      scannedBytes += Buffer.byteLength(chunk, "utf8");
      if (scannedBytes > MAX_EVENT_SCAN_BYTES) {
        throw new ObserverHttpError(413, "event_scan_limit_exceeded");
      }
      pending += chunk;

      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (consumeLine(line)) break;
        newline = pending.indexOf("\n");
      }
      if (hasMore) break;
      if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_LINE_BYTES) {
        throw new ObserverHttpError(413, "event_line_too_large");
      }
    }
    if (!hasMore && pending.length > 0) consumeLine(pending);
  } finally {
    await file.close();
  }

  return {
    events: selected,
    nextAfter: selected.length === 0 ? after : (selected.at(-1)?.seq as number),
    hasMore,
  };
}

function parseEventQuery(url: URL): { after: number; limit: number } {
  for (const key of url.searchParams.keys()) {
    if (key !== "after" && key !== "limit") throw new ObserverHttpError(400, "invalid_query");
  }
  if (url.searchParams.getAll("after").length > 1 || url.searchParams.getAll("limit").length > 1) {
    throw new ObserverHttpError(400, "invalid_query");
  }

  const after = parseBoundedInteger(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 1, MAX_EVENT_LIMIT, DEFAULT_EVENT_LIMIT);
  return { after, limit };
}

function parseBoundedInteger(value: string | null, minimum: number, maximum: number, fallback: number): number {
  if (value === null) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ObserverHttpError(400, "invalid_query");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ObserverHttpError(400, "invalid_query");
  }
  return parsed;
}

function ensureNoQuery(url: URL): void {
  if (url.search.length > 0) throw new ObserverHttpError(400, "invalid_query");
}

function decodeRunId(encoded: string | undefined): string {
  if (encoded === undefined) throw new ObserverHttpError(400, "invalid_run_id");
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new ObserverHttpError(400, "invalid_run_id");
  }
  if (!isSafeRunId(decoded)) throw new ObserverHttpError(400, "invalid_run_id");
  return decoded;
}

function isSafeRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && runId !== "." && runId !== "..";
}

function rejectTraversalTarget(target: string): void {
  const rawPath = target.split(/[?#]/u, 1)[0] ?? "";
  if (rawPath.includes("\\") || rawPath.includes("\0")) {
    throw new ObserverHttpError(400, "invalid_request_target");
  }
  for (const encodedSegment of rawPath.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      throw new ObserverHttpError(400, "invalid_request_target");
    }
    if (segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
      throw new ObserverHttpError(400, "invalid_request_target");
    }
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !pathFromParent.startsWith(sep));
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactEvidence(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactEvidence(entry));
  if (!isJsonObject(value)) return value;

  const redacted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(value).sort(([left], [right]) => compareCodeUnits(left, right));
  for (const [key, entry] of entries) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    redacted[key] = isSensitiveKey(key) ? REDACTED : redactEvidence(entry);
  }
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.includes("password")
    || normalized.includes("passwd")
    || normalized.includes("secret")
    || normalized.includes("credential")
    || normalized === "authorization"
    || normalized === "proxyauthorization"
    || normalized === "cookie"
    || normalized === "setcookie"
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("idtoken")
    || normalized.endsWith("privatekey");
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, "$1[REDACTED]@")
    .replace(
      /(api[_-]?key|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token|authorization)(\s*[=:]\s*)[^\s,;&]+/gi,
      "$1$2[REDACTED]",
    );
}

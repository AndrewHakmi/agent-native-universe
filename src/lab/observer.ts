import { constants } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { lstat, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { compareCodeUnits } from "./canonical.js";
import { MAX_LAB_EVENT_BYTES } from "./events.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_EVENT_LIMIT = 100;
const MAX_EVENT_LIMIT = 1_000;
const MAX_REQUEST_TARGET_BYTES = 4_096;
const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 20_000;
const MAX_RUNS = 1_000;
const MAX_JSON_ARTIFACT_BYTES = 1_048_576;
const MAX_EVENT_SCAN_BYTES = 67_108_864;
const MAX_EVENT_RESPONSE_BYTES = 4_194_304;
const MAX_EVENT_INDEX_RUNS = 64;
const MAX_EVENT_INDEX_ENTRIES = 2_048;
const MAX_EVENT_INDEX_PROBES = 48;
const EVENT_INDEX_SEEK_THRESHOLD_BYTES = 1_048_576;
const EVENT_PROBE_CHUNK_BYTES = 65_536;
const EVENT_INDEX_TAIL_ANCHOR_BYTES = 65_536;
const MIN_AUTH_TOKEN_BYTES = 32;
const MAX_AUTH_TOKEN_BYTES = 4_096;

const RUN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REDACTED = "[REDACTED]";

export interface ObserverServerOptions {
  /** Directory that contains run directories, directly or below experiment directories. */
  dataDir: string;
  /** Used by startObserverServer. Defaults to the loopback interface. */
  host?: string;
  /** Used by startObserverServer. Defaults to 8787; zero requests an ephemeral port. */
  port?: number;
  /** Optional Bearer token. When omitted, evidence routes are unauthenticated and must stay internal. */
  authToken?: string;
}

interface RunRecord {
  directory: string;
  relativeDirectory: string;
  manifest: Record<string, unknown>;
  runId: string;
}

interface RunDiscovery {
  ambiguous: boolean;
  records: RunRecord[];
  truncated: boolean;
}

interface EventFileIdentity {
  ctimeNs: bigint;
  device: bigint;
  inode: bigint;
  mtimeNs: bigint;
  size: bigint;
}

interface EventCheckpoint {
  endOffset: number;
  offset: number;
  seq: number;
}

interface EventIndexEntry {
  checkpoints: EventCheckpoint[];
  headAnchor?: EventContentAnchor;
  identity: EventFileIdentity;
  tailAnchor?: EventContentAnchor;
}

interface EventIndexLease {
  bytesRead: number;
  entry: EventIndexEntry;
}

interface EventContentAnchor {
  digest: string;
  length: number;
  offset: number;
}

interface EventProbe {
  bytesRead: number;
  checkpoint?: EventCheckpoint;
}

interface EventSeek {
  bytesRead: number;
  expectedFirstSeq: number;
  startOffset: number;
}

class EventIndexCache {
  readonly #entries = new Map<string, EventIndexEntry>();

  async acquire(key: string, identity: EventFileIdentity, file: FileHandle): Promise<EventIndexLease> {
    const existing = this.#entries.get(key);
    if (existing !== undefined && sameEventFileIdentity(existing.identity, identity)) {
      this.#touch(key, existing);
      return { bytesRead: 0, entry: existing };
    }
    if (
      existing !== undefined
      && sameEventFileNode(existing.identity, identity)
      && identity.size > existing.identity.size
      && existing.headAnchor !== undefined
      && existing.tailAnchor !== undefined
    ) {
      let headAnchor: EventContentAnchor;
      let tailAnchor: EventContentAnchor;
      try {
        headAnchor = await readEventContentAnchor(
          file,
          existing.headAnchor.offset,
          existing.headAnchor.length,
        );
        tailAnchor = existing.tailAnchor.offset === existing.headAnchor.offset
          && existing.tailAnchor.length === existing.headAnchor.length
          ? headAnchor
          : await readEventContentAnchor(
            file,
            existing.tailAnchor.offset,
            existing.tailAnchor.length,
          );
      } catch (error) {
        if (this.#entries.get(key) === existing) this.#entries.delete(key);
        throw error;
      }
      const bytesRead = headAnchor.length + (tailAnchor === headAnchor ? 0 : tailAnchor.length);
      if (
        headAnchor.digest === existing.headAnchor.digest
        && tailAnchor.digest === existing.tailAnchor.digest
      ) {
        existing.identity = identity;
        this.#touch(key, existing);
        return { bytesRead, entry: existing };
      }
      if (this.#entries.get(key) === existing) this.#entries.delete(key);
      return { bytesRead, entry: this.#create(key, identity) };
    }
    if (existing !== undefined) this.#entries.delete(key);
    return { bytesRead: 0, entry: this.#create(key, identity) };
  }

  invalidate(key: string, expected?: EventIndexEntry): void {
    if (expected === undefined || this.#entries.get(key) === expected) this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  async retainStable(
    key: string,
    expected: EventIndexEntry,
    identity: EventFileIdentity,
    file: FileHandle,
  ): Promise<void> {
    if (this.#entries.get(key) !== expected) return;
    const anchorLength = Math.min(EVENT_INDEX_TAIL_ANCHOR_BYTES, Number(identity.size));
    const anchorOffset = Number(identity.size) - anchorLength;
    expected.headAnchor = await readEventContentAnchor(file, 0, anchorLength);
    expected.tailAnchor = anchorOffset === 0
      ? expected.headAnchor
      : await readEventContentAnchor(file, anchorOffset, anchorLength);
    expected.identity = identity;
    this.#touch(key, expected);
  }

  #create(key: string, identity: EventFileIdentity): EventIndexEntry {
    const created: EventIndexEntry = { checkpoints: [], identity };
    this.#entries.set(key, created);
    while (this.#entries.size > MAX_EVENT_INDEX_RUNS) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return created;
  }

  #touch(key: string, entry: EventIndexEntry): void {
    this.#entries.delete(key);
    this.#entries.set(key, entry);
  }
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
  const authHeaderDigest = createAuthHeaderDigest(options.authToken);
  const eventIndexes = new EventIndexCache();
  const server = createServer(
    {
      maxHeaderSize: 16_384,
      requireHostHeader: true,
    },
    (request, response) => {
      void handleRequest(configuredDataDir, authHeaderDigest, eventIndexes, request, response).catch((error: unknown) => {
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
    void handleRequest(configuredDataDir, authHeaderDigest, eventIndexes, request, response).catch((error: unknown) => {
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
  server.on("close", () => {
    eventIndexes.clear();
    authHeaderDigest?.fill(0);
  });
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
  authHeaderDigest: Buffer | undefined,
  eventIndexes: EventIndexCache,
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
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    ensureNoQuery(url);
    const root = await resolveDataRootOr503(configuredDataDir);
    const discovery = await discoverRuns(root);
    assertCompleteRunDiscovery(discovery);
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
      truncated: false,
    });
    return;
  }

  const eventsMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
  if (eventsMatch !== null) {
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
    const runId = decodeRunId(eventsMatch[1]);
    const { after, limit } = parseEventQuery(url);
    const root = await resolveDataRootOr503(configuredDataDir);
    const record = await findRun(root, runId);
    if (record === undefined) throw new ObserverHttpError(404, "run_not_found");
    const page = await readEventPage(record, root, eventIndexes, after, limit);
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
    if (!authorizeEvidenceRequest(request, response, authHeaderDigest)) return;
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

function createAuthHeaderDigest(token: string | undefined): Buffer | undefined {
  if (token === undefined) return undefined;
  const tokenBytes = Buffer.byteLength(token, "utf8");
  if (
    tokenBytes < MIN_AUTH_TOKEN_BYTES
    || tokenBytes > MAX_AUTH_TOKEN_BYTES
    || !/^[A-Za-z0-9\-._~+/]+=*$/.test(token)
  ) {
    throw new TypeError(
      `Observer auth token must be ${MIN_AUTH_TOKEN_BYTES}..${MAX_AUTH_TOKEN_BYTES} bytes of token68 data`,
    );
  }
  return createHash("sha256").update(`Bearer ${token}`, "utf8").digest();
}

function authorizeEvidenceRequest(
  request: IncomingMessage,
  response: ServerResponse,
  expectedDigest: Buffer | undefined,
): boolean {
  if (expectedDigest === undefined) return true;

  const authorizationValues = request.headersDistinct.authorization;
  const candidate = authorizationValues?.length === 1 ? authorizationValues[0] ?? "" : "";
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const authorized = authorizationValues?.length === 1
    && timingSafeEqual(candidateDigest, expectedDigest);
  candidateDigest.fill(0);
  if (authorized) return true;

  response.setHeader("WWW-Authenticate", 'Bearer realm="anu-lab-observer"');
  sendJson(response, 401, { error: "unauthorized" });
  return false;
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
      truncated = true;
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
      if (found.length > MAX_RUNS) {
        truncated = true;
        break;
      }
    }

    if (current.depth >= MAX_SCAN_DEPTH || entriesSeen >= MAX_SCAN_ENTRIES) {
      if (current.depth >= MAX_SCAN_DEPTH && entries.some((entry) => entry.isDirectory())) truncated = true;
      if (entriesSeen >= MAX_SCAN_ENTRIES && entries.some((entry) => entry.isDirectory())) {
        truncated = true;
      }
      continue;
    }

    for (const entry of entries) {
      if (
        !entry.isDirectory()
        || entry.isSymbolicLink()
        || entry.name.startsWith(".")
        || entry.name === "populations"
        || (manifestEntry !== undefined && entry.name === "checkpoints")
      ) continue;
      const child = join(current.directory, entry.name);
      let canonicalChild: string;
      try {
        canonicalChild = await realpath(child);
      } catch {
        truncated = true;
        continue;
      }
      if (!isWithin(root, canonicalChild)) {
        truncated = true;
        continue;
      }
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

  const occurrences = new Map<string, number>();
  for (const record of found) {
    occurrences.set(record.runId, (occurrences.get(record.runId) ?? 0) + 1);
  }
  const unique = found.filter((record) => occurrences.get(record.runId) === 1);
  return { ambiguous: unique.length !== found.length, records: unique, truncated };
}

async function findRun(root: string, runId: string): Promise<RunRecord | undefined> {
  const discovery = await discoverRuns(root);
  assertCompleteRunDiscovery(discovery);
  return discovery.records.find((record) => record.runId === runId);
}

function assertCompleteRunDiscovery(discovery: RunDiscovery): void {
  if (discovery.truncated) {
    throw new ObserverHttpError(503, "run_discovery_incomplete");
  }
  if (discovery.ambiguous) {
    throw new ObserverHttpError(409, "ambiguous_run_evidence");
  }
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
    const content = buffer.subarray(0, offset);
    if (!isUtf8(content)) throw new ObserverHttpError(422, "invalid_artifact");
    return content.toString("utf8");
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
  eventIndexes: EventIndexCache,
  after: number,
  limit: number,
): Promise<{ events: Record<string, unknown>[]; nextAfter: number; hasMore: boolean }> {
  const indexKey = join(record.directory, "events.jsonl");
  let file;
  try {
    file = await openSafeArtifact(record.directory, "events.jsonl", root);
  } catch (error) {
    if (isMissingFile(error)) {
      eventIndexes.invalidate(indexKey);
      return { events: [], nextAfter: after, hasMore: false };
    }
    throw error;
  }

  let index: EventIndexEntry | undefined;
  let initialIdentity: EventFileIdentity | undefined;
  const selected: Record<string, unknown>[] = [];
  let selectedBytes = 0;
  let hasMore = false;
  let scannedBytes: number;
  let pending: Buffer = Buffer.alloc(0);
  let pendingOffset: number;
  let expectedSeq: number;

  const consumeLine = (rawLine: Buffer, offset: number, endOffset: number): boolean => {
    if (!isUtf8(rawLine) || rawLine.at(-1) === 0x0d) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const line = rawLine.toString("utf8");
    if (line.length === 0) throw new ObserverHttpError(422, "invalid_event_log");
    if (Buffer.byteLength(line, "utf8") > MAX_LAB_EVENT_BYTES) {
      throw new ObserverHttpError(413, "event_line_too_large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    if (
      !isJsonObject(parsed)
      || !Number.isSafeInteger(parsed.seq)
      || (parsed.seq as number) !== expectedSeq
    ) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const seq = parsed.seq as number;
    expectedSeq = seq + 1;
    if (index === undefined) throw new ObserverHttpError(500, "internal_error");
    rememberEventCheckpoint(index, { endOffset, offset, seq });
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
    initialIdentity = await eventFileIdentity(file);
    const fileSize = Number(initialIdentity.size);
    const terminatorBytes = await validateEventLogTerminator(file, fileSize);
    const lease = await eventIndexes.acquire(indexKey, initialIdentity, file);
    index = lease.entry;
    const seek = await findEventScanStart(file, fileSize, after, index);
    scannedBytes = terminatorBytes + lease.bytesRead + seek.bytesRead;
    if (scannedBytes > MAX_EVENT_SCAN_BYTES) {
      throw new ObserverHttpError(413, "event_scan_limit_exceeded");
    }
    pendingOffset = seek.startOffset;
    expectedSeq = seek.expectedFirstSeq;

    let readOffset = seek.startOffset;
    while (readOffset < fileSize && !hasMore) {
      const chunk = await readFileWindow(
        file,
        readOffset,
        Math.min(EVENT_PROBE_CHUNK_BYTES, fileSize - readOffset),
      );
      if (chunk.length === 0) break;
      readOffset += chunk.length;
      scannedBytes += chunk.length;
      if (scannedBytes > MAX_EVENT_SCAN_BYTES) {
        throw new ObserverHttpError(413, "event_scan_limit_exceeded");
      }
      pending = Buffer.concat([pending, chunk], pending.length + chunk.length);

      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        const lineOffset = pendingOffset;
        const lineEndOffset = lineOffset + newline + 1;
        pending = pending.subarray(newline + 1);
        pendingOffset = lineEndOffset;
        if (consumeLine(line, lineOffset, lineEndOffset)) break;
        newline = pending.indexOf(0x0a);
      }
      if (hasMore) break;
      if (pending.length > MAX_LAB_EVENT_BYTES + 1) {
        throw new ObserverHttpError(413, "event_line_too_large");
      }
    }
    if (!hasMore && pending.length > 0) throw new ObserverHttpError(422, "invalid_event_log");

    const finalIdentity = await eventFileIdentity(file);
    if (!sameEventFileIdentity(initialIdentity, finalIdentity)) {
      eventIndexes.invalidate(indexKey, index);
    } else {
      await eventIndexes.retainStable(indexKey, index, finalIdentity, file);
    }
  } catch (error) {
    eventIndexes.invalidate(indexKey, index);
    throw error;
  } finally {
    await file.close();
  }

  return {
    events: selected,
    nextAfter: selected.length === 0 ? after : (selected.at(-1)?.seq as number),
    hasMore,
  };
}

async function eventFileIdentity(file: FileHandle): Promise<EventFileIdentity> {
  const info = await file.stat({ bigint: true });
  if (!info.isFile()) throw new ObserverHttpError(422, "invalid_event_log");
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ObserverHttpError(413, "event_scan_limit_exceeded");
  }
  return {
    ctimeNs: info.ctimeNs,
    device: info.dev,
    inode: info.ino,
    mtimeNs: info.mtimeNs,
    size: info.size,
  };
}

async function validateEventLogTerminator(file: FileHandle, fileSize: number): Promise<number> {
  if (fileSize === 0) return 0;
  const terminator = await readFileWindow(file, fileSize - 1, 1);
  if (terminator.length !== 1 || terminator[0] !== 0x0a) {
    throw new ObserverHttpError(422, "invalid_event_log");
  }
  return 1;
}

async function readEventContentAnchor(
  file: FileHandle,
  offset: number,
  length: number,
): Promise<EventContentAnchor> {
  const content = await readFileWindow(file, offset, length);
  if (content.length !== length) throw new ObserverHttpError(422, "invalid_event_log");
  return {
    digest: createHash("sha256").update(content).digest("hex"),
    length,
    offset,
  };
}

function sameEventFileIdentity(left: EventFileIdentity, right: EventFileIdentity): boolean {
  return left.ctimeNs === right.ctimeNs
    && left.device === right.device
    && left.inode === right.inode
    && left.mtimeNs === right.mtimeNs
    && left.size === right.size;
}

function sameEventFileNode(left: EventFileIdentity, right: EventFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function rememberEventCheckpoint(index: EventIndexEntry, checkpoint: EventCheckpoint): void {
  let low = 0;
  let high = index.checkpoints.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const existing = index.checkpoints[middle];
    if (existing === undefined || existing.offset < checkpoint.offset) low = middle + 1;
    else high = middle;
  }

  const sameOffset = index.checkpoints[low];
  if (sameOffset?.offset === checkpoint.offset) {
    if (sameOffset.endOffset !== checkpoint.endOffset || sameOffset.seq !== checkpoint.seq) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    return;
  }

  const previous = index.checkpoints[low - 1];
  const next = index.checkpoints[low];
  if (
    checkpoint.offset < 0
    || checkpoint.endOffset <= checkpoint.offset
    || (previous !== undefined && (previous.endOffset > checkpoint.offset || previous.seq >= checkpoint.seq))
    || (next !== undefined && (checkpoint.endOffset > next.offset || checkpoint.seq >= next.seq))
  ) {
    throw new ObserverHttpError(422, "invalid_event_log");
  }

  index.checkpoints.splice(low, 0, checkpoint);
  if (index.checkpoints.length <= MAX_EVENT_INDEX_ENTRIES) return;

  const checkpoints = index.checkpoints;
  const compacted: EventCheckpoint[] = [];
  for (let position = 0; position < MAX_EVENT_INDEX_ENTRIES; position += 1) {
    const source = Math.floor((position * (checkpoints.length - 1)) / (MAX_EVENT_INDEX_ENTRIES - 1));
    const retained = checkpoints[source];
    if (retained !== undefined) compacted.push(retained);
  }
  index.checkpoints = compacted;
}

async function findEventScanStart(
  file: FileHandle,
  fileSize: number,
  after: number,
  index: EventIndexEntry,
): Promise<EventSeek> {
  if (after === 0 || fileSize === 0) {
    return { bytesRead: 0, expectedFirstSeq: 1, startOffset: 0 };
  }

  let floor: EventCheckpoint | undefined;
  let ceiling: EventCheckpoint | undefined;
  for (const checkpoint of index.checkpoints) {
    if (checkpoint.seq <= after) floor = checkpoint;
    else {
      ceiling = checkpoint;
      break;
    }
  }

  let lowOffset = floor?.endOffset ?? 0;
  let highOffset = ceiling?.offset ?? fileSize;
  if (floor === undefined && highOffset <= EVENT_INDEX_SEEK_THRESHOLD_BYTES) {
    return { bytesRead: 0, expectedFirstSeq: 1, startOffset: 0 };
  }

  let bytesRead = 0;
  for (
    let probeCount = 0;
    probeCount < MAX_EVENT_INDEX_PROBES
      && highOffset - lowOffset > EVENT_INDEX_SEEK_THRESHOLD_BYTES;
    probeCount += 1
  ) {
    const targetOffset = lowOffset + Math.floor((highOffset - lowOffset) / 2);
    const probe = await probeEventCheckpoint(file, targetOffset, fileSize);
    bytesRead += probe.bytesRead;
    if (bytesRead > MAX_EVENT_SCAN_BYTES) {
      throw new ObserverHttpError(413, "event_scan_limit_exceeded");
    }

    const checkpoint = probe.checkpoint;
    if (checkpoint === undefined) {
      highOffset = targetOffset;
      continue;
    }
    rememberEventCheckpoint(index, checkpoint);

    if (checkpoint.seq <= after) {
      if (floor === undefined || checkpoint.seq > floor.seq) floor = checkpoint;
      lowOffset = Math.max(lowOffset + 1, checkpoint.endOffset);
    } else {
      ceiling = checkpoint;
      highOffset = checkpoint.offset <= lowOffset ? lowOffset : checkpoint.offset;
    }
  }

  return {
    bytesRead,
    expectedFirstSeq: floor?.seq ?? 1,
    startOffset: floor?.offset ?? 0,
  };
}

async function probeEventCheckpoint(
  file: FileHandle,
  targetOffset: number,
  fileSize: number,
): Promise<EventProbe> {
  if (fileSize === 0 || targetOffset >= fileSize) return { bytesRead: 0 };

  let bytesRead = 0;
  let lineStart = 0;
  let cursor = targetOffset;
  let searchedBackward = 0;
  while (cursor > 0) {
    const remainingAllowance = MAX_LAB_EVENT_BYTES + 2 - searchedBackward;
    if (remainingAllowance <= 0) throw new ObserverHttpError(413, "event_line_too_large");
    const length = Math.min(EVENT_PROBE_CHUNK_BYTES, cursor, remainingAllowance);
    const position = cursor - length;
    const chunk = await readFileWindow(file, position, length);
    bytesRead += chunk.length;
    const newline = chunk.lastIndexOf(0x0a);
    if (newline >= 0) {
      lineStart = position + newline + 1;
      break;
    }
    searchedBackward += chunk.length;
    cursor = position;
    if (chunk.length < length) throw new ObserverHttpError(422, "invalid_event_log");
  }

  let nextLineStart = lineStart;
  while (nextLineStart < fileSize) {
    const length = Math.min(MAX_LAB_EVENT_BYTES + 3, fileSize - nextLineStart);
    const chunk = await readFileWindow(file, nextLineStart, length);
    bytesRead += chunk.length;
    if (bytesRead > MAX_EVENT_SCAN_BYTES) {
      throw new ObserverHttpError(413, "event_scan_limit_exceeded");
    }

    const newline = chunk.indexOf(0x0a);
    const rawLength = newline >= 0 ? newline : chunk.length;
    if (newline < 0 && nextLineStart + chunk.length < fileSize) {
      throw new ObserverHttpError(413, "event_line_too_large");
    }
    const raw = chunk.subarray(0, rawLength);
    if (!isUtf8(raw) || raw.at(-1) === 0x0d) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    const line = raw.toString("utf8");
    if (Buffer.byteLength(line, "utf8") > MAX_LAB_EVENT_BYTES) {
      throw new ObserverHttpError(413, "event_line_too_large");
    }
    const endOffset = nextLineStart + rawLength + (newline >= 0 ? 1 : 0);
    if (line.length === 0) throw new ObserverHttpError(422, "invalid_event_log");

    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    if (!isJsonObject(parsed) || !Number.isSafeInteger(parsed.seq) || (parsed.seq as number) <= 0) {
      throw new ObserverHttpError(422, "invalid_event_log");
    }
    return {
      bytesRead,
      checkpoint: {
        endOffset,
        offset: nextLineStart,
        seq: parsed.seq as number,
      },
    };
  }
  return { bytesRead };
}

async function readFileWindow(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await file.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  return buffer.subarray(0, offset);
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
    || normalized.endsWith("token")
    || normalized.endsWith("jwt")
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesstoken")
    || normalized.endsWith("refreshtoken")
    || normalized.endsWith("idtoken")
    || normalized.endsWith("privatekey");
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /(^|[^a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi,
      "$1$2[REDACTED]@",
    )
    .replace(
      /(api[_-]?key|client[_-]?secret|password|passwd|(?:access|refresh|session|auth|csrf|bearer|api)?[_-]?token|jwt|authorization)(\s*[=:]\s*)[^\s,;&]+/gi,
      "$1$2[REDACTED]",
    );
}

import { constants } from "node:fs";
import { isUtf8 } from "node:buffer";
import {
  mkdir,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, parse, relative, resolve, sep } from "node:path";
import { canonicalJson } from "./canonical.js";
import {
  EventChainError,
  initialEventChainVerification,
  MAX_LAB_EVENT_BYTES,
  validateLabEvent,
  verifyNextEvent,
  type EventChainVerification,
} from "./events.js";
import type { LabEvent, RunManifest } from "./types.js";

const PROC_SELF_FD = "/proc/self/fd";

export interface AnchoredDirectoryOptions {
  /** Create missing directory components with the supplied mode. */
  create?: boolean;
  mode?: number;
}

/**
 * A directory kept alive by an open Linux file descriptor.
 *
 * Every child path is resolved by the kernel relative to that descriptor, so
 * renaming the directory and replacing its old pathname with a symlink cannot
 * redirect an in-flight evidence operation.
 */
export interface AnchoredDirectory {
  readonly displayPath: string;
  readonly path: string;
  entry(name: string): string;
  openRegular(name: string, flags: number, mode?: number): Promise<FileHandle>;
}

/**
 * Iterate a canonical event JSONL file without materializing it in memory.
 * A final newline remains mandatory so interrupted appends fail closed.
 */
export async function* iterateEventFile(path: string): AsyncGenerator<LabEvent> {
  const handle = await openRegularFileNoFollow(path, constants.O_RDONLY);
  let pending = Buffer.alloc(0);
  let lineNumber = 0;
  try {
    const stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: 65_536,
    });
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = pending.length === 0 ? bytes : Buffer.concat([pending, bytes]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        const lineBytes = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        lineNumber += 1;
        if (lineBytes.length === 0) {
          throw new EventChainError(`Event log contains a blank line at ${lineNumber}`);
        }
        if (lineBytes.length > MAX_LAB_EVENT_BYTES) {
          throw new EventChainError(`Event log line ${lineNumber} exceeds the streaming safety limit`);
        }
        if (!isUtf8(lineBytes)) {
          throw new EventChainError(`Event log line ${lineNumber} is not valid UTF-8`);
        }
        const line = lineBytes.toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch (error) {
          throw new EventChainError(`Invalid JSON at event log line ${lineNumber}: ${errorMessage(error)}`);
        }
        validateLabEvent(parsed);
        if (canonicalJson(parsed) !== line) {
          throw new EventChainError(`Event log line ${lineNumber} is not canonical JSON`);
        }
        yield parsed;
        newline = pending.indexOf(0x0a);
      }
      if (pending.length > MAX_LAB_EVENT_BYTES) {
        throw new EventChainError(`Event log line ${lineNumber + 1} exceeds the streaming safety limit`);
      }
    }
    if (pending.length > 0) {
      throw new EventChainError("Event log is truncated: final JSONL newline is missing");
    }
  } finally {
    await handle.close();
  }
}

/**
 * Create and validate every directory component without accepting symbolic
 * links. This intentionally walks from the filesystem root: accepting a
 * symlink above the evidence root would defeat final-component O_NOFOLLOW.
 */
export async function ensureNoSymlinkDirectoryHierarchy(path: string): Promise<void> {
  await withAnchoredDirectory(path, { create: true }, async () => undefined);
}

/**
 * Run an operation while holding an fd-anchored directory hierarchy.
 *
 * Linux `/proc/self/fd/<fd>/child` gives Node an openat-like primitive. Each
 * real component is opened separately with O_DIRECTORY|O_NOFOLLOW and its
 * parent descriptor stays open until the child descriptor has been acquired.
 * This closes the parent-directory symlink TOCTOU left by pathname prechecks.
 */
export async function withAnchoredDirectory<T>(
  path: string,
  options: AnchoredDirectoryOptions,
  operation: (directory: AnchoredDirectory) => Promise<T>,
): Promise<T> {
  const handle = await openDirectoryHierarchy(path, options);
  const directory = anchoredDirectory(resolve(path), handle);
  try {
    return await operation(directory);
  } finally {
    await handle.close();
  }
}

/** Hold a file's parent fd for the complete operation. */
export async function withAnchoredParentDirectory<T>(
  path: string,
  options: AnchoredDirectoryOptions,
  operation: (directory: AnchoredDirectory, name: string) => Promise<T>,
): Promise<T> {
  const absolute = resolve(path);
  const name = basename(absolute);
  assertSinglePathComponent(name);
  return withAnchoredDirectory(dirname(absolute), options, (directory) => (
    operation(directory, name)
  ));
}

/** Open a regular file while refusing to dereference a final-component link. */
export async function openRegularFileNoFollow(
  path: string,
  flags: number,
  mode = 0o600,
): Promise<FileHandle> {
  return withAnchoredParentDirectory(path, {}, (directory, name) => (
    directory.openRegular(name, flags, mode)
  ));
}

/** Remove one final entry without ever resolving a replaced parent pathname. */
export async function unlinkEntryNoFollow(path: string): Promise<void> {
  await withAnchoredParentDirectory(path, {}, async (directory, name) => {
    await unlink(directory.entry(name));
  });
}

async function openDirectoryHierarchy(
  path: string,
  options: AnchoredDirectoryOptions,
): Promise<FileHandle> {
  if (process.platform !== "linux") {
    throw new Error("Secure evidence directory traversal requires Linux /proc/self/fd");
  }
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const components = relative(root, absolute).split(sep).filter(Boolean);
  let current = await openDirectoryComponent(root, root);
  let displayPath = root;
  try {
    for (const component of components) {
      assertSinglePathComponent(component);
      const childPath = procEntryPath(current, component);
      displayPath = resolve(displayPath, component);
      if (options.create === true) {
        try {
          await mkdir(childPath, { mode: options.mode ?? 0o700 });
        } catch (error) {
          if (!hasCode(error, "EEXIST")) throw error;
        }
      }
      const child = await openDirectoryComponent(childPath, displayPath);
      await current.close();
      current = child;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

async function openDirectoryComponent(path: string, displayPath: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (hasCode(error, "ELOOP") || hasCode(error, "ENOTDIR")) {
      throw new Error(
        `Refusing symbolic link directory ${displayPath} or non-directory evidence path component`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new Error(`Evidence path component is not a directory: ${displayPath}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function anchoredDirectory(displayPath: string, handle: FileHandle): AnchoredDirectory {
  return {
    displayPath,
    path: procFdPath(handle),
    entry(name: string): string {
      assertSinglePathComponent(name);
      return procEntryPath(handle, name);
    },
    async openRegular(name: string, flags: number, mode = 0o600): Promise<FileHandle> {
      assertSinglePathComponent(name);
      return openRegularAtPath(procEntryPath(handle, name), flags, mode, resolve(displayPath, name));
    },
  };
}

async function openRegularAtPath(
  path: string,
  flags: number,
  mode: number,
  displayPath: string,
): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(path, flags | constants.O_NOFOLLOW, mode);
  } catch (error) {
    if (hasCode(error, "ELOOP")) {
      throw new Error(`Refusing symbolic link file ${displayPath}`, { cause: error });
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new Error(`Evidence artifact is not a regular file: ${displayPath}`);
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function procFdPath(handle: FileHandle): string {
  return `${PROC_SELF_FD}/${handle.fd}`;
}

function procEntryPath(handle: FileHandle, name: string): string {
  return `${procFdPath(handle)}/${name}`;
}

function assertSinglePathComponent(name: string): void {
  if (name.length === 0 || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new TypeError("Anchored evidence entry must be one safe path component");
  }
}

/** Scan and verify a hash chain while retaining only its rolling cursor. */
export async function scanEventFile(
  path: string,
  manifest: RunManifest,
  onEvent?: (event: LabEvent) => void | Promise<void>,
): Promise<EventChainVerification> {
  let verification = initialEventChainVerification(manifest);
  for await (const event of iterateEventFile(path)) {
    verification = verifyNextEvent(event, manifest, verification);
    await onEvent?.(event);
  }
  return verification;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

/**
 * Simple logger utility with different log levels
 */
import fs from "fs";
import path from "path";
import { statAsync } from "./io";
import { ensureSecureLogsDirSync } from "./tempDir";
import { pruneLogFiles, type DaemonPidFileEnumeration } from "./logPruner";
import {
  resolveAutomobileLogFormat,
  resolveAutomobileLogSink,
  writeEmergencyLog,
} from "./loggingConfig";
import { Timer, defaultTimer } from "./SystemTimer";
import { toActionableError } from "../models/ActionableError";

export {
  parseAutomobileLogFormat,
  parseAutomobileLogSink,
  resolveAutomobileLogFormat,
  resolveAutomobileLogSink,
  type LogFormat,
  type LogSink,
} from "./loggingConfig";

/**
 * Interface for logger functionality
 */
export interface Logger {
  /**
   * Logs a debug message
   */
  debug(message: string, ...args: any[]): void;

  /**
   * Logs an info message
   */
  info(message: string, ...args: any[]): void;

  /**
   * Logs a warning message
   */
  warn(message: string, ...args: any[]): void;

  /**
   * Logs an error message
   */
  error(message: string, ...args: any[]): void;

  /**
   * Sets the current log level
   */
  setLogLevel(level: LogLevel): void;

  /**
   * Gets the current log level
   */
  getLogLevel(): LogLevel;

  /**
   * Enables logging to STDOUT in addition to log files
   */
  enableStdoutLogging(): void;

  /**
   * Disables logging to STDOUT
   */
  disableStdoutLogging(): void;

  /**
   * Awaits any in-flight fire-and-forget log writes so callers (chiefly tests)
   * can deterministically observe a just-emitted line at the sink instead of
   * racing the async write with a real-timer poll. Resolves once the most
   * recent write settled; never rejects (write failures are already swallowed).
   */
  flush(): Promise<void>;

  /**
   * Flushes queued writes and closes the log stream.
   */
  close(): void;

  /**
   * Flushes pending writes and waits until the log stream finishes closing.
   * Use this before an explicit process exit so the final log entries reach
   * the stream.
   */
  closeAfterFlush(): Promise<void>;
}

export const LogLevel = {
  DEBUG: 0 as const,
  INFO: 1 as const,
  WARN: 2 as const,
  ERROR: 3 as const,
  NONE: 4 as const,
};

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export function isStructuredLoggingEnabled(): boolean {
  return logFormat === "json";
}

/**
 * Parse `AUTOMOBILE_LOG_LEVEL` values: debug, info, warn|warning, error, none|silent.
 * Returns null if unset, blank, or unrecognized (caller keeps current level).
 */
export function parseAutomobileLogLevel(value: string | undefined): LogLevel | null {
  if (value === undefined) {
    return null;
  }
  const v = value.trim().toLowerCase();
  if (v.length === 0) {
    return null;
  }
  switch (v) {
    case "debug":
      return LogLevel.DEBUG;
    case "info":
      return LogLevel.INFO;
    case "warn":
    case "warning":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    case "none":
    case "silent":
      return LogLevel.NONE;
    default:
      return null;
  }
}

export function resolveProcessLogPrefix(argv: readonly string[], pid: number): string {
  return argv.includes("--daemon-mode") ? "daemon" : `stdio-${pid}`;
}

// Seed the level from AUTOMOBILE_LOG_LEVEL at process start (issue #3845) so a
// user who exports the env var actually changes what the running process emits,
// rather than silently staying at INFO. Applied here at module load — the single
// point every process (daemon, stdio client, direct mode) passes through, and a
// DaemonManager-spawned daemon inherits the var via its `{ ...process.env }`
// child env. Falls back to INFO when unset/unrecognized; still overridable at
// runtime via setLogLevel.
let currentLogLevel: LogLevel =
  parseAutomobileLogLevel(process.env.AUTOMOBILE_LOG_LEVEL ?? process.env.AUTO_MOBILE_LOG_LEVEL) ??
  LogLevel.INFO;

const logFormat = resolveAutomobileLogFormat();
const logSink = resolveAutomobileLogSink();

// Flag to control whether to also log to STDOUT (in addition to files)
let logToStdout = false;

// Tracks the most recent in-flight write so `flush()` can await it. Writes are
// fire-and-forget for latency, but tests need a deterministic barrier to observe
// a just-emitted line at the sink without racing a real-timer poll. Each level
// method appends its write to this chain; `flush()` awaits the tail. The chain
// never rejects (write errors are swallowed inside writeToLogFile).
let lastWrite: Promise<void> = Promise.resolve();
const trackWrite = (write: Promise<void>): void => {
  lastWrite = lastWrite.then(() => write);
};

// Create the configured log directory only when the selected sink writes files.
// Stderr-only containers must not require a writable application-data volume.
const logsDir = logSink === "stderr" ? undefined : ensureSecureLogsDirSync();

// The daemon is single-owner, so keep its stable log name easy to document and
// tail. Stdio/client processes remain PID-scoped because several can run in
// parallel on the same host.
const ownLogPrefix = resolveProcessLogPrefix(process.argv, process.pid);
const logFilePath = logsDir ? path.join(logsDir, `${ownLogPrefix}.log`) : undefined;

interface FailureProneStream {
  on(event: "error", listener: (error: Error) => void): void;
}

// A stream that opened successfully can still fail later — e.g. EACCES/ENOSPC
// surfacing asynchronously once bun/node actually touches the fd. An 'error'
// event with no listener throws and crashes the process, the exact failure
// mode #6111/#6179 exists to prevent (just reached via the async path instead
// of the synchronous constructor throw). Attach a handler so that instead: (a)
// the error never goes unhandled, (b) the broken stream is dropped so the next
// write retries opening it (or degrades to stderr, same as the sync path), and
// (c) the diagnostic stays valid NDJSON in json mode (issue #6179).
//
// Deliberately NOT listening for 'close': checkAndRotateLog() ends the active
// stream on purpose at the size cap, awaits that close (see closeLogStream /
// closeStreamBeforeRotation, issue #6149), and only then opens its
// replacement — a normal, expected close with no error. Clearing `logStream`
// on every close (regardless of cause) raced that legitimate rotation and
// could drop the freshly-opened replacement stream right after rotating,
// breaking logging for the rest of the process. An unexpected close without a
// preceding 'error' is rare enough (and self-healing via the next write's
// lazy retry once a subsequent write actually fails) that it doesn't need a
// handler here.
const attachStreamFailureHandlers = (stream: FailureProneStream, target: string): void => {
  stream.on("error", (error) => {
    try {
      writeEmergencyLog(`Log stream error on ${target}`, error);
    } catch (loggingError) {
      // The emergency helper itself must never throw back into the stream's
      // event emitter — that would just relocate the crash.
      void loggingError;
    }
    if (logStream === stream) {
      logStream = undefined;
    }
  });
};

// Constructing an appending WriteStream can throw synchronously — e.g. bun's
// internal fast path occasionally races its epoll registration and throws
// `EEXIST: ... epoll_ctl` (issue #5930 family). At module load this crashes the
// importing process ("Unhandled error between tests" in the host-integration
// lane). File logging is best-effort, so swallow the construction failure and
// fall back to console-only logging rather than taking the process down.
const openLogStream = (target: string): fs.WriteStream | undefined => {
  try {
    const stream = fs.createWriteStream(target, { flags: "a" });
    attachStreamFailureHandlers(stream, target);
    return stream;
  } catch (error) {
    // Logger init is the thing failing, so it cannot log itself — route the
    // diagnostic through the JSON-aware emergency helper so this line stays
    // valid NDJSON in `AUTOMOBILE_LOG_FORMAT=json` mode instead of a raw-text
    // line breaking an otherwise-NDJSON stderr stream (issue #6179).
    writeEmergencyLog(`Failed to open log stream ${target}`, error);
    return undefined;
  }
};

let logStream = logFilePath ? openLogStream(logFilePath) : undefined;

function fileLogPaths(): { dir: string; path: string } | undefined {
  if (!logsDir || !logFilePath) {
    return undefined;
  }
  return { dir: logsDir, path: logFilePath };
}

interface EndableLogStream {
  end(callback?: () => void): void;
  once(event: "error" | "close", listener: (...args: any[]) => void): void;
  off(event: "error" | "close", listener: (...args: any[]) => void): void;
  // Node/Bun WriteStreams expose this once the fd has actually been released.
  // Optional so plain EventEmitter fakes that never set it still type-check.
  readonly closed?: boolean;
  // Node/Bun WriteStreams (via Writable) expose this. Called only on the
  // error-without-close path below, to nudge a stalled fd toward release
  // rather than passively waiting on a `close` that may never come. Optional
  // so plain EventEmitter fakes that never implement it still type-check.
  destroy?(error?: Error): void;
}

// Bounds how long closeLogStream() waits for the confirming `close` once an
// `error` has been observed during shutdown. `error` does not guarantee the
// fd was released (see the doc above closeLogStream) -- explicitly destroying
// the stream nudges a stalled descriptor toward release, but a supported
// runtime that changes this ordering (or a genuinely wedged descriptor) must
// not hang the caller -- and therefore log rotation / process shutdown --
// forever (issue #6700). Chosen generously: rotation and shutdown are not
// latency-sensitive, so this only ever matters on the already-broken path.
export const CLOSE_LOG_STREAM_TIMEOUT_MS = 5_000;

/**
 * Resolves once a log stream has ACTUALLY closed (its file descriptor
 * released), or rejects if closing it failed.
 *
 * `WriteStream.end(callback)` fires its callback on writable completion — the
 * same moment as the `finish` event — but the underlying fd is only released
 * later, on the `close` event. On Bun (and Node) the observed order is: end
 * callback, then `finish`, then `close`. Reopening the same path on the earlier
 * `finish` signal therefore still races bun's epoll registration for the not-
 * yet-released fd and can throw `EEXIST: ... epoll_ctl` on the replacement
 * stream's construction — the exact race rotation exists to avoid (issue
 * #6149). So we drive `end()` to start the shutdown but wait for `close`.
 *
 * Two more orderings, both confirmed on Node 24 and Bun 1.2.14:
 *  - An `error` during shutdown (e.g. a failing fd, `/dev/full`) does NOT mean
 *    the fd was released — `close` still follows. Settling on `error` alone
 *    let the caller rename/reopen the path while the old descriptor was still
 *    live, recreating the exact race this function exists to avoid. The error
 *    is recorded and still surfaced (so the failure is not silently lost) but
 *    only once the confirming `close` actually arrives.
 *  - A stream whose fd was already released before this call (e.g. a repeated
 *    `logger.close()` / `closeAfterFlush()`) never emits a second `close` —
 *    Node/Bun only fire it once per stream — so waiting for a listener would
 *    hang forever. Check `closed` up front and resolve immediately.
 *
 * Bounded close policy (issue #6700): the ordering above is the observed
 * contract on the runtimes this was verified against, not a guarantee the
 * platform makes. If a supported runtime (or an already-broken stream) emits
 * `error` and then never emits `close`, this must not hang the caller
 * forever. So once an `error` is observed, this (a) explicitly `destroy()`s
 * the stream if it exposes that method, nudging a stalled fd toward release,
 * and (b) starts a bounded timer. The `close` listener stays authoritative —
 * a `close` that arrives before the bound (whether from the normal shutdown
 * or as a result of the `destroy()` call) still settles exactly as before,
 * rejecting with the recorded error. Only if `close` never arrives within
 * `timeoutMs` does this reject with an actionable timeout instead of hanging.
 * Deliberately does NOT settle immediately on `error` alone — that would
 * recreate the fd race fixed by #6149.
 */
export function closeLogStream(
  stream: EndableLogStream,
  timer: Timer = defaultTimer,
  timeoutMs: number = CLOSE_LOG_STREAM_TIMEOUT_MS,
): Promise<void> {
  if (stream.closed) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let pendingError: Error | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const settle = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.off("error", onError);
      stream.off("close", onClose);
      if (timeoutHandle !== undefined) {
        timer.clearTimeout(timeoutHandle);
      }
      run();
    };
    // Do NOT settle here — only record the error and keep waiting for the
    // `close` that confirms the fd is actually released. Do arm the bounded
    // fallback below so an error that is never followed by `close` cannot
    // hang this promise forever.
    const onError = (error: Error): void => {
      pendingError = error;
      timeoutHandle = timer.setTimeout(() => {
        settle(() =>
          reject(
            toActionableError(
              error,
              `Log stream did not emit 'close' within ${timeoutMs}ms of a shutdown error — the file descriptor may still be held`,
            ),
          ),
        );
      }, timeoutMs);
      // Let every listener record the error before a synchronous destroy can
      // emit close (concurrent close callers may share this stream).
      queueMicrotask(() => {
        if (!settled) {
          stream.destroy?.(error);
        }
      });
    };
    const onClose = (): void => settle(() => (pendingError ? reject(pendingError) : resolve()));
    stream.once("error", onError);
    stream.once("close", onClose);
    // Start the shutdown; the `close` listener above (not end()'s finish-time
    // callback, and not a same-tick `error`) is what actually resolves this
    // promise once the fd is released.
    stream.end();
  });
}

// Maximum log file size (10MB)
const MAX_LOG_SIZE = 10 * 1024 * 1024;

// Maximum number of THIS process's log files to keep (including the active one)
const MAX_LOG_FILES = 10;

// Abandoned logs from other (exited) processes are swept once they are older
// than this, so the directory doesn't grow without bound on a busy multi-agent
// host. A live process's active log has a recent mtime and is never touched.
const ABANDONED_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Whether a daemon is currently running (owns the pidfile and is alive). A
// `daemon-launch-<pid>.log`'s fd is inherited by the detached daemon child, so
// it must not be swept while that daemon is live even though the manager named
// in the filename has exited (issue #6194). The daemon pidfile module is
// required lazily so this foundational logger module keeps no static import of
// it (daemonFiles.ts imports THIS module) and it is resolved only at sweep time.
//
// Crucially this considers EVERY daemon namespace that could own a launch log
// in the shared log dir — the pruning process's own pid file plus co-located
// isolated-namespace pid files (issue #6140) — not just this process's own.
// When isolated daemons share an `AUTOMOBILE_LOG_DIR`, a launch log there can be
// held by a LIVE daemon in a different namespace; checking only our own would
// unlink it (the exact #6194 data-loss). The concrete pid enumeration is passed
// to `pruneLogFiles` via `daemonPidFiles` + `readDaemonOwner` below.
const isDaemonRunning = (): boolean => {
  try {
    const { readPidFileDataSync, isProcessRunning, listDaemonPidFilesSync } =
      require("../daemon/daemonFiles") as typeof import("../daemon/daemonFiles");
    const { pidFiles, uncertain } = listDaemonPidFilesSync();
    // Enumeration incomplete (custom namespace / failed scan): a live daemon may
    // exist in a namespace we could not discover — retain rather than risk it.
    if (uncertain) {
      return true;
    }
    return pidFiles.some((pidFilePath) => {
      const data = readPidFileDataSync(pidFilePath);
      return data ? isProcessRunning(data.pid) : false;
    });
  } catch (error) {
    // If the daemon pidfile can't be resolved, keep launch logs rather than
    // risk unlinking one a live daemon still holds — the safe direction here.
    logger.debug(`daemon liveness probe for log pruning failed: ${error}`, error);
    return true;
  }
};

// Enumerate the daemon pid files of every namespace that could own a launch log
// in this shared log dir (plus whether that enumeration is complete). Passed to
// `pruneLogFiles` as a THUNK so the enumeration — and the `daemonFiles` require
// it drives — is evaluated LAZILY at sweep time, never during this module's own
// init. An eager call here reached `listDaemonPidFilesSync` before `export const
// logger` (below) was initialized; its error path then touched `logger` in its
// TDZ and aborted the import with a ReferenceError (issue #6194).
const daemonPidFiles = (): DaemonPidFileEnumeration => {
  try {
    const { listDaemonPidFilesSync } =
      require("../daemon/daemonFiles") as typeof import("../daemon/daemonFiles");
    return listDaemonPidFilesSync();
  } catch (error) {
    // The pidfile module could not be resolved, so no namespace could be
    // enumerated — carry uncertainty so `pruneLogFiles` retains launch logs.
    logger.debug(`daemon pidfile enumeration for log pruning failed: ${error}`, error);
    return { pidFiles: [], uncertain: true };
  }
};

const readDaemonOwner = (pidFilePath: string) => {
  // Deliberately NOT wrapped in a swallowing catch: `readDaemonOwnerForRetentionSync`
  // returns undefined only for a confidently-absent file and THROWS on an
  // unreadable/malformed one, and that throw must propagate to `pruneLogFiles`'s
  // retain-on-ambiguity path rather than be flattened to "absent" (issue #6194).
  const { readDaemonOwnerForRetentionSync } =
    require("../daemon/daemonFiles") as typeof import("../daemon/daemonFiles");
  return readDaemonOwnerForRetentionSync(pidFilePath);
};

const readDaemonLaunchLogOwnerTombstone = (launchLogPath: string) => {
  const { readDaemonLaunchLogOwnerTombstoneSync } =
    require("../daemon/daemonFiles") as typeof import("../daemon/daemonFiles");
  return readDaemonLaunchLogOwnerTombstoneSync(launchLogPath);
};

// Remove old log files. Only ever deletes (a) this process's own rotated backups
// beyond the cap, and (b) other processes' logs that are stale by mtime — never
// another live process's current file, nor a daemon-launch log while a daemon is
// running (its inherited fd). See logPruner.ts.
const pruneOldLogFiles = (): Promise<void> => {
  if (!logsDir) {
    return Promise.resolve();
  }
  return pruneLogFiles({
    dir: logsDir,
    ownPrefix: ownLogPrefix,
    maxOwnFiles: MAX_LOG_FILES,
    abandonedMaxAgeMs: ABANDONED_LOG_MAX_AGE_MS,
    // Namespace-aware retention: read every co-located namespace's exact
    // launch-log ownership declaration (issue #6194).
    // Passed as the thunk itself (not `daemonPidFiles()`) so enumeration is
    // deferred to sweep time — an eager call crashed the cyclic logger import
    // before `logger` was initialized (issue #6194).
    daemonPidFiles,
    readDaemonOwner,
    readDaemonLaunchLogOwnerTombstone,
    isDaemonRunning,
  });
};

// Sweep logs abandoned by already-exited processes once at startup. Short-lived
// agents exit with small logs and never reach the size-based rotation that would
// otherwise trigger a sweep, so without this their per-PID files would accumulate
// in the shared logs dir on a busy multi-agent host. Fire-and-forget so it never
// delays logger initialization; the sweep itself only removes dead-owner files.
if (logsDir) {
  pruneOldLogFiles().catch(() => {
    /* best-effort startup sweep */
  });
}

// Closes the active stream ahead of rotation and WAITS for it to actually
// finish before the caller opens a replacement at the same path. A
// fire-and-forget `end()` races bun's epoll registration for the reused fd:
// opening the new WriteStream while the old one's close is still in flight
// can throw `EEXIST: file already exists, epoll_ctl` on the new stream's own
// construction (issue #6149). A stream failing to close cleanly must not
// block rotation itself, so that failure is caught and logged here rather
// than propagated — the caller still proceeds to open the replacement.
const closeStreamBeforeRotation = async (stream: fs.WriteStream): Promise<void> => {
  try {
    await closeLogStream(stream);
  } catch (closeError) {
    await reportLogFailure("Failed to close log stream before rotation", closeError);
  }
};

// Closes the oversized active stream, renames it to a timestamped backup, and
// opens a fresh replacement at the original path. Split out of
// checkAndRotateLog so each step reads at its own nesting level instead of
// stacking inside that function's existing try/if/if.
const rotateLogFile = async (paths: { dir: string; path: string }): Promise<void> => {
  const closingStream = logStream;
  logStream = undefined;
  if (closingStream) {
    await closeStreamBeforeRotation(closingStream);
  }

  // Create backup filename with timestamp, scoped to this process's PID so
  // rotation never collides with another process's files.
  const timestamp = new Date().toISOString().replace(/:/g, "-");
  const backupPath = path.join(paths.dir, `${ownLogPrefix}-${timestamp}.log`);

  // Check if file still exists right before rename to avoid race condition
  if (fs.existsSync(paths.path)) {
    // Rename current log file to backup
    await fs.promises.rename(paths.path, backupPath);
  }

  // Always create a new log stream after rotation attempt
  logStream = openLogStream(paths.path);

  // Prune old log files to stay within the cap
  await pruneOldLogFiles();
};

// A single check-and-maybe-rotate cycle runs at a time, and every write
// serializes against it (see writeToFile). While it is set, `logStream` may
// be briefly undefined — the old stream is closing and the replacement is not
// yet open — so a concurrent write that opened its own stream at the same
// path would recreate the very epoll EEXIST race rotation's close-before-
// reopen exists to avoid (issue #6149). Sharing this promise makes back-to-
// back writes join the in-flight cycle instead of starting a second
// close/reopen.
//
// The lock covers the size CHECK as well as the rotation itself, not just
// the rotation — see checkAndRotateLocked. Guarding only rotateLogFile() left
// a TOCTOU window: two concurrent callers could both read "oversized" before
// either rotated, the first would rotate and clear this flag, and the second
// — still holding its now-stale size result — would rotate again on the
// freshly-created, small replacement file (#6149 round 3).
let rotationInFlight: Promise<void> | undefined;

// Re-checks the file size and rotates if it is still oversized. Called only
// while holding `rotationInFlight` (see checkAndRotateLog), so a concurrent
// caller can never act on a size read before an earlier caller's rotation
// already shrank the file.
const checkAndRotateLocked = async (paths: { dir: string; path: string }): Promise<void> => {
  if (!fs.existsSync(paths.path)) {
    return;
  }
  const stats = await statAsync(paths.path);
  if (stats.size >= MAX_LOG_SIZE) {
    await rotateLogFile(paths);
  }
};

// Start a check-and-maybe-rotate cycle if none is running, and return the
// shared promise so concurrent callers JOIN the in-flight cycle instead of
// racing their own stat/rotate at the same path (issue #6149).
const beginOrJoinRotationCheck = (paths: { dir: string; path: string }): Promise<void> => {
  if (!rotationInFlight) {
    rotationInFlight = checkAndRotateLocked(paths).finally(() => {
      rotationInFlight = undefined;
    });
  }
  return rotationInFlight;
};

// A failed shared rotation is observed by both the writer that started it and
// writers that were waiting behind it. The promise's `finally` clears the
// in-flight marker before any waiter resumes, so recovery can safely publish a
// replacement stream here. Keep this idempotent: several joined writers can
// observe the same failure, but only the first one needs to reopen the stream.
const recoverFromFailedRotation = async (
  paths: { dir: string; path: string },
  error: unknown,
): Promise<void> => {
  if (logStream?.destroyed || !logStream?.writable) {
    logStream = openLogStream(paths.path);
  }
  await reportLogFailure("Log rotation failed", error);
};

// Bytes accumulated since the last time checkAndRotateLog actually stat'd the
// file. Seeded at Infinity so the very first write after the stream opens
// forces an immediate check regardless of what THIS process has written so
// far -- the file may already be oversized left over from a previous run
// (e.g. the daemon's single, stably-named log surviving across restarts,
// see the `ownLogPrefix` comment above), and this process has no prior
// writes of its own yet to compare against.
let bytesSinceLastRotationCheck = Number.POSITIVE_INFINITY;

// Only re-stat once writes could plausibly have pushed the file within
// striking distance of MAX_LOG_SIZE, instead of on every single write
// (issue #6651). A steady stream of small, serialized writes previously paid
// for an `fs.existsSync` + `await statAsync` pair ahead of every line even
// though rotation only needs to happen once every MAX_LOG_SIZE bytes of
// output. Fixed (not a fraction of MAX_LOG_SIZE) and deliberately small so
// overshoot past MAX_LOG_SIZE stays a small multiple of this interval (a few
// tens of KiB): buffered writes flushed between checks can defer a stat by
// more than one interval's worth of bytes, so the bound is roughly this
// interval plus one flush of pending output, not exactly this value.
const ROTATION_CHECK_INTERVAL_BYTES = 32 * 1024;

// Function to check log file size and rotate if necessary. Only actually
// stats the file once `lineByteLength` (this write's contribution) has
// pushed the accumulated total since the last check past
// ROTATION_CHECK_INTERVAL_BYTES -- see `bytesSinceLastRotationCheck` above.
// `rotationInFlight`'s concurrent-caller coalescing (beginOrJoinRotationCheck)
// is untouched: it still covers every writer that arrives while an actual
// check/rotation cycle is running; only this too-eager triggering condition
// changed.
const checkAndRotateLog = async (lineByteLength: number): Promise<void> => {
  bytesSinceLastRotationCheck += lineByteLength;
  if (bytesSinceLastRotationCheck < ROTATION_CHECK_INTERVAL_BYTES) {
    return;
  }
  bytesSinceLastRotationCheck = 0;

  const paths = fileLogPaths();
  if (!paths || !logStream) {
    return;
  }
  try {
    await beginOrJoinRotationCheck(paths);
  } catch (error) {
    await recoverFromFailedRotation(paths, error);
  }
};

// Sensitive environment variable keys to filter from logs
const SENSITIVE_ENV_KEYS = new Set([
  "PASSWORD",
  "TOKEN",
  "SECRET",
  "KEY",
  "CREDENTIAL",
  "AUTH",
  "API_KEY",
  "PRIVATE_KEY",
  "ACCESS_TOKEN",
  "REFRESH_TOKEN",
  "CLIENT_SECRET",
  "DATABASE_URL",
  "DB_PASSWORD",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
]);

// Function to safely stringify objects while filtering sensitive data
const safeStringify = (obj: any): string => {
  if (typeof obj !== "object" || obj === null) {
    return String(obj);
  }

  // Track only the current ancestor path (not every object ever visited) so a
  // shared child referenced from two sibling positions — a DAG/diamond, which is
  // NOT a cycle — renders fully at both, instead of the second occurrence being
  // mis-flagged as "[circular]". Each entry pairs the filtered object we return
  // (which becomes `this`, the holder, in the child calls) with the original value
  // it was built from (whose identity a true cycle repeats on the path). See #5617.
  const ancestors: Array<{ holder: object; original: object }> = [];
  try {
    return JSON.stringify(obj, function (this: unknown, _key, value) {
      if (typeof value === "object" && value !== null) {
        // Unwind the path back to this value's holder before testing/pushing, so
        // siblings don't inherit each other's descendants as false ancestors.
        while (ancestors.length > 0 && ancestors[ancestors.length - 1].holder !== this) {
          ancestors.pop();
        }
        if (ancestors.some((entry) => entry.original === value)) {
          return "[circular]";
        }
        // Filter sensitive environment-like keys
        const filtered: any = {};
        for (const [k, v] of Object.entries(value)) {
          if (!SENSITIVE_ENV_KEYS.has(k.toUpperCase())) {
            filtered[k] = v;
          }
        }
        ancestors.push({ holder: filtered, original: value });
        return filtered;
      }
      // JSON has no representation for non-finite numbers, so JSON.stringify would
      // emit them as `null` — masking what a caller actually sent (e.g. the daemon
      // request log showing a rejected `Infinity`/`NaN` argument as `null`, #5854).
      // Render the literal marker instead so the trace is faithful.
      if (typeof value === "number" && !Number.isFinite(value)) {
        return String(value);
      }
      return value;
    });
  } catch (error) {
    // Circular diagnostic values are expected at a logging boundary. Preserve
    // the primary record rather than creating a second, potentially unsinkable
    // logging failure.
    void error;
    return "[unserializable]";
  }
};

// Function to sanitize log message to prevent log injection
const sanitizeMessage = (message: string): string => {
  return message.replace(/[\r\n\t]/g, " ");
};

// Exported for unit tests that pin the redaction / injection-sanitizing contract.
export { SENSITIVE_ENV_KEYS, safeStringify, sanitizeMessage };

// Function to write to log file
const formatLogRecord = (level: string, message: string, args: any[]): string => {
  const timestamp = new Date().toISOString();
  const sanitizedMessage = sanitizeMessage(message);
  const argsStr =
    args.length > 0
      ? ` ${args.map((arg) => sanitizeMessage(typeof arg === "object" ? safeStringify(arg) : String(arg))).join(" ")}`
      : "";
  const fullMessage = `${sanitizedMessage}${argsStr}`;
  const boundedMessage =
    fullMessage.length > 1000 ? `${fullMessage.substring(0, 1000)}... (truncated)` : fullMessage;

  if (logFormat === "json") {
    return JSON.stringify({
      timestamp,
      level: level.toLowerCase(),
      component: ownLogPrefix,
      event: "log",
      message: boundedMessage,
    });
  }

  return `${timestamp} [${level}] ${boundedMessage}`;
};

const writeToStderr = (line: string): Promise<void> =>
  new Promise((resolve, reject) => {
    process.stderr.write(`${line}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });

const reportLogFailure = async (context: string, error: unknown): Promise<void> => {
  if (logSink === "file") {
    return;
  }
  const message = `${context}: ${sanitizeMessage(String(error))}`;
  const line =
    logFormat === "json"
      ? JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "error",
          component: ownLogPrefix,
          event: "log.write_failed",
          message,
        })
      : message;
  try {
    await writeToStderr(line);
  } catch (error) {
    // The configured stream is itself unavailable, so no diagnostic sink remains.
    void error;
  }
};

const writeToFile = async (line: string): Promise<void> => {
  if (!logFilePath) {
    // Stderr-only sink: no file stream is ever expected here.
    return;
  }
  // Serialize this write against any in-flight rotation. During rotation
  // `logStream` is transiently undefined (old stream closing, replacement not
  // yet open); without this wait, the lazy reopen below would observe that gap
  // and open a second stream at the same path while the old fd is still
  // closing — the exact epoll EEXIST race rotation guards against (issue
  // #6149). Wait for rotation to publish the fresh stream, then use it.
  while (rotationInFlight) {
    try {
      await rotationInFlight;
    } catch (error) {
      // The initiating writer handles a failed rotation in checkAndRotateLog,
      // but a writer that joined before it settled gets here first and used to
      // escape without writing its record. Give every joiner the same
      // recovery/degradation path so a file-only sink never silently loses it.
      const paths = fileLogPaths();
      if (paths) {
        await recoverFromFailedRotation(paths, error);
      }
    }
  }
  if (!logStream) {
    // A prior open attempt failed — e.g. bun's transient EEXIST/epoll race
    // (#5930 family). Retry lazily on the next write instead of leaving the
    // sink permanently dead: the failure that killed it may have cleared.
    logStream = openLogStream(logFilePath);
  }
  if (logStream) {
    await checkAndRotateLog(Buffer.byteLength(line) + 1);
  }
  const stream = logStream;
  if (!stream) {
    // Still unavailable. When file is the only configured sink, degrade to
    // stderr rather than silently discarding the record (issue #6179);
    // `stderr`/`both` sinks already emit this line via writeToConfiguredStderr.
    if (logSink === "file") {
      await writeToStderr(line);
    }
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      stream.write(line + "\n", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  } catch (error) {
    // The write itself failed (e.g. EISDIR/ENOSPC surfacing on write rather
    // than at open). The stream's own 'error' listener (attachStreamFailureHandlers)
    // will also fire and drop `logStream` so later writes retry/degrade, but
    // THIS record must not vanish too. `reportLogFailure` intentionally
    // suppresses its diagnostic for the `file` sink, so degrade the record
    // itself to stderr here rather than relying on that path (issue #6179).
    // `stderr`/`both` sinks already have this line on stderr via
    // writeToConfiguredStderr, so only handle it here for `file`; otherwise
    // rethrow and let the existing writeToLogFile/reportLogFailure diagnostic
    // stand, avoiding a duplicate of the same line.
    if (logSink === "file") {
      await writeToStderr(line);
      return;
    }
    throw error;
  }
};

const writeToConfiguredStderr = async (line: string): Promise<void> => {
  if (logSink === "stderr" || logSink === "both") {
    await writeToStderr(line);
  }
};

const mirrorToLegacyStdout = (line: string): void => {
  if (logToStdout && logFormat === "text") {
    process.stdout.write(`${line}\n`);
  }
};

const writeToLogFile = async (level: string, message: string, args: any[]) => {
  try {
    const safeLogMessage = formatLogRecord(level, message, args).replace(/[\r\n\t]/g, " ");
    // Start both configured writes before awaiting either one. A failed file
    // sink must not suppress the process-stream record in `both` mode.
    await Promise.all([writeToFile(safeLogMessage), writeToConfiguredStderr(safeLogMessage)]);
    mirrorToLegacyStdout(safeLogMessage);
  } catch (err) {
    await reportLogFailure("Failed to write log", err);
  }
};

// In stderr-only mode there is no file stream to rotate or close.
const closeCurrentLogStream = async (): Promise<void> => {
  if (logStream) {
    await closeLogStream(logStream);
  }
};

// Logger object with all methods
export const logger: Logger = {
  /**
   * Sets the current log level
   */
  setLogLevel(level: LogLevel): void {
    currentLogLevel = level;
  },

  /**
   * Gets the current log level
   */
  getLogLevel(): LogLevel {
    return currentLogLevel;
  },

  /**
   * Enables logging to STDOUT in addition to log files
   */
  enableStdoutLogging(): void {
    // Structured logs must never share stdout with MCP JSON-RPC traffic.
    logToStdout = logFormat === "text";
  },

  /**
   * Disables logging to STDOUT
   */
  disableStdoutLogging(): void {
    logToStdout = false;
  },

  /**
   * Logs a debug message
   */
  debug(message: string, ...args: any[]): void {
    if (currentLogLevel <= LogLevel.DEBUG) {
      trackWrite(
        writeToLogFile("DEBUG", message, args).catch((err) => {
          return reportLogFailure("Failed to write debug log", err);
        }),
      );
    }
  },

  /**
   * Logs an info message
   */
  info(message: string, ...args: any[]): void {
    if (currentLogLevel <= LogLevel.INFO) {
      trackWrite(
        writeToLogFile("INFO", message, args).catch((err) => {
          return reportLogFailure("Failed to write info log", err);
        }),
      );
    }
  },

  /**
   * Logs a warning message
   */
  warn(message: string, ...args: any[]): void {
    if (currentLogLevel <= LogLevel.WARN) {
      trackWrite(
        writeToLogFile("WARN", message, args).catch((err) => {
          return reportLogFailure("Failed to write warn log", err);
        }),
      );
    }
  },

  /**
   * Logs an error message
   */
  error(message: string, ...args: any[]): void {
    if (currentLogLevel <= LogLevel.ERROR) {
      trackWrite(
        writeToLogFile("ERROR", message, args).catch((err) => {
          return reportLogFailure("Failed to write error log", err);
        }),
      );
    }
  },

  /**
   * Awaits any in-flight fire-and-forget log writes. See interface docs.
   */
  async flush(): Promise<void> {
    await lastWrite;
  },

  /**
   * Flushes queued writes and closes the log stream.
   */
  close(): void {
    logStream?.end();
  },

  async closeAfterFlush(): Promise<void> {
    await lastWrite;
    await closeCurrentLogStream();
  },
};

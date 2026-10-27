/**
 * Simple logger utility with different log levels
 */
import { productionStallTimer, type LogSinkTimer } from "./loggerStreamLifecycle";
import { formatLogRecord } from "./loggerValues";
import { testOverrides } from "./testOverrides";
import fs from "fs";
import path from "path";
import { statAsync } from "./io";
import { ensureSecureLogsDirSync } from "./tempDir";
import {
  pruneLogFiles,
  type DaemonPidFileEnumeration,
  type LogRetentionNamespaceSource,
} from "./logPruner";
import {
  resolveAutomobileLogFormat,
  resolveAutomobileLogSink,
  writeEmergencyLog,
  logStreamFactory,
  type LogStream,
} from "./loggingConfig";
import { Timer, defaultTimer } from "./SystemTimer";
import { toActionableError } from "../models/ActionableError";
import { raceWithDeadline } from "./raceWithDeadline";
import { isProcessRunning } from "./processLiveness";
import { LogSinkStallGuard } from "./logSinkStallGuard";
import { ENV, readEnvRaw } from "../config/env";
import {
  Logger,
  LogLevel,
  parseAutomobileLogLevel,
  resolveProcessLogPrefix,
  SENSITIVE_ENV_KEYS,
  safeStringify,
  sanitizeMessage,
} from "./loggerValues";
import { CLOSE_LOG_STREAM_TIMEOUT_MS, closeLogStream } from "./loggerStreamLifecycle";
export { CLOSE_LOG_STREAM_TIMEOUT_MS, closeLogStream } from "./loggerStreamLifecycle";

export {
  type Logger,
  LogLevel,
  parseAutomobileLogLevel,
  resolveProcessLogPrefix,
} from "./loggerValues";

export {
  parseAutomobileLogFormat,
  parseAutomobileLogSink,
  resolveAutomobileLogFormat,
  resolveAutomobileLogSink,
  type LogFormat,
  type LogSink,
} from "./loggingConfig";

export function isStructuredLoggingEnabled(): boolean {
  return logFormat === "json";
}

// Seed the level from AUTOMOBILE_LOG_LEVEL at process start (issue #3845) so a
// user who exports the env var actually changes what the running process emits,
// rather than silently staying at INFO. Applied here at module load — the single
// point every process (daemon, stdio client, direct mode) passes through, and a
// DaemonManager-spawned daemon inherits the var via its `{ ...process.env }`
// child env. Falls back to INFO when unset/unrecognized; still overridable at
// runtime via setLogLevel.
let currentLogLevel: LogLevel = parseAutomobileLogLevel(readEnvRaw(ENV.LOG_LEVEL)) ?? LogLevel.INFO;

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
const attachStreamFailureHandlers = (stream: LogStream, target: string): void => {
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
    streamStallGuards.get(stream)?.retire(error);
    // An asynchronously failed stream is no longer usable. Release its fd
    // before a later write retries opening this PID-scoped path.
    deferReopenUntilClose(stream);
    // Error listeners run in registration order. Wait until all of them have
    // recorded this error before destroy can synchronously emit close.
    queueMicrotask(() => stream.destroy?.());
  });
};

// Every old descriptor whose close was not confirmed keeps this path unavailable.
// These are old-stream release barriers, never references to the current sink.
const unconfirmedCloses = new Map<
  LogStream,
  {
    timer: Pick<Timer, "setTimeout" | "clearTimeout">;
    timeoutHandle: NodeJS.Timeout;
    onClose: () => void;
  }
>();
const deferReopenUntilClose = (
  stream: LogStream,
  timer: Pick<Timer, "setTimeout" | "clearTimeout"> = defaultTimer,
): void => {
  if (stream.closed) {
    return;
  }
  const previous = unconfirmedCloses.get(stream);
  if (previous) {
    previous.timer.clearTimeout(previous.timeoutHandle);
    stream.off("close", previous.onClose);
  }
  // A permanent stream error can follow a drain timeout that already armed
  // this barrier with a caller-injected timer. Keep that ownership when the
  // error handler re-arms it with the default timer; explicit callers can
  // still transfer the barrier by passing their own timer.
  const barrierTimer = previous && timer === defaultTimer ? previous.timer : timer;
  const onClose = (): void => {
    const entry = unconfirmedCloses.get(stream);
    if (entry?.onClose === onClose) {
      entry.timer.clearTimeout(entry.timeoutHandle);
      stream.off("close", onClose);
      unconfirmedCloses.delete(stream);
    }
  };
  const timeoutHandle = barrierTimer.setTimeout(onClose, CLOSE_LOG_STREAM_TIMEOUT_MS);
  unconfirmedCloses.set(stream, { timer: barrierTimer, timeoutHandle, onClose });
  stream.once("close", onClose);
};

// Constructing an appending WriteStream can throw synchronously — e.g. bun's
// internal fast path occasionally races its epoll registration and throws
// `EEXIST: ... epoll_ctl` (issue #5930 family). At module load this crashes the
// importing process ("Unhandled error between tests" in the host-integration
// lane). File logging is best-effort, so swallow the construction failure and
// fall back to console-only logging rather than taking the process down.
const openLogStream = (target: string): LogStream | undefined => {
  for (const [stream, entry] of unconfirmedCloses) {
    if (stream.closed) {
      entry.onClose();
    }
  }
  if (unconfirmedCloses.size > 0) {
    return undefined;
  }
  try {
    const stream = logStreamFactory.create(target, { flags: "a" });
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
// Busy integration files can enqueue many best-effort log records. Allow their
// callbacks to drain before treating a stalled writer as a shutdown failure;
// the subsequent fd-close wait has its own shorter bound.
export const CLOSE_LOG_WRITES_TIMEOUT_MS = 20_000;
export const LOG_WRITE_STALL_TIMEOUT_MS = 5_000;
export const LOG_SINK_ABANDON_TIMEOUT_MS = 30_000;
let logSinkStallTimer: LogSinkTimer = productionStallTimer;
const streamStallGuards = new WeakMap<LogStream, LogSinkStallGuard>();
let intentionalDrainCount = 0;
let rotationWait:
  | {
      operation: Promise<void>;
      guard: LogSinkStallGuard;
      completion: Promise<boolean>;
    }
  | undefined;

export function setLogSinkStallTimerForTesting(timer: Timer | undefined): void {
  logSinkStallTimer = timer ?? productionStallTimer;
}

// Maximum log file size (10MB)
const MAX_LOG_SIZE = 10 * 1024 * 1024;

// Maximum number of THIS process's log files to keep (including the active one)
const MAX_LOG_FILES = 10;

// Abandoned logs from other (exited) processes are swept once they are older
// than this, so the directory doesn't grow without bound on a busy multi-agent
// host. A live process's active log has a recent mtime and is never touched.
const ABANDONED_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let logRetentionNamespaceSource: LogRetentionNamespaceSource | undefined;

export function registerLogRetentionNamespaceSource(source: LogRetentionNamespaceSource): void {
  logRetentionNamespaceSource = source;
  if (startupLogSweep && !startupLogSweep.registeredSweepStarted) {
    scheduleStartupLogSweep(startupLogSweep);
  }
}

export function resetLogRetentionNamespaceSourceForTesting(options?: {
  timer: Timer;
  prune: () => Promise<void>;
}): void {
  logRetentionNamespaceSource = undefined;
  if (startupLogSweep?.timeout !== undefined) {
    startupLogSweep.timer.clearTimeout(startupLogSweep.timeout);
  }
  // Replacing the state also invalidates work queued behind an in-flight sweep.
  startupLogSweep = options ? createStartupLogSweep(options.timer, options.prune) : undefined;
}

export function flushLogRetentionStartupSweepForTesting(): Promise<void> {
  return startupLogSweep?.pending ?? Promise.resolve();
}

function requireLogRetentionNamespaceSource(): LogRetentionNamespaceSource {
  if (!logRetentionNamespaceSource) {
    throw new Error("Log retention namespace source is not registered");
  }
  return logRetentionNamespaceSource;
}

// Whether a daemon is currently running (owns the pidfile and is alive). A
// `daemon-launch-<pid>.log`'s fd is inherited by the detached daemon child, so
// it must not be swept while that daemon is live even though the manager named
// in the filename has exited (issue #6194). Namespace discovery is supplied by
// the daemon layer and resolved only at sweep time.
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
    const source = requireLogRetentionNamespaceSource();
    const { pidFiles, uncertain } = source.listDaemonPidFilesSync();
    // Enumeration incomplete (custom namespace / failed scan): a live daemon may
    // exist in a namespace we could not discover — retain rather than risk it.
    if (uncertain) {
      return true;
    }
    return pidFiles.some((pidFilePath) => {
      const data = source.readPidFileDataSync(pidFilePath);
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
// `pruneLogFiles` as a THUNK so discovery waits until sweep time, after the
// asynchronous directory read. Registration itself performs no I/O (issue #6194).
const daemonPidFiles = (): DaemonPidFileEnumeration => {
  try {
    return requireLogRetentionNamespaceSource().listDaemonPidFilesSync();
  } catch (error) {
    // The namespace source is unavailable/failed, so no namespace could be
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
  return requireLogRetentionNamespaceSource().readDaemonOwnerForRetentionSync(pidFilePath);
};

const readDaemonLaunchLogOwnerTombstone = (launchLogPath: string) => {
  return requireLogRetentionNamespaceSource().readDaemonLaunchLogOwnerTombstoneSync(launchLogPath);
};

/** The same lazy callbacks used by startup sweeping and size-based rotation. */
export const logRetentionNamespaces = {
  daemonPidFiles,
  readDaemonOwner,
  readDaemonLaunchLogOwnerTombstone,
  isDaemonRunning,
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
    // deferred to sweep time rather than during registration (issue #6194).
    ...logRetentionNamespaces,
  });
};

interface StartupLogSweep {
  timer: Timer;
  prune: () => Promise<void>;
  timeout?: NodeJS.Timeout;
  pending: Promise<void>;
  fallbackStarted: boolean;
  registeredSweepStarted: boolean;
}

function scheduleStartupLogSweep(state: StartupLogSweep): void {
  if (state.timeout !== undefined) {
    return;
  }
  state.timeout = state.timer.setTimeout(() => {
    state.timeout = undefined;
    // Serialize a registration sweep after an in-flight unregistered fallback.
    // Repeated registration can replace readers, but never adds another sweep.
    state.pending = state.pending.then(async () => {
      if (state !== startupLogSweep || state.registeredSweepStarted) {
        return;
      }
      const registered = logRetentionNamespaceSource !== undefined;
      if (state.fallbackStarted && !registered) {
        return;
      }
      state.fallbackStarted = true;
      state.registeredSweepStarted = registered;
      try {
        await state.prune();
      } catch (error) {
        logger.warn("Startup log pruning failed", error);
      }
    });
  }, 0);
}

function createStartupLogSweep(timer: Timer, prune: () => Promise<void>): StartupLogSweep {
  const state: StartupLogSweep = {
    timer,
    prune,
    pending: Promise.resolve(),
    fallbackStarted: false,
    registeredSweepStarted: false,
  };
  scheduleStartupLogSweep(state);
  return state;
}

// Give module-load reader registration one event-loop turn without delaying
// logger initialization. The zero-delay timer stays ref'd so even a short-lived
// CLI process starts the sweep before exiting. Logger-only paths still get
// bounded, fail-closed cleanup. If daemonFiles loads later,
// registration schedules exactly one sweep with readers, even after the fallback.
let startupLogSweep = logsDir ? createStartupLogSweep(defaultTimer, pruneOldLogFiles) : undefined;

// Closes the active stream ahead of rotation and WAITS for it to actually
// finish before the caller opens a replacement at the same path. A
// fire-and-forget `end()` races bun's epoll registration for the reused fd:
// opening the new WriteStream while the old one's close is still in flight
// can throw `EEXIST: file already exists, epoll_ctl` on the new stream's own
// construction (issue #6149). A failed close defers rotation until the
// descriptor confirms release; writes degrade to stderr in the meantime.
const closeStreamBeforeRotation = async (stream: LogStream): Promise<boolean> => {
  streamStallGuards.get(stream)?.suspend();
  try {
    await closeLogStream(stream);
    return true;
  } catch (closeError) {
    const closeConfirmed = stream.closed === true;
    // A timeout does not prove the old descriptor was released.
    if (!closeConfirmed) {
      deferReopenUntilClose(stream);
    }
    await reportLogFailure("Failed to close log stream before rotation", closeError);
    return closeConfirmed;
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
    if (!(await closeStreamBeforeRotation(closingStream))) {
      bytesSinceLastRotationCheck = Number.POSITIVE_INFINITY;
      return;
    }
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
  if (unconfirmedCloses.size === 0 && (logStream?.destroyed || !logStream?.writable)) {
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
const checkAndRotateLog = async (lineByteLength: number): Promise<boolean> => {
  bytesSinceLastRotationCheck += lineByteLength;
  if (bytesSinceLastRotationCheck < ROTATION_CHECK_INTERVAL_BYTES) {
    return true;
  }
  bytesSinceLastRotationCheck = 0;

  const paths = fileLogPaths();
  if (!paths || !logStream) {
    return true;
  }
  try {
    return await waitForRotation(beginOrJoinRotationCheck(paths));
  } catch (error) {
    await recoverFromFailedRotation(paths, error);
    return true;
  }
};

// Exported for unit tests that pin the redaction / injection-sanitizing contract.
export { SENSITIVE_ENV_KEYS, safeStringify, sanitizeMessage };

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

// Bypass the potentially wedged async stderr queue for the last diagnostic sink.
const writeSynchronousStderr = (line: string): void => {
  try {
    fs.writeSync(process.stderr.fd, `${line}\n`);
  } catch (error) {
    // No diagnostic sink remains; EAGAIN/EPIPE/closed-fd failures cannot be logged through the logger.
    void error;
  }
};

const reportSinkStall = (timer: LogSinkTimer, event: string, message: string): void => {
  lastSinkStallReportedAtMs = timer.now();
  writeSynchronousStderr(
    logFormat === "json"
      ? JSON.stringify({
          timestamp: new Date(timer.now()).toISOString(),
          level: "error",
          component: ownLogPrefix,
          event,
          message: sanitizeMessage(message),
        })
      : sanitizeMessage(message),
  );
};

const writeResumedRecord = (elapsedMs: number, diverted: number): void => {
  // This file-sink recovery summary is a normal WARN record, without another stderr copy.
  trackWrite(
    writeToFile(
      formatLogRecord(
        logFormat,
        ownLogPrefix,
        "WARN",
        `Log sink ${logFilePath} resumed after ${elapsedMs}ms; ${diverted} line(s) were diverted while it was stalled`,
        [],
      ),
    ).catch((error) => reportLogFailure("Failed to write log sink recovery", error)),
  );
};

const abandonStalledStream = (
  stream: LogStream,
  timer: LogSinkTimer,
  elapsed: number,
  dropped: number,
): void => {
  reportSinkStall(
    timer,
    "log.sink_abandoned",
    `Log sink ${logFilePath} abandoned after ${elapsed}ms stalled; ${dropped} line(s) dropped`,
  );
  if (logStream === stream) {
    logStream = undefined;
  }
  deferReopenUntilClose(stream, timer);
  try {
    stream.destroy?.();
  } catch (error) {
    // Descriptor teardown is best effort; the close barrier still bounds retry and no diagnostic sink remains.
    void error;
  }
};

const stallGuardForStream = (stream: LogStream): LogSinkStallGuard => {
  let guard = streamStallGuards.get(stream);
  if (!guard) {
    const timer = logSinkStallTimer;
    guard = new LogSinkStallGuard({
      timer,
      timeoutMs: LOG_WRITE_STALL_TIMEOUT_MS,
      abandonMs: LOG_SINK_ABANDON_TIMEOUT_MS,
      stalled: (pending) =>
        reportSinkStall(
          timer,
          "log.sink_stalled",
          `Logging to ${logFilePath} stalled: no write completed within ${LOG_WRITE_STALL_TIMEOUT_MS}ms; ${pending} line(s) pending`,
        ),
      resumed: writeResumedRecord,
      abandoned: (elapsed, pending) => abandonStalledStream(stream, timer, elapsed, pending),
    });
    if (intentionalDrainCount > 0) {
      guard.suspend();
    }
    streamStallGuards.set(stream, guard);
  }
  return guard;
};

// One shared deadline per rotation, never one timer (or unresolved continuation) per later line.
// Timing out does not cancel/clear rotationInFlight or open a second descriptor (#6149).
const waitForRotation = (operation: Promise<void>): Promise<boolean> => {
  if (rotationWait?.operation === operation) {
    return rotationWait.completion;
  }
  const timer = logSinkStallTimer;
  const guard = new LogSinkStallGuard({
    timer,
    timeoutMs: LOG_WRITE_STALL_TIMEOUT_MS,
    stalled: () =>
      reportSinkStall(
        timer,
        "log.sink_stalled",
        `Logging to ${logFilePath} stalled: log rotation did not finish within ${LOG_WRITE_STALL_TIMEOUT_MS}ms`,
      ),
    resumed: writeResumedRecord,
  });
  if (intentionalDrainCount > 0) {
    guard.suspend();
  }
  const completion = guard.track((done) => {
    const finish = (error?: unknown): void => {
      done(error);
      if (rotationWait?.guard === guard) {
        rotationWait = undefined;
      }
    };
    void operation
      .then(
        () => finish(),
        async (error: unknown) => {
          const stalled = guard.stalled;
          finish(error);
          // Timed-out waiters already settled, so they cannot run their usual recovery catch.
          const paths = fileLogPaths();
          if (stalled && paths) {
            await recoverFromFailedRotation(paths, error);
          }
        },
      )
      .catch((error) => reportLogFailure("Failed to recover log rotation", error));
  });
  rotationWait = { operation, guard, completion };
  return completion;
};

const stopRotationWatchdog = (retire = false): void => {
  if (retire) {
    rotationWait?.guard.retire();
  } else {
    rotationWait?.guard.suspend();
  }
  rotationWait = undefined;
  // Keep rotationInFlight authoritative. A later record can watch it afresh,
  // but may never reopen the path while the original rotation is still running.
};

const divertFileRecord = (line: string): void => {
  rotationWait?.guard.divert();
  if (logStream) {
    streamStallGuards.get(logStream)?.divert();
  }
  // Both already emits this record on its configured stderr sink.
  if (logSink === "file") {
    writeSynchronousStderr(line);
  }
};

const sinkStalled = (): boolean =>
  rotationWait?.guard.stalled === true ||
  (logStream !== undefined && streamStallGuards.get(logStream)?.stalled === true);

/**
 * When a stall was last reported. A stalled stream is abandoned after LOG_SINK_ABANDON_TIMEOUT_MS
 * and only counts as stalled again once a later write has itself gone unanswered, so the live flag
 * alone drops out for part of every long host-wide I/O stall (#11990).
 */
let lastSinkStallReportedAtMs: number | undefined;

/**
 * True if the file log sink is stalled now, or reported a stall within `windowMs`: a signal that
 * host disk I/O is blocked, not that any one consumer is broken (#11990). Always false when the
 * sink is not a file (stderr), since nothing then writes to disk.
 */
export const logSinkStalledWithin = (windowMs: number): boolean =>
  sinkStalled() ||
  (lastSinkStallReportedAtMs !== undefined &&
    logSinkStallTimer.now() - lastSinkStallReportedAtMs <= windowMs);

const waitForPriorRotation = async (): Promise<boolean> => {
  while (rotationInFlight) {
    try {
      if (!(await waitForRotation(rotationInFlight))) {
        return false;
      }
    } catch (error) {
      // Every joiner retains the same failed-rotation recovery/degradation path (#6179).
      const paths = fileLogPaths();
      if (paths) {
        await recoverFromFailedRotation(paths, error);
      }
    }
  }
  return true;
};

const prepareFileSink = async (line: string): Promise<boolean> => {
  if (!logFilePath) {
    return false;
  }
  if (sinkStalled()) {
    divertFileRecord(line);
    return false;
  }
  // Preserve close-before-reopen while bounding both shared rotation wait sites.
  if (rotationInFlight && !(await waitForPriorRotation())) {
    divertFileRecord(line);
    return false;
  }
  if (!logStream) {
    logStream = openLogStream(logFilePath);
  }
  if (logStream && !(await checkAndRotateLog(Buffer.byteLength(line) + 1))) {
    divertFileRecord(line);
    return false;
  }
  if (sinkStalled()) {
    divertFileRecord(line);
    return false;
  }
  return true;
};

const writeToFile = async (line: string): Promise<void> => {
  if (!(await prepareFileSink(line))) {
    return;
  }
  // The watchdog may have fired while this record's preparation was settling.
  if (sinkStalled()) {
    divertFileRecord(line);
    return;
  }
  const stream = logStream;
  if (!stream) {
    // Existing unavailable-file degradation (#6179), distinct from a detected stall.
    if (logSink === "file") {
      await writeToStderr(line);
    }
    return;
  }
  try {
    await stallGuardForStream(stream).track((done) => {
      stream.write(line + "\n", done);
    });
  } catch (error) {
    // This record must survive a failed file write (#6179); both already writes it to stderr.
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
    try {
      process.stdout.write(`${line}\n`);
    } catch (error) {
      // A logger failure cannot be logged through the logger; configured sinks still receive this record.
      void error;
    }
  }
};

const writeToLogFile = async (level: string, message: string, args: any[]) => {
  if (testOverrides.logSinksDisabled?.()) {
    return;
  }
  try {
    const safeLogMessage = formatLogRecord(logFormat, ownLogPrefix, level, message, args).replace(
      /[\r\n\t]/g,
      " ",
    );
    // Start both configured writes before awaiting either one. A failed file
    // sink must not suppress the process-stream record in `both` mode.
    mirrorToLegacyStdout(safeLogMessage);
    await Promise.all([writeToFile(safeLogMessage), writeToConfiguredStderr(safeLogMessage)]);
  } catch (err) {
    await reportLogFailure("Failed to write log", err);
  }
};

// In stderr-only mode there is no file stream to rotate or close.
const closeCurrentLogStream = async (timer: Timer = defaultTimer): Promise<void> => {
  stopRotationWatchdog();
  if (logStream) {
    const closingStream = logStream;
    streamStallGuards.get(closingStream)?.suspend();
    // Late records must degrade until close confirms release of the old descriptor.
    logStream = undefined;
    deferReopenUntilClose(closingStream, timer);
    try {
      await closeLogStream(closingStream, timer);
    } finally {
      // Keep an unconfirmed close bounded even when the close attempt times out.
      deferReopenUntilClose(closingStream, timer);
    }
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
    stopRotationWatchdog();
    const closingStream = logStream;
    logStream = undefined;
    if (closingStream) {
      streamStallGuards.get(closingStream)?.suspend();
      deferReopenUntilClose(closingStream);
      closingStream.end();
    }
  },

  async closeAfterFlush(timer: Timer = defaultTimer): Promise<void> {
    // Intentional shutdown keeps its original drain timeout, without a stall diagnostic.
    intentionalDrainCount++;
    rotationWait?.guard.suspend();
    if (logStream) {
      streamStallGuards.get(logStream)?.suspend();
    }
    let timeoutHandle: NodeJS.Timeout | undefined;
    const deadline = new AbortController();
    try {
      timeoutHandle = timer.setTimeout(() => {
        stopRotationWatchdog(true);
        const stalledStream = logStream;
        if (stalledStream) {
          streamStallGuards.get(stalledStream)?.retire();
          logStream = undefined;
          deferReopenUntilClose(stalledStream, timer);
          stalledStream.destroy?.();
        }
        lastWrite = Promise.resolve();
        deadline.abort(
          toActionableError(
            new Error("Pending log writes stalled"),
            `Log writes did not flush within ${CLOSE_LOG_WRITES_TIMEOUT_MS}ms`,
          ),
        );
      }, CLOSE_LOG_WRITES_TIMEOUT_MS);
      await raceWithDeadline(lastWrite, {
        timer,
        signal: deadline.signal,
        label: "Log writes",
      });
    } finally {
      intentionalDrainCount--;
      if (timeoutHandle !== undefined) {
        timer.clearTimeout(timeoutHandle);
      }
    }
    await closeCurrentLogStream(timer);
  },
};

/**
 * Simple logger utility with different log levels
 */
import fs from "fs";
import path from "path";
import { statAsync, renameAsync } from "./io";
import { ensureSecureLogsDirSync } from "./tempDir";
import { pruneLogFiles } from "./logPruner";
import { resolveAutomobileLogFormat, resolveAutomobileLogSink } from "./loggingConfig";

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
let logStream = logFilePath ? fs.createWriteStream(logFilePath, { flags: "a" }) : undefined;

function fileLogPaths(): { dir: string; path: string } | undefined {
  if (!logsDir || !logFilePath) {
    return undefined;
  }
  return { dir: logsDir, path: logFilePath };
}

interface EndableLogStream {
  end(callback: () => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  off(event: "error", listener: (error: Error) => void): void;
}

/** Resolves when a log stream has finished, or rejects if closing it fails. */
export function closeLogStream(stream: EndableLogStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      stream.off("error", onError);
      reject(error);
    };
    stream.once("error", onError);
    stream.end(() => {
      stream.off("error", onError);
      resolve();
    });
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

// Remove old log files. Only ever deletes (a) this process's own rotated backups
// beyond the cap, and (b) other processes' logs that are stale by mtime — never
// another live process's current file. See logPruner.ts.
const pruneOldLogFiles = (): Promise<void> => {
  if (!logsDir) {
    return Promise.resolve();
  }
  return pruneLogFiles({
    dir: logsDir,
    ownPrefix: ownLogPrefix,
    maxOwnFiles: MAX_LOG_FILES,
    abandonedMaxAgeMs: ABANDONED_LOG_MAX_AGE_MS,
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

// Function to check log file size and rotate if necessary
const checkAndRotateLog = async (): Promise<void> => {
  const paths = fileLogPaths();
  if (!paths || !logStream) {
    return;
  }
  try {
    if (fs.existsSync(paths.path)) {
      const stats = await statAsync(paths.path);
      if (stats.size >= MAX_LOG_SIZE) {
        // Close current stream
        logStream?.end();

        // Create backup filename with timestamp, scoped to this process's PID so
        // rotation never collides with another process's files.
        const timestamp = new Date().toISOString().replace(/:/g, "-");
        const backupPath = path.join(paths.dir, `${ownLogPrefix}-${timestamp}.log`);

        // Check if file still exists right before rename to avoid race condition
        if (fs.existsSync(paths.path)) {
          // Rename current log file to backup
          await renameAsync(paths.path, backupPath);
        }

        // Always create a new log stream after rotation attempt
        logStream = fs.createWriteStream(paths.path, { flags: "a" });

        // Prune old log files to stay within the cap
        await pruneOldLogFiles();
      }
    }
  } catch (err) {
    // If rotation fails, ensure we have a valid log stream
    if (logStream?.destroyed || !logStream?.writable) {
      logStream = fs.createWriteStream(paths.path, { flags: "a" });
    }
    await reportLogFailure("Log rotation failed", err);
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
      // JSON can't represent non-finite numbers, so JSON.stringify coerces them
      // to `null` — which hid the offending value in daemon request logs (a
      // rejected `duration: Infinity` argument showed as `null`). Emit the marker
      // instead so the trace shows what the caller actually sent (#5854).
      if (typeof value === "number" && !Number.isFinite(value)) {
        return Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity";
      }
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
  if (!logStream) {
    return;
  }
  await checkAndRotateLog();
  const stream = logStream;
  if (!stream) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    stream.write(line + "\n", (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
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

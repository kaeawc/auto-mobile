/**
 * Simple logger utility with different log levels
 */
import fs from "fs";
import path from "path";
import { ensureDirExists, statAsync, renameAsync } from "./io";
import { getTempDir, TEMP_SUBDIRS } from "./tempDir";
import { pruneLogFiles } from "./logPruner";

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
   * Closes the log stream
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
  NONE: 4 as const
};

export type LogLevel = typeof LogLevel[keyof typeof LogLevel];

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
let currentLogLevel: LogLevel = parseAutomobileLogLevel(process.env.AUTOMOBILE_LOG_LEVEL) ?? LogLevel.INFO;

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

// Create logs directory if it doesn't exist. Use getTempDir so the location
// honors TMPDIR and matches the rest of the auto-mobile temp tree (rather than a
// hardcoded /tmp path that can diverge from where other processes look).
const logsDir = getTempDir(TEMP_SUBDIRS.LOGS);
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}
ensureDirExists(logsDir).catch(err => {
  console.error("Failed to create logs directory:", err);
});

// The daemon is single-owner, so keep its stable log name easy to document and
// tail. Stdio/client processes remain PID-scoped because several can run in
// parallel on the same host.
const ownLogPrefix = resolveProcessLogPrefix(process.argv, process.pid);
const logFilePath = path.join(logsDir, `${ownLogPrefix}.log`);
let logStream = fs.createWriteStream(logFilePath, { flags: "a" });

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
const pruneOldLogFiles = (): Promise<void> =>
  pruneLogFiles({
    dir: logsDir,
    ownPrefix: ownLogPrefix,
    maxOwnFiles: MAX_LOG_FILES,
    abandonedMaxAgeMs: ABANDONED_LOG_MAX_AGE_MS,
  });

// Sweep logs abandoned by already-exited processes once at startup. Short-lived
// agents exit with small logs and never reach the size-based rotation that would
// otherwise trigger a sweep, so without this their per-PID files would accumulate
// in the shared logs dir on a busy multi-agent host. Fire-and-forget so it never
// delays logger initialization; the sweep itself only removes dead-owner files.
pruneOldLogFiles().catch(() => { /* best-effort startup sweep */ });

// Function to check log file size and rotate if necessary
const checkAndRotateLog = async (): Promise<void> => {
  try {
    if (fs.existsSync(logFilePath)) {
      const stats = await statAsync(logFilePath);
      if (stats.size >= MAX_LOG_SIZE) {
        // Close current stream
        logStream.end();

        // Create backup filename with timestamp, scoped to this process's PID so
        // rotation never collides with another process's files.
        const timestamp = new Date().toISOString().replace(/:/g, "-");
        const backupPath = path.join(logsDir, `${ownLogPrefix}-${timestamp}.log`);

        // Check if file still exists right before rename to avoid race condition
        if (fs.existsSync(logFilePath)) {
          // Rename current log file to backup
          await renameAsync(logFilePath, backupPath);
        }

        // Always create a new log stream after rotation attempt
        logStream = fs.createWriteStream(logFilePath, { flags: "a" });

        // Prune old log files to stay within the cap
        await pruneOldLogFiles();
      }
    }
  } catch (err) {
    // If rotation fails, ensure we have a valid log stream
    if (logStream.destroyed || !logStream.writable) {
      logStream = fs.createWriteStream(logFilePath, { flags: "a" });
    }
    console.error("Log rotation failed:", err);
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

  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === "object" && value !== null) {
      // Filter sensitive environment-like keys
      const filtered: any = {};
      for (const [k, v] of Object.entries(value)) {
        if (!SENSITIVE_ENV_KEYS.has(k.toUpperCase())) {
          filtered[k] = v;
        }
      }
      return filtered;
    }
    return value;
  });
};

// Function to sanitize log message to prevent log injection
const sanitizeMessage = (message: string): string => {
  return message.replace(/[\r\n\t]/g, " ");
};

// Exported for unit tests that pin the redaction / injection-sanitizing contract.
export { SENSITIVE_ENV_KEYS, safeStringify, sanitizeMessage };

// Function to write to log file
const writeToLogFile = async (level: string, message: string, args: any[]) => {
  try {
    // Check and rotate log if needed before writing
    await checkAndRotateLog();

    const timestamp = new Date().toISOString();
    const sanitizedMessage = sanitizeMessage(message);
    let logMessage = `${timestamp} [${level}] ${sanitizedMessage}`;

    if (args.length > 0) {
      // Handle objects by converting them to strings, filtering sensitive data
      const argsStr = args.map(arg => {
        if (typeof arg === "object") {
          return sanitizeMessage(safeStringify(arg));
        }
        return sanitizeMessage(String(arg));
      }).join(" ");
      logMessage += ` ${argsStr}`;
    }
    if (logMessage.length > 1000) {
      logMessage = logMessage.substring(0, 1000) + "... (truncated)";
    }
    const safeLogMessage = logMessage.replace(/[\r\n\t]/g, " ");
    logStream.write(safeLogMessage + "\n");

    // Also write to STDOUT if enabled
    if (logToStdout) {
      process.stdout.write(`${safeLogMessage}\n`);
    }
  } catch (err) {
    console.error("Failed to write log:", err);
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
    logToStdout = true;
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
      trackWrite(writeToLogFile("DEBUG", message, args).catch(err => {
        console.error("Failed to write debug log:", err);
      }));
    }
  },

  /**
   * Logs an info message
   */
  info(message: string, ...args: any[]): void {
    if (currentLogLevel <= LogLevel.INFO) {
      trackWrite(writeToLogFile("INFO", message, args).catch(err => {
        console.error("Failed to write info log:", err);
      }));
    }
  },

  /**
   * Logs a warning message
   */
  warn(message: string, ...args: any[]): void {
    if (currentLogLevel <= LogLevel.WARN) {
      trackWrite(writeToLogFile("WARN", message, args).catch(err => {
        console.error("Failed to write warn log:", err);
      }));
    }
  },

  /**
   * Logs an error message
   */
  error(message: string, ...args: any[]): void {
    if (currentLogLevel <= LogLevel.ERROR) {
      trackWrite(writeToLogFile("ERROR", message, args).catch(err => {
        console.error("Failed to write error log:", err);
      }));
    }
  },

  /**
   * Awaits any in-flight fire-and-forget log writes. See interface docs.
   */
  async flush(): Promise<void> {
    await lastWrite;
  },

  /**
   * Closes the log stream
   */
  close(): void {
    logStream.end();
  },

  async closeAfterFlush(): Promise<void> {
    await lastWrite;
    await closeLogStream(logStream);
  }
};

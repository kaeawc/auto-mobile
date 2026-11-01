import type { LogFormat } from "./loggingConfig";
import { Timer } from "./SystemTimer";

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
  closeAfterFlush(timer?: Timer): Promise<void>;
}

export const LogLevel = {
  DEBUG: 0 as const,
  INFO: 1 as const,
  WARN: 2 as const,
  ERROR: 3 as const,
  NONE: 4 as const,
};

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

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

// Sensitive environment variable keys to filter from logs
export const SENSITIVE_ENV_KEYS = new Set([
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
export const safeStringify = (obj: any): string => {
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
export const sanitizeMessage = (message: string): string => {
  return message.replace(/[\r\n\t]/g, " ");
};

// Function to write to log file
export const formatLogRecord = (
  logFormat: LogFormat,
  ownLogPrefix: string,
  level: string,
  { message, args }: { message: string; args: any[] },
): string => {
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

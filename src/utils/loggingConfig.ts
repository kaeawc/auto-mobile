import fs from "node:fs";

/** The writable sink surface used by the logger, independent of file descriptors. */
export interface LogStream {
  /** True only after descriptor release; optional for sinks without descriptors. */
  readonly closed?: boolean;
  readonly destroyed: boolean;
  readonly writable: boolean;
  on(event: "error", listener: (error: Error) => void): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "close", listener: () => void): void;
  off(event: "error", listener: (error: Error) => void): void;
  off(event: "close", listener: () => void): void;
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
  end(callback?: () => void): void;
  /** Nudge a stalled descriptor toward release after an error or close timeout. */
  destroy?(error?: Error): void;
}

/** Shared across fresh logger imports so sink creation remains injectable. */
export const logStreamFactory = {
  create(target: string, options: { flags: "a" }): LogStream {
    return fs.createWriteStream(target, options);
  },
};

import { ENV, readEnvRaw } from "../config/env";
export type LogFormat = "text" | "json";
export type LogSink = "file" | "stderr" | "both";

export function parseAutomobileLogFormat(value: string | undefined): LogFormat | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "text" || normalized === "json" ? normalized : null;
}

export function parseAutomobileLogSink(value: string | undefined): LogSink | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "file" || normalized === "stderr" || normalized === "both"
    ? normalized
    : null;
}

export function resolveAutomobileLogFormat(
  environment: NodeJS.ProcessEnv = process.env,
): LogFormat {
  return parseAutomobileLogFormat(readEnvRaw(ENV.LOG_FORMAT, environment)) ?? "text";
}

export function resolveAutomobileLogSink(environment: NodeJS.ProcessEnv = process.env): LogSink {
  return parseAutomobileLogSink(readEnvRaw(ENV.LOG_SINK, environment)) ?? "file";
}

function emergencyMessage(message: string, error: unknown | undefined): string {
  if (error === undefined) {
    return message;
  }
  try {
    return `${message}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  } catch (error) {
    // A throwing custom error formatter must not prevent reporting the fatal event.
    void error;
    return message;
  }
}

/**
 * Writes a final process diagnostic before the full logger is initialized.
 * JSON mode deliberately bypasses console.error so every emitted stderr line
 * remains an independent NDJSON record.
 */
export function writeEmergencyLog(message: string, error?: unknown): void {
  const formattedMessage = emergencyMessage(message, error);
  if (resolveAutomobileLogFormat() === "json") {
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        component: "process",
        event: "log.emergency",
        message: formattedMessage,
      })}\n`,
    );
    return;
  }
  process.stderr.write(`${formattedMessage}\n`);
}

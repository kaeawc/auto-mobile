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
  return (
    parseAutomobileLogFormat(
      environment.AUTOMOBILE_LOG_FORMAT ?? environment.AUTO_MOBILE_LOG_FORMAT,
    ) ?? "text"
  );
}

export function resolveAutomobileLogSink(environment: NodeJS.ProcessEnv = process.env): LogSink {
  return (
    parseAutomobileLogSink(environment.AUTOMOBILE_LOG_SINK ?? environment.AUTO_MOBILE_LOG_SINK) ??
    "file"
  );
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
    process.stderr.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      component: "process",
      event: "log.emergency",
      message: formattedMessage,
    })}\n`);
    return;
  }
  process.stderr.write(`${formattedMessage}\n`);
}

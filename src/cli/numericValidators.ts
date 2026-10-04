export interface ParseLogger {
  warn(message: string): void;
}

export function parsePort(value: string | undefined, log: ParseLogger): number | undefined {
  const port = parseInt(value ?? "", 10);
  if (!isNaN(port) && port > 0 && port < 65536) {
    return port;
  }
  log.warn(`Invalid port: ${value}`);
  return undefined;
}

export function parsePositiveNumber(
  value: string | undefined,
  label: string,
  allowFloat: boolean,
  log: ParseLogger,
): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = allowFloat ? Number(value) : parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn(`Invalid ${label}: ${value}`);
    return undefined;
  }
  return allowFloat ? parsed : Math.round(parsed);
}

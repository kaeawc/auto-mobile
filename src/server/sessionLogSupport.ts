import { type SessionLogFileOutcome, type SessionLogSourceOutcome } from "./sessionLogContract";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { SessionLogTimeoutError } from "./SessionLogTimeoutError";
import { ActionableError } from "../models";
import { decodeUtf8Text } from "./appFileSupport";

export function unavailable<T>(reason: string): SessionLogSourceOutcome<T> {
  return { status: "unavailable", reason };
}

export async function runSource<T extends object>(
  label: string,
  read: () => Promise<T>,
): Promise<SessionLogSourceOutcome<T>> {
  try {
    return { status: "ok", ...(await read()) };
  } catch (error) {
    const reason = errorMessage(error);
    logger.warn(`[SessionLogService] ${label} source failed: ${reason}`, error);
    if (error instanceof SessionLogTimeoutError) {
      return { status: "timedOut", reason };
    }
    if (
      error instanceof ActionableError &&
      /not supported|only supported|not available/i.test(reason)
    ) {
      return { status: "unavailable", reason };
    }
    return { status: "failed", reason };
  }
}

export function boundedContent(
  buffer: Buffer,
  byteCount: number,
  maxBytes: number,
): Pick<SessionLogFileOutcome, "byteCount" | "truncated" | "text" | "blob"> {
  const bounded = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
  const text = decodeUtf8Text(bounded);
  return {
    byteCount,
    truncated: byteCount > bounded.byteLength,
    ...(text === undefined ? { blob: bounded.toString("base64") } : { text }),
  };
}

export function failedPath(
  path: string,
  error: unknown,
): { path: string; status: "failed"; reason: string } {
  return { path, status: "failed", reason: errorMessage(error) };
}

/** Same rotation convention as Android's `Log`/logback rotators: `<name>`, `<name>.1`, `<name>.2`, … */
export function isRotatedSibling(name: string, base: string): boolean {
  return name.startsWith(`${base}.`) && /^\d+$/.test(name.slice(base.length + 1));
}

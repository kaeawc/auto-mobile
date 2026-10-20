import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";

export interface AdbMissingDeviceEvent {
  deviceId: string;
  message: string;
}

const ADB_DEVICE_OFFLINE_OUTCOME_CODE = "adb_device_offline";

/** ADB still knows the serial, but cannot currently execute commands on it. */
export class AdbDeviceOfflineError extends Error {
  readonly code = ADB_DEVICE_OFFLINE_OUTCOME_CODE;
  readonly retryable = true;

  constructor(
    readonly deviceId: string,
    message: string,
  ) {
    super(message);
    this.name = "AdbDeviceOfflineError";
  }
}

type AdbMissingDeviceListener = (event: AdbMissingDeviceEvent) => void;

const missingDeviceListeners = new Set<AdbMissingDeviceListener>();

export function extractAdbMissingDeviceId(error: unknown): string | null {
  const message = errorMessage(error);
  const match = message.match(/\bdevice\s+'([^']+)'\s+not found\b/i);
  return match?.[1] ?? null;
}

export function isAdbMissingDeviceError(
  error: unknown,
  expectedDeviceId?: string,
  expectedTransportId?: string,
): boolean {
  const missingDeviceId = extractAdbMissingDeviceId(error);
  if (missingDeviceId) {
    return (
      !expectedDeviceId ||
      missingDeviceId === expectedDeviceId ||
      missingDeviceId === expectedTransportId
    );
  }

  if (expectedDeviceId) {
    return false;
  }

  const message = errorMessage(error).toLowerCase();
  return message.includes("device not found") || message.includes("no devices");
}

export function isAdbDeviceOfflineError(error: unknown): boolean {
  return /\bdevice(?:\s+is)?\s+offline\b/i.test(errorMessage(error));
}

/** Match only complete adb stderr diagnostics, never argv or remote stdout. */
export function isAdbPostDispatchTransportError(
  stderr: string,
  exitCode: number | undefined,
  expectedDeviceId: string,
  expectedTransportId?: string,
): boolean {
  const lines = stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length === 0) {
    // adb shell uses 255 for a lost transport without a diagnostic as well.
    return exitCode === 255;
  }
  return lines.every((line) => {
    let diagnostic = line.trim().replace(/^adb:\s*/i, "");
    const device = diagnostic.match(/^device\s+'([^']+)'\s*:\s*/i);
    if (device) {
      if (device[1] !== expectedDeviceId && device[1] !== expectedTransportId) {
        return false;
      }
      diagnostic = diagnostic.slice(device[0].length);
    }
    return /^(?:(?:error:\s*)?(?:connection terminated|protocol fault)\b[^\r\n]*|error:\s*closed)$/i.test(
      diagnostic,
    );
  });
}

export function notifyAdbMissingDevice(deviceId: string, error: unknown): void {
  const message = errorMessage(error);
  for (const listener of missingDeviceListeners) {
    try {
      listener({ deviceId, message });
    } catch (listenerError) {
      logger.warn(`[ADB] Missing-device listener failed for ${deviceId}: ${listenerError}`);
    }
  }
}

export function onAdbMissingDevice(listener: AdbMissingDeviceListener): () => void {
  missingDeviceListeners.add(listener);
  return () => {
    missingDeviceListeners.delete(listener);
  };
}

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

/**
 * A freshly booted device still completing the adb key handshake ("device still authorizing").
 * It clears on its own, unlike "unauthorized", which needs the user to accept the key.
 */
export function isAdbDeviceAuthorizingError(error: unknown): boolean {
  return /\bdevice\s+still\s+authorizing\b/i.test(errorMessage(error));
}

/**
 * Match complete transport diagnostics in stderr, never argv or stdout wording.
 * With shell protocol v2, remote stderr shares the stream with adb's stderr,
 * so wording matches are best-effort. Keep explicit wording independent of
 * stdout: a command can emit output before its transport is lost.
 */
export function isAdbPostDispatchTransportError(
  stderr: string,
  exitCode: number | undefined,
  expectedDeviceId: string,
  { expectedTransportId, stdout = "" }: { expectedTransportId?: string; stdout?: string } = {},
): boolean {
  const lines = stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (lines.length === 0) {
    // adb shell also propagates remote exit -1 as 255; remote handlers may
    // report their command error only on stdout. Bare 255 needs both empty.
    return exitCode === 255 && stdout.trim() === "";
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

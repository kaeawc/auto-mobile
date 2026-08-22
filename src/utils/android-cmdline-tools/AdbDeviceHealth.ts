import { errorMessage } from "../describeUnknownError";
import { logger } from "../logger";

export interface AdbMissingDeviceEvent {
  deviceId: string;
  message: string;
}

type AdbMissingDeviceListener = (event: AdbMissingDeviceEvent) => void;

const missingDeviceListeners = new Set<AdbMissingDeviceListener>();

export function extractAdbMissingDeviceId(error: unknown): string | null {
  const message = errorMessage(error);
  const match = message.match(/\bdevice\s+'([^']+)'\s+not found\b/i);
  return match?.[1] ?? null;
}

export function isAdbMissingDeviceError(error: unknown, expectedDeviceId?: string): boolean {
  const missingDeviceId = extractAdbMissingDeviceId(error);
  if (missingDeviceId) {
    return !expectedDeviceId || missingDeviceId === expectedDeviceId;
  }

  if (expectedDeviceId) {
    return false;
  }

  const message = (errorMessage(error)).toLowerCase();
  return message.includes("device not found") || message.includes("no devices");
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

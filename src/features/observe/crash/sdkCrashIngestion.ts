import type { AnrEvent, CrashDeviceInfo, CrashEvent } from "../../../utils/interfaces/CrashMonitor";

export interface SdkCrashPayload {
  timestamp: number;
  exceptionClass: string;
  message?: string;
  stackTrace: string;
  threadName: string;
  currentScreen?: string;
  packageName: string;
  appVersion?: string;
  deviceInfo: CrashDeviceInfo;
}

export interface SdkAnrPayload {
  timestamp: number;
  pid: number;
  processName: string;
  importance: string;
  trace?: string;
  reason: string;
  packageName?: string;
  appVersion?: string;
  deviceInfo: CrashDeviceInfo;
}

// Android sends timestamps on the envelope; accept event timestamps from future SDKs too.
export type SdkCrashWirePayload = Omit<SdkCrashPayload, "timestamp"> & { timestamp?: number };
export type SdkAnrWirePayload = Omit<SdkAnrPayload, "timestamp"> & { timestamp?: number };

export function withResolvedTimestamp<T extends { timestamp?: unknown }>(
  event: T,
  envelopeTimestamp: unknown,
  nowMs: number,
): Omit<T, "timestamp"> & { timestamp: number } {
  const timestamp =
    typeof event.timestamp === "number" && Number.isFinite(event.timestamp)
      ? event.timestamp
      : typeof envelopeTimestamp === "number" && Number.isFinite(envelopeTimestamp)
        ? envelopeTimestamp
        : nowMs;
  return { ...event, timestamp };
}

export function normalizeCrash(payload: SdkCrashPayload, deviceId: string): CrashEvent {
  return {
    deviceId,
    packageName: payload.packageName,
    crashType: "java",
    detectionSource: "sdk_websocket",
    timestamp: payload.timestamp,
    threadName: payload.threadName,
    exceptionClass: payload.exceptionClass,
    exceptionMessage: payload.message,
    stacktrace: payload.stackTrace,
    currentScreen: payload.currentScreen,
    appVersion: payload.appVersion,
    deviceInfo: payload.deviceInfo,
  };
}

export function normalizeAnr(payload: SdkAnrPayload, deviceId: string): AnrEvent {
  return {
    deviceId,
    packageName: payload.packageName ?? payload.processName,
    detectionSource: "sdk_websocket",
    timestamp: payload.timestamp,
    processName: payload.processName,
    pid: payload.pid,
    reason: payload.reason,
    stacktrace: payload.trace,
    importance: payload.importance,
    appVersion: payload.appVersion,
    deviceInfo: payload.deviceInfo,
  };
}

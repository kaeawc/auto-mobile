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

/**
 * Crash/ANR event shapes persisted from the on-device AutoMobile SDK over the
 * accessibility-service WebSocket. The SDK is the sole detection source —
 * host-side detectors (logcat, tombstone, dropbox, etc.) are out of scope
 * because they require streaming/polling ADB calls that don't behave well
 * over high-latency connections.
 */

/**
 * Device metadata captured at crash/ANR time by the on-device SDK.
 */
export interface CrashDeviceInfo {
  model: string;
  manufacturer: string;
  osVersion: string;
  sdkInt: number;
}

/**
 * Normalized crash event written to the failure repository.
 */
export interface CrashEvent {
  deviceId: string;
  packageName: string;
  crashType: "java";
  detectionSource: "sdk_websocket";
  timestamp: number;
  processName?: string;
  pid?: number;
  exceptionClass?: string;
  exceptionMessage?: string;
  stacktrace?: string;
  threadName?: string;
  currentScreen?: string;
  appVersion?: string;
  deviceInfo?: CrashDeviceInfo;
  navigationNodeId?: number;
  testExecutionId?: number;
  sessionUuid?: string;
  rawLog?: string;
}

/**
 * Normalized ANR event written to the failure repository.
 */
export interface AnrEvent {
  deviceId: string;
  packageName: string;
  detectionSource: "sdk_websocket";
  timestamp: number;
  processName?: string;
  pid?: number;
  reason?: string;
  activity?: string;
  waitDurationMs?: number;
  cpuUsage?: string;
  mainThreadState?: string;
  stacktrace?: string;
  importance?: string;
  currentScreen?: string;
  appVersion?: string;
  deviceInfo?: CrashDeviceInfo;
  navigationNodeId?: number;
  testExecutionId?: number;
  sessionUuid?: string;
  rawLog?: string;
}

/**
 * Minimal persistence surface for crash/ANR events. FailureEventRepository
 * satisfies this structurally.
 */
export interface CrashEventSink {
  saveCrash(event: CrashEvent): Promise<number>;
  saveAnr(event: AnrEvent): Promise<number>;
}

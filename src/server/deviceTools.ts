import type { ChildProcess } from "child_process";
import { z } from "zod";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import {
  type BootedDeviceDiscovery,
  MultiPlatformDeviceManager,
  PlatformDeviceManager,
} from "../utils/deviceUtils";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ActionableError, BootedDevice, DeviceInfo, SomePlatform } from "../models";
import type { FormFactor, StartDeviceResult } from "../models/DeviceMatchCriteria";
import { BOOTED_DEVICE_RESOURCE_URIS, notifyBootedDeviceResourcesUpdated } from "./bootedDeviceResources";
import { DEVICE_IMAGE_RESOURCE_URIS, notifyDeviceImageResourcesUpdated } from "./deviceImageResources";
import { syncInstalledAppResources } from "./appResources";
import { listActiveVideoRecordings, stopVideoRecording } from "./videoRecordingManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { getPerformanceMonitor } from "../features/performance/PerformanceMonitor";
import { platformSchema } from "./toolSchemaHelpers";
import { DefaultDeviceMatcher, type DeviceMatcher } from "../utils/deviceMatcher";
import { DEVICE_POOL_MATCHING, isDevicePoolAutolockEnabled } from "../daemon/poolConfig";
import { DEVICE_CREATE_ENV_VAR, getDeviceCreationGate, type DeviceCreationGate } from "../utils/deviceCreationGate";
import { createDefaultDeviceProvisioner, type DeviceProvisioner } from "../utils/deviceProvisioning";
import { DaemonState } from "../daemon/daemonState";
import type { DevicePool, PooledDevice } from "../daemon/devicePool";
import type { SessionManager } from "../daemon/sessionManager";
import { DeviceBootService, type DeviceBootResult } from "../utils/deviceBootService";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { isAdbMissingDeviceError } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { executionTracker } from "./executionTracker";
import {
  createDefaultRunnerReadinessService,
  type RunnerReadinessRequest,
} from "../utils/RunnerReadinessService";
import {
  MAX_RUNNER_READINESS_TIMEOUT_MS,
  MIN_RUNNER_READINESS_TIMEOUT_MS,
} from "../utils/runnerReadinessConfig";
import { serverConfig } from "../utils/ServerConfig";
import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../utils/deviceTimeouts";

// Schema definitions
export const listDeviceImagesSchema = z.object({
  platform: platformSchema
});

export const listDevicesSchema = z.object({
  platform: platformSchema.optional()
});

const startDeviceParametersSchema = z.object({
  platform: platformSchema,
  minOsVersion: z.string().optional().describe("Minimum OS version, inclusive (e.g., '14', '17.2')"),
  maxOsVersion: z.string().optional().describe("Maximum OS version, inclusive (e.g., '15', '18.0')"),
  name: z.string().optional().describe("Device name to match (e.g., 'iPhone 16e', 'Pixel_9_Pro')"),
  formFactor: z.enum(["phone", "tablet"]).optional().describe("Device form factor"),
  screenSize: z.object({
    width: z.number().describe("Screen width in pixels"),
    height: z.number().describe("Screen height in pixels"),
  }).optional().describe("Desired screen dimensions"),
  deviceId: z.string().optional(),
  preferRunning: z.boolean().optional().describe("Prefer already-booted device (default true)"),
  timeoutMs: z.number()
    .int()
    .positive()
    .max(MAX_DEVICE_READY_TIMEOUT_MS)
    .optional()
    .describe("Total device boot and automation-readiness timeout in ms"),
  runnerReadinessTimeoutMs: z.number()
    .int()
    .min(MIN_RUNNER_READINESS_TIMEOUT_MS)
    .max(MAX_RUNNER_READINESS_TIMEOUT_MS)
    .optional()
    .describe(
      "Runner-readiness budget in ms within timeoutMs; overrides the shared timeout " +
      `(${MIN_RUNNER_READINESS_TIMEOUT_MS}-${MAX_RUNNER_READINESS_TIMEOUT_MS})`
    ),
  createIfMissing: z.boolean().optional().describe(
    `Create a device when nothing matches (CLI: --create-if-missing). Default off; ` +
    `${DEVICE_CREATE_ENV_VAR}=1 enables it when this flag is not supplied, and the flag wins.`
  ),
});

export const startDeviceSchema = z.preprocess(input => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }

  const parsed = input as Record<string, unknown>;
  const legacyDevice = parsed.device;
  if (!legacyDevice || typeof legacyDevice !== "object" || Array.isArray(legacyDevice)) {
    return input;
  }

  // Accept both the legacy { device: {...} } payload and the new top-level shape.
  // Top-level fields win so mixed callers can override nested values intentionally.
  return {
    ...legacyDevice as Record<string, unknown>,
    ...parsed,
  };
}, startDeviceParametersSchema);

export const killDeviceSchema = z.object({
  device: z.object({
    name: z.string().describe("Device image name"),
    deviceId: z.string(),
    platform: platformSchema,
    transportId: z.string().optional(),
  })
});

export const DEVICE_ALREADY_STOPPED_ERROR_CODE = "device_already_stopped";

// A successful platform shutdown command only confirms that the request was
// accepted. Keep the public killDevice result coupled to the observable device
// lifecycle, while bounding the wait so a wedged platform command is actionable.
const DEVICE_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEVICE_SHUTDOWN_POLL_INTERVAL_MS = 1_000;
const DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS = 1_000;

function isAlreadyStoppedDeviceError(
  platform: SomePlatform,
  deviceId: string,
  error: unknown,
): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (platform === "android") {
    return (
      (message.includes("not running") && message.includes("emulator")) ||
      isAdbMissingDeviceError(error, deviceId)
    );
  }
  if (platform === "ios") {
    return (
      message.includes("already shut down") ||
      message.includes("already shutdown") ||
      message.includes("not booted") ||
      message.includes("invalid device state") ||
      message.includes("current state: shutdown")
    );
  }
  return false;
}

function createToolErrorResponse(code: string, message: string) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({ success: false, message, error: { code, message } }),
    }],
  };
}

function createKillDeviceResponse(
  args: KillDeviceArgs,
  timing: unknown,
  alreadyStoppedMessage?: string,
) {
  if (alreadyStoppedMessage !== undefined) {
    return createToolErrorResponse(
      DEVICE_ALREADY_STOPPED_ERROR_CODE,
      alreadyStoppedMessage,
    );
  }

  return createJSONToolResponse({
    message: `${args.device.platform} '${args.device.name}' shutdown successfully`,
    udid: args.device.deviceId,
    name: args.device.name,
    timing,
    platform: args.device.platform
  });
}

// Export interfaces for type safety
export interface StartDeviceArgs {
  platform: "android" | "ios";
  minOsVersion?: string;
  maxOsVersion?: string;
  name?: string;
  formFactor?: FormFactor;
  screenSize?: { width: number; height: number };
  deviceId?: string;
  preferRunning?: boolean;
  timeoutMs?: number;
  runnerReadinessTimeoutMs?: number;
  createIfMissing?: boolean;
  __mcpSessionId?: string;
}

export interface KillDeviceArgs {
  device: BootedDevice;
}

export interface ListDeviceImagesArgs {
  platform: SomePlatform;
}

export interface ListDevicesArgs {
  platform?: "android" | "ios";
}

export interface DeviceToolsDependencies {
  deviceManagerFactory: () => PlatformDeviceManager;
  deviceMatcherFactory: () => DeviceMatcher;
  notifyResourcesChanged: () => Promise<void>;
  ensureCtrlProxyReady?: (request: RunnerReadinessRequest) => Promise<void>;
  deviceCreationGateFactory: () => DeviceCreationGate;
  deviceProvisionerFactory: () => DeviceProvisioner;
  clearInstalledAppsForDevice: (deviceId: string) => Promise<void>;
  stopPerformanceMonitoring: (deviceId: string) => void;
  idGenerator: IdGenerator;
  timer: Timer;
}

async function defaultNotifyResourcesChanged(): Promise<void> {
  await notifyBootedDeviceResourcesUpdated();
  await notifyDeviceImageResourcesUpdated();
  await syncInstalledAppResources();
}

async function defaultClearInstalledAppsForDevice(deviceId: string): Promise<void> {
  const { InstalledAppsRepository } = await import("../db/installedAppsRepository");
  const repo = new InstalledAppsRepository();
  await getInstalledAppsCacheWriteCoordinator().invalidate(deviceId, () =>
    getDbWriteBarrier().track(() => repo.clearDeviceSession(deviceId)).then(() => undefined)
  );
}

async function clearInstalledAppsAfterShutdown(
  dependencies: DeviceToolsDependencies,
  deviceId: string
): Promise<void> {
  try {
    await dependencies.clearInstalledAppsForDevice(deviceId);
  } catch (error) {
    // The device is already stopped; the next app verification refreshes stale cache rows.
    logger.warn(
      `[DeviceTools] Failed to clear installed apps for ${deviceId} after shutdown: ${error}`,
      error
    );
  }
}

async function notifyResourcesAfterShutdown(dependencies: DeviceToolsDependencies): Promise<void> {
  try {
    await dependencies.notifyResourcesChanged();
  } catch (error) {
    // The device is already stopped; resource subscriptions refresh on their next update.
    logger.warn(`[DeviceTools] Failed to notify resource changes after shutdown: ${error}`, error);
  }
}

interface ShutdownDeadlineContext {
  device: BootedDevice;
  timer: Timer;
  deadlineMs: number;
  requestAbortSignal: AbortSignal | undefined;
  retainReservationUntil?: (operation: Promise<unknown>, releaseAfterFailure?: boolean) => void;
}

function shouldPropagateShutdownPreparationError(
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return isShutdownTimeoutError(error) || requestAbortSignal?.aborted === true;
}

async function stopVideoRecordingBeforeShutdown(
  recordingId: string,
  context: ShutdownDeadlineContext,
): Promise<void> {
  try {
    await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "video recording teardown did not complete",
      context.requestAbortSignal,
      async () => await stopVideoRecording(recordingId),
    );
  } catch (error) {
    if (shouldPropagateShutdownPreparationError(error, context.requestAbortSignal)) {
      throw error;
    }
    logger.warn(
      `[DeviceTools] Failed to stop recording ${recordingId} before shutdown: ${error}`
    );
  }
}

async function stopVideoRecordingsBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
): Promise<void> {
  perf.startOperation("stopRecordings");
  try {
    const activeRecordings = await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "recording discovery did not complete",
      context.requestAbortSignal,
      async () => await listActiveVideoRecordings({
        deviceId: context.device.deviceId,
        platform: context.device.platform,
      }),
    );
    for (const recording of activeRecordings) {
      await stopVideoRecordingBeforeShutdown(recording.recordingId, context);
    }
  } finally {
    perf.endOperation("stopRecordings");
  }
}

async function stopIosCtrlProxyBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
): Promise<void> {
  if (context.device.platform !== "ios") {
    return;
  }
  let stop: Promise<void> | undefined;
  perf.startOperation("stopCtrlProxy");
  try {
    const xcTestManager = IOSCtrlProxyManager.getInstance({
      name: context.device.name,
      platform: "ios",
      deviceId: context.device.deviceId,
      source: "local",
    });
    stop = xcTestManager.stop();
    await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "iOS CtrlProxy shutdown did not complete",
      context.requestAbortSignal,
      async () => await stop,
    );
  } catch (error) {
    if (shouldPropagateShutdownPreparationError(error, context.requestAbortSignal)) {
      if (stop) {
        // CtrlProxy shutdown mutates process state after its caller stops waiting.
        // Keep this device unavailable until it settles, but release it after a
        // failed pre-kill teardown because the platform was never shut down.
        context.retainReservationUntil?.(stop, true);
      }
      throw error;
    }
    logger.warn(`[DeviceTools] Failed to stop CtrlProxy iOS before kill: ${error}`);
  } finally {
    perf.endOperation("stopCtrlProxy");
  }
}

function shutdownTimeoutError(device: BootedDevice, detail: string): ActionableError {
  return new ActionableError(
    `Timed out waiting for ${device.platform} device '${device.name}' (${device.deviceId}) ` +
    `to disappear after ${DEVICE_SHUTDOWN_TIMEOUT_MS}ms: ${detail}. ` +
    "Verify the platform shutdown state and retry.",
  );
}

function isShutdownTimeoutError(error: unknown): error is ActionableError {
  return error instanceof ActionableError && String(error.message).startsWith("Timed out waiting for");
}

function shouldClearIntentionalShutdownAfterFailure(
  platform: SomePlatform,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return platform === "android" && !requestAbortSignal?.aborted;
}

function shouldKeepIntentionalShutdownAfterCommandError(
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return requestAbortSignal?.aborted === true || isShutdownTimeoutError(error);
}

function handleShutdownCommandError(
  device: BootedDevice,
  error: unknown,
  devicePool: DevicePool | undefined,
  requestAbortSignal: AbortSignal | undefined,
): string | undefined {
  if (isAlreadyStoppedDeviceError(device.platform, device.deviceId, error)) {
    return `Failed to kill ${device.platform} device: ${error}`;
  }
  if (!shouldKeepIntentionalShutdownAfterCommandError(error, requestAbortSignal)) {
    devicePool?.clearIntentionalShutdown(device.deviceId);
  }
  throw error;
}

function abortPromise(signal: AbortSignal | undefined): {
  promise: Promise<never> | undefined;
  cleanup: () => void;
} {
  if (!signal) {
    return { promise: undefined, cleanup: () => undefined };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Operation cancelled"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

async function runWithinShutdownDeadline<T>(
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  detail: string,
  requestAbortSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
): Promise<T> {
  const remainingMs = deadlineMs - timer.now();
  if (remainingMs <= 0) {
    throw shutdownTimeoutError(device, detail);
  }
  const deadlineController = new AbortController();
  const signal = requestAbortSignal
    ? AbortSignal.any([requestAbortSignal, deadlineController.signal])
    : deadlineController.signal;
  let timeout: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = timer.setTimeout(() => {
      timedOut = true;
      deadlineController.abort();
      reject(shutdownTimeoutError(device, detail));
    }, remainingMs);
  });
  const requestAbort = abortPromise(requestAbortSignal);
  const operationPromise = runWithAbortSignal(signal, () => operation(signal, remainingMs)).catch(error => {
    if (timedOut) {
      throw shutdownTimeoutError(device, detail);
    }
    throw error;
  });
  // If the deadline wins while a platform command ignores abort, the race is
  // settled but the underlying promise remains observed rather than leaking an
  // unhandled rejection when it eventually completes.
  operationPromise.catch(() => undefined);
  try {
    return await Promise.race([
      operationPromise,
      timeoutPromise,
      ...(requestAbort.promise ? [requestAbort.promise] : []),
    ]);
  } finally {
    if (timeout) {
      timer.clearTimeout(timeout);
    }
    requestAbort.cleanup();
  }
}

async function getShutdownDiscovery(
  deviceManager: PlatformDeviceManager,
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
) {
  return await runWithinShutdownDeadline(
    device,
    timer,
    deadlineMs,
    "platform discovery did not complete",
    requestAbortSignal ?? getAbortSignal(),
    async () => await deviceManager.getBootedDevicesDetailed(device.platform, {
          bypassAndroidDeviceListCache: true,
        }),
  );
}

async function waitForDeviceShutdown(
  deviceManager: PlatformDeviceManager,
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
): Promise<BootedDevice | undefined> {
  let lastDiscoveryDetail = "platform discovery did not complete";
  for (;;) {
    if (timer.now() >= deadlineMs) {
      throw shutdownTimeoutError(device, lastDiscoveryDetail);
    }
    const discovery = await getShutdownDiscovery(
      deviceManager,
      device,
      timer,
      deadlineMs,
      requestAbortSignal,
    );
    const platformWasDiscovered = discovery.succeededPlatforms.has(device.platform);
    const matchingDevice = findDiscoveredDevice(discovery, device);
    if (platformWasDiscovered && !matchingDevice) {
      return undefined;
    }
    if (matchingDevice && !isSameBootedDeviceIdentity(device, matchingDevice)) {
      return matchingDevice;
    }

    lastDiscoveryDetail = platformWasDiscovered
      ? "the device is still reported as booted"
      : "platform discovery did not succeed";
    const remainingMs = deadlineMs - timer.now();
    if (remainingMs <= 0) {
      throw shutdownTimeoutError(device, lastDiscoveryDetail);
    }
    await timer.sleep(Math.min(DEVICE_SHUTDOWN_POLL_INTERVAL_MS, remainingMs));
  }
}

function isSameBootedDeviceIdentity(device: BootedDevice, candidate: BootedDevice): boolean {
  if (device.platform !== candidate.platform || device.deviceId !== candidate.deviceId) {
    return false;
  }
  if (device.platform === "android" && device.transportId !== undefined && candidate.transportId !== undefined) {
    return device.transportId === candidate.transportId;
  }
  return device.name === candidate.name;
}

function findDiscoveredDevice(
  discovery: BootedDeviceDiscovery,
  device: BootedDevice,
): BootedDevice | undefined {
  if (!discovery.succeededPlatforms.has(device.platform)) {
    return undefined;
  }
  return discovery.devices.find(candidate =>
    candidate.platform === device.platform && candidate.deviceId === device.deviceId,
  );
}

async function rebuildSameIdReplacement(
  device: BootedDevice,
  expectedPooledDevice: PooledDevice,
  replacement: BootedDevice,
  daemonState: DaemonState,
  stopPerformanceMonitoring: (deviceId: string) => void,
): Promise<void> {
  const devicePool = daemonState.getDevicePool();
  const rebuilt = await devicePool.replaceDeviceForShutdown(
    expectedPooledDevice,
    replacement,
    () => stopPerformanceMonitoring(device.deviceId),
  );
  if (!rebuilt) {
    return;
  }
  daemonState.getDeviceSessionRegistry().onDeviceConnected({
    deviceId: rebuilt.id,
    platform: rebuilt.platform,
    incarnation: rebuilt.incarnation,
  });
}

async function findReplacementAfterSessionRelease(
  deviceManager: PlatformDeviceManager,
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
): Promise<BootedDevice | undefined> {
  // The absence observation only proves the old incarnation was gone before
  // session release. A same-ID replacement can appear while that release
  // awaits persistence, so reserve a short, bounded recheck even after the
  // disappearance deadline was consumed.
  const recheckDeadlineMs = Math.max(
    deadlineMs,
    timer.now() + DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS,
  );
  const discovery = await getShutdownDiscovery(
    deviceManager,
    device,
    timer,
    recheckDeadlineMs,
    requestAbortSignal,
  );
  const replacement = findDiscoveredDevice(discovery, device);
  if (
    replacement &&
    (device.platform === "ios" || !isSameBootedDeviceIdentity(device, replacement))
  ) {
    return replacement;
  }
  if (!replacement && discovery.succeededPlatforms.has(device.platform)) {
    return undefined;
  }
  return await waitForDeviceShutdown(
    deviceManager,
    device,
    timer,
    recheckDeadlineMs,
    requestAbortSignal,
  );
}

function finishLateShutdownRetirement(
  release: Promise<string | null>,
  device: BootedDevice,
  expectedPooledDevice: PooledDevice,
  observedReplacement: BootedDevice | undefined,
  deviceManager: PlatformDeviceManager,
  timer: Timer,
  deadlineMs: number,
  stopPerformanceMonitoring: (deviceId: string) => void,
  retainReservationUntil: (retirement: Promise<void>) => void,
): void {
  const continueRetirement = async () => {
    await retireShutdownOwnership(
      device,
      expectedPooledDevice,
      observedReplacement,
      deviceManager,
      timer,
      deadlineMs,
      undefined,
      stopPerformanceMonitoring,
      () => undefined,
      false,
    );
  };
  const lateRetirement = release.then(continueRetirement, continueRetirement);
  lateRetirement.catch(lateError => {
    logger.warn(
      `[DeviceTools] Failed to finish late shutdown retirement for ${device.deviceId}: ${lateError}`,
    );
  });
  retainReservationUntil(lateRetirement);
}

function retainFailedShutdownRetirement(
  error: unknown,
  device: BootedDevice,
  expectedPooledDevice: PooledDevice,
  observedReplacement: BootedDevice | undefined,
  deviceManager: PlatformDeviceManager,
  timer: Timer,
  deadlineMs: number,
  stopPerformanceMonitoring: (deviceId: string) => void,
  retainReservationUntil: (retirement: Promise<void>) => void,
  retryAfterFailure: boolean,
): void {
  const retirement = retryAfterFailure
    ? timer.sleep(DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS).then(async () => {
      await retireShutdownOwnership(
        device,
        expectedPooledDevice,
        observedReplacement,
        deviceManager,
        timer,
        deadlineMs,
        undefined,
        stopPerformanceMonitoring,
        () => undefined,
        false,
      );
    })
    : Promise.reject(error);
  retirement.catch(lateError => {
    logger.warn(
      `[DeviceTools] Retaining shutdown reservation after retirement failed for ${device.deviceId}: ${lateError}`,
    );
  });
  retainReservationUntil(retirement);
}

async function findReplacementOrRetainShutdownReservation(
  device: BootedDevice,
  expectedPooledDevice: PooledDevice,
  observedReplacement: BootedDevice | undefined,
  deviceManager: PlatformDeviceManager,
  timer: Timer,
  deadlineMs: number,
  abortSignal: AbortSignal | undefined,
  stopPerformanceMonitoring: (deviceId: string) => void,
  retainReservationUntil: (retirement: Promise<void>) => void,
  retryAfterFailure: boolean,
): Promise<BootedDevice | undefined> {
  try {
    return observedReplacement ?? await findReplacementAfterSessionRelease(
      deviceManager,
      device,
      timer,
      deadlineMs,
      abortSignal,
    );
  } catch (error) {
    retainFailedShutdownRetirement(
      error,
      device,
      expectedPooledDevice,
      observedReplacement,
      deviceManager,
      timer,
      deadlineMs,
      stopPerformanceMonitoring,
      retainReservationUntil,
      retryAfterFailure,
    );
    throw error;
  }
}

function preserveLateShutdownRetirement(
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
  sessionManager: SessionManager,
  sessionId: string,
  release: Promise<string | null>,
  device: BootedDevice,
  expectedPooledDevice: PooledDevice,
  observedReplacement: BootedDevice | undefined,
  deviceManager: PlatformDeviceManager,
  timer: Timer,
  deadlineMs: number,
  stopPerformanceMonitoring: (deviceId: string) => void,
  retainReservationUntil: (retirement: Promise<void>) => void,
): void {
  if (
    !isShutdownTimeoutError(error) &&
    !requestAbortSignal?.aborted &&
    sessionManager.getSessionForDevice(device.deviceId) === sessionId
  ) {
    return;
  }
  // Session release removes its in-memory mapping before its durable write.
  // It cannot be cancelled safely, so keep the captured shutdown reservation
  // until the late release finishes its identity-guarded retirement. Otherwise
  // a stopped device could become an idle ghost.
  finishLateShutdownRetirement(
    release,
    device,
    expectedPooledDevice,
    observedReplacement,
    deviceManager,
    timer,
    deadlineMs,
    stopPerformanceMonitoring,
    retainReservationUntil,
  );
}

async function retireShutdownOwnership(
  device: BootedDevice,
  expectedPooledDevice: PooledDevice | null,
  observedReplacement: BootedDevice | undefined,
  deviceManager: PlatformDeviceManager,
  timer: Timer,
  deadlineMs: number,
  abortSignal: AbortSignal | undefined,
  stopPerformanceMonitoring: (deviceId: string) => void,
  retainReservationUntil: (retirement: Promise<void>) => void,
  retryAfterDiscoveryFailure: boolean = true,
): Promise<void> {
  if (!expectedPooledDevice) {
    return;
  }
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const devicePool = daemonState.getDevicePool();
  // A fast reboot can reuse a serial. Do not release or remove a later pool
  // incarnation that happens to use the same device ID.
  if (devicePool.getDevice(device.deviceId) !== expectedPooledDevice) {
    return;
  }

  const sessionManager = daemonState.getSessionManager();
  const sessionId = expectedPooledDevice.sessionId;
  if (sessionId && sessionManager.getSessionForDevice(device.deviceId) === sessionId) {
    const retirementDeadlineMs = Math.max(
      deadlineMs,
      timer.now() + DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS,
    );
    await executionTracker.cancelSessionUuidExecutions(
      sessionId,
      `device-disconnected:${device.deviceId}`,
      { excludeSignal: abortSignal },
    );
    const release = sessionManager.releaseSession(sessionId, `device-stopped:${device.deviceId}`);
    try {
      await runWithinShutdownDeadline(
        device,
        timer,
        retirementDeadlineMs,
        "session ownership retirement did not complete",
        abortSignal,
        async () => await release,
      );
    } catch (error) {
      preserveLateShutdownRetirement(
        error,
        abortSignal,
        sessionManager,
        sessionId,
        release,
        device,
        expectedPooledDevice,
        observedReplacement,
        deviceManager,
        timer,
        deadlineMs,
        stopPerformanceMonitoring,
        retainReservationUntil,
      );
      throw error;
    }
  }
  if (devicePool.getDevice(device.deviceId) !== expectedPooledDevice) {
    return;
  }

  // A same-ID replacement can boot while releasing the old session. If so,
  // retire only the captured incarnation, then immediately rediscover the
  // replacement so it owns a fresh pool and registry epoch. Once shutdown was
  // observed, a bounded post-release recheck protects against a replacement
  // that boots at the disappearance deadline.
  const replacement = await findReplacementOrRetainShutdownReservation(
    device,
    expectedPooledDevice,
    observedReplacement,
    deviceManager,
    timer,
    deadlineMs,
    abortSignal,
    stopPerformanceMonitoring,
    retainReservationUntil,
    retryAfterDiscoveryFailure,
  );
  if (replacement) {
    await rebuildSameIdReplacement(
      device,
      expectedPooledDevice,
      replacement,
      daemonState,
      stopPerformanceMonitoring,
    );
    return;
  }
  if (devicePool.getDevice(device.deviceId) !== expectedPooledDevice) {
    return;
  }
  if (await devicePool.retireDeviceForShutdown(expectedPooledDevice)) {
    stopPerformanceMonitoring(device.deviceId);
    daemonState.getDeviceSessionRegistry().onDeviceDisconnected(device.deviceId);
  }
}

async function killProcessAndRetireOwnership(
  dependencies: DeviceToolsDependencies,
  device: BootedDevice,
  perf: ReturnType<typeof createPerformanceTracker>,
  requestAbortSignal: AbortSignal | undefined,
  devicePool: DevicePool | undefined,
  expectedPooledDevice: PooledDevice | null,
  shutdownDeadlineMs: number,
  retainReservationUntil: (retirement: Promise<void>) => void,
): Promise<string | undefined> {
  const deviceManager = dependencies.deviceManagerFactory();
  if (device.platform === "android") {
    devicePool?.markIntentionalShutdown(device.deviceId);
  }

  let shutdownDevice = device;
  let alreadyStoppedMessage: string | undefined;
  perf.startOperation("killProcess");
  try {
    const killedDevice = await runWithinShutdownDeadline(
      device,
      dependencies.timer,
      shutdownDeadlineMs,
      "platform shutdown command did not complete",
      requestAbortSignal,
      async (signal, timeoutMs) => await deviceManager.killDevice(device, { signal, timeoutMs }),
    );
    shutdownDevice = killedDevice ?? device;
  } catch (error) {
    alreadyStoppedMessage = handleShutdownCommandError(device, error, devicePool, requestAbortSignal);
  }
  perf.endOperation("killProcess");

  if (alreadyStoppedMessage !== undefined) {
    return alreadyStoppedMessage;
  }

  let shutdownWasConfirmed = false;
  try {
    perf.startOperation("waitForShutdown");
    const observedReplacement = await waitForDeviceShutdown(
      deviceManager,
      shutdownDevice,
      dependencies.timer,
      shutdownDeadlineMs,
      requestAbortSignal,
    );
    perf.endOperation("waitForShutdown");
    shutdownWasConfirmed = true;

    perf.startOperation("retireOwnership");
    await retireShutdownOwnership(
      shutdownDevice,
      expectedPooledDevice,
      observedReplacement,
      deviceManager,
      dependencies.timer,
      shutdownDeadlineMs,
      requestAbortSignal,
      dependencies.stopPerformanceMonitoring,
      retainReservationUntil,
    );
    perf.endOperation("retireOwnership");
    return undefined;
  } catch (error) {
    // A failed disappearance confirmation leaves the original incarnation in
    // the pool. It must remain eligible for normal unexpected-loss recovery.
    // Caller cancellation is different: the platform command may already have
    // succeeded, so retain the marker for its later process-exit cleanup.
    if (
      !shutdownWasConfirmed &&
      shouldClearIntentionalShutdownAfterFailure(device.platform, requestAbortSignal)
    ) {
      devicePool?.clearIntentionalShutdown(device.deviceId);
    }
    throw error;
  }
}

let moduleDependencies: DeviceToolsDependencies | null = null;

function getDeviceToolsDependencies(): DeviceToolsDependencies {
  if (!moduleDependencies) {
    moduleDependencies = {
      deviceManagerFactory: () => new MultiPlatformDeviceManager(),
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      notifyResourcesChanged: defaultNotifyResourcesChanged,
      deviceCreationGateFactory: () => getDeviceCreationGate(),
      deviceProvisionerFactory: () => createDefaultDeviceProvisioner(),
      clearInstalledAppsForDevice: defaultClearInstalledAppsForDevice,
      stopPerformanceMonitoring: deviceId => getPerformanceMonitor().stopMonitoring(deviceId),
      idGenerator: defaultIdGenerator,
      timer: defaultTimer,
    };
  }
  return moduleDependencies;
}

export function setDeviceToolsDependencies(deps: Partial<DeviceToolsDependencies>): void {
  const currentDeps = getDeviceToolsDependencies();
  moduleDependencies = {
    deviceManagerFactory: deps.deviceManagerFactory ?? currentDeps.deviceManagerFactory,
    deviceMatcherFactory: deps.deviceMatcherFactory ?? currentDeps.deviceMatcherFactory,
    notifyResourcesChanged: deps.notifyResourcesChanged ?? currentDeps.notifyResourcesChanged,
    ensureCtrlProxyReady: deps.ensureCtrlProxyReady ?? currentDeps.ensureCtrlProxyReady,
    deviceCreationGateFactory: deps.deviceCreationGateFactory ?? currentDeps.deviceCreationGateFactory,
    deviceProvisionerFactory: deps.deviceProvisionerFactory ?? currentDeps.deviceProvisionerFactory,
    clearInstalledAppsForDevice:
      deps.clearInstalledAppsForDevice ?? currentDeps.clearInstalledAppsForDevice,
    stopPerformanceMonitoring:
      deps.stopPerformanceMonitoring ?? currentDeps.stopPerformanceMonitoring,
    idGenerator: deps.idGenerator ?? currentDeps.idGenerator,
    timer: deps.timer ?? currentDeps.timer,
  };
}

export function resetDeviceToolsDependencies(): void {
  moduleDependencies = null;
}

function describeStartDeviceRequest(args: StartDeviceArgs): string {
  return [
    `platform=${args.platform}`,
    args.deviceId ? `deviceId=${args.deviceId}` : undefined,
    args.name ? `name=${args.name}` : undefined,
    args.minOsVersion ? `minOsVersion=${args.minOsVersion}` : undefined,
    args.maxOsVersion ? `maxOsVersion=${args.maxOsVersion}` : undefined,
    args.formFactor ? `formFactor=${args.formFactor}` : undefined,
  ].filter((value): value is string => value !== undefined).join(" ");
}

function resolveRunnerReadinessTimeoutMs(args: StartDeviceArgs): number {
  return (
    args.runnerReadinessTimeoutMs ??
    args.timeoutMs ??
    serverConfig.getRunnerReadinessTimeoutMs()
  );
}

function validateBootIdentity(
  args: StartDeviceArgs,
  device: BootedDevice,
  source: "booted" | "cold-boot",
  sourceImage?: DeviceInfo,
): void {
  const requested = describeStartDeviceRequest(args);
  const resolved = `${device.platform} ${device.name} (${device.deviceId})`;
  if (device.platform !== args.platform) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] resolved=[${resolved}] ` +
      "phase=pool-match: resolved platform differs from requested platform",
    );
  }
  if (source === "booted" && args.deviceId && device.deviceId !== args.deviceId) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] resolved=[${resolved}] ` +
      "phase=pool-match: running device ID differs from the requested device ID",
    );
  }
  if (
    source === "cold-boot" &&
    device.platform === "ios" &&
    sourceImage?.deviceId &&
    sourceImage.deviceId !== device.deviceId
  ) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requested}] selected=[${sourceImage.name} ` +
      `(${sourceImage.deviceId})] resolved=[${resolved}] phase=pool-match: ` +
      "iOS runtime UDID differs from the selected simulator UDID",
    );
  }
}

function validatePooledDeviceMapping(device: BootedDevice, requestedIdentity: string): void {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const pooled = daemonState.getDevicePool().getDevice(device.deviceId);
  if (pooled && (pooled.platform !== device.platform || pooled.name !== device.name)) {
    throw new ActionableError(
      `startDevice identity mismatch: requested=[${requestedIdentity}] ` +
      `resolved=[${device.name} (${device.deviceId}) platform=${device.platform}] ` +
      `pooled=[${pooled.name} (${pooled.id}) platform=${pooled.platform}] ` +
      "phase=pool-match: stale pool identity conflicts with the resolved runtime",
    );
  }
}

function cancelUnownedColdBoot(boot: DeviceBootResult | undefined): void {
  if (boot?.source !== "cold-boot" || !boot.processHandle) {
    return;
  }
  const daemonState = DaemonState.getInstance();
  if (
    daemonState.isInitialized() &&
    daemonState.getDevicePool().hasStartedDeviceProcess(boot.device.deviceId, boot.processHandle)
  ) {
    logger.info(
      `[DeviceTools] Cold boot ${boot.device.deviceId} process ownership transferred before cleanup`,
    );
    return;
  }
  try {
    boot.processHandle.kill();
  } catch (error) {
    logger.warn(
      `[DeviceTools] Failed to cancel unowned cold boot ${boot.device.deviceId}: ${error}`,
      error,
    );
  }
}

function clearColdBootShutdownMarker(source: "booted" | "cold-boot", deviceId: string): void {
  const daemonState = DaemonState.getInstance();
  if (source === "cold-boot" && daemonState.isInitialized()) {
    daemonState.getDevicePool().clearIntentionalShutdown(deviceId);
  }
}

function publishWarmDeviceReady(source: "booted" | "cold-boot", deviceId: string): void {
  const daemonState = DaemonState.getInstance();
  if (source === "booted" && daemonState.isInitialized()) {
    daemonState.getDevicePool().notifyDeviceReady(deviceId);
  }
}

export function registerDeviceTools() {
  // List AVDs handler
  const listDeviceImagesHandler = async (args: ListDeviceImagesArgs) => {
    try {

      const deps = getDeviceToolsDependencies();
      const deviceUtils = deps.deviceManagerFactory();
      const imageList = await deviceUtils.listDeviceImages(args.platform);

      return createJSONToolResponse({
        message: `Found ${imageList.length} available ${args.platform} AVDs`,
        images: imageList,
        count: imageList.length,
        platform: args.platform
      });
    } catch (error) {
      throw new ActionableError(`Failed to list ${args.platform} AVDs: ${error}`);
    }
  };

  const listDevicesHandler = async (args: ListDevicesArgs) => {
    const platformFilter = args.platform ? ` (${args.platform} only)` : "";

    return createJSONToolResponse({
      message: `To list devices${platformFilter}, use these MCP resources:\n\n` +
        "RUNNING DEVICES (booted/active):\n" +
        `  - automobile:devices/booted - All running devices\n` +
        `  - automobile:devices/booted/android - Android devices only\n` +
        `  - automobile:devices/booted/ios - iOS simulators only\n\n` +
        "AVAILABLE DEVICE IMAGES (can be started):\n" +
        `  - automobile:devices/images - All available images\n` +
        `  - automobile:devices/images/android - Android AVDs\n` +
        `  - automobile:devices/images/ios - iOS simulator runtimes\n\n` +
        "WORKFLOW:\n" +
        "  1. Read 'automobile:devices/booted' to see running devices and get deviceId\n" +
        "  2. Use deviceId with other resources (e.g., automobile:devices/{deviceId}/apps)\n" +
        "  3. To start a new device, read 'automobile:devices/images' then use startDevice tool",
      resources: [
        BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
        `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/android`,
        `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/ios`,
        DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
        `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/android`,
        `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/ios`
      ],
      note: "All resource URIs use the 'automobile:' prefix. URIs like 'android://devices' are not supported."
    });
  };

  // Start device handler — matches criteria against booted devices and images
  const startDeviceHandler = async (
    args: StartDeviceArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const internalSessionId = args.__mcpSessionId;
    args = {
      ...startDeviceSchema.parse(args),
      __mcpSessionId: internalSessionId,
    };
    const perf = createPerformanceTracker(true);
    perf.serial("startDevice");
    const deps = getDeviceToolsDependencies();
    const deviceUtils = deps.deviceManagerFactory();
    const totalTimeoutMs = args.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
    // An explicit timeoutMs is an end-to-end startDevice contract. Preserve it
    // for runner readiness unless the caller deliberately supplies a narrower
    // phase-specific budget.
    const readinessTimeoutMs = resolveRunnerReadinessTimeoutMs(args);
    const totalDeadlineMs = deps.timer.now() + totalTimeoutMs;
    const requestedIdentity = describeStartDeviceRequest(args);
    let boot: DeviceBootResult | undefined;
    let ownershipTransferred = false;
    let releaseReadinessReservation: (() => Promise<void>) | undefined;

    try {
      const bootService = new DeviceBootService({
        deviceManager: deviceUtils,
        deviceMatcher: deps.deviceMatcherFactory(),
        deviceCreationGate: deps.deviceCreationGateFactory(),
        deviceProvisioner: deps.deviceProvisionerFactory(),
        matchingStrategy: DEVICE_POOL_MATCHING,
        timer: deps.timer,
      });
      perf.startOperation("bootDevice");
      boot = await bootService.boot(
        { ...args, totalDeadlineMs, signal },
        progress ? { report: progress } : undefined,
      );
      perf.endOperation("bootDevice");
      validateBootIdentity(args, boot.device, boot.source, boot.sourceImage);
      validatePooledDeviceMapping(boot.device, requestedIdentity);
      const daemonState = DaemonState.getInstance();
      if (daemonState.isInitialized()) {
        releaseReadinessReservation = await daemonState
          .getDevicePool()
          .reserveDeviceForReadiness(boot.device.deviceId, boot.device);
      }

      // A new incarnation must not inherit a prior intentional-shutdown marker
      // while its per-device runner setup is in flight.
      clearColdBootShutdownMarker(boot.source, boot.device.deviceId);

      const ctrlProxySetup = deps.ensureCtrlProxyReady ?? ensureCtrlProxyReady;
      await ctrlProxySetup({
        device: boot.device,
        requestedIdentity,
        totalDeadlineMs,
        readinessTimeoutMs,
        skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
        perf,
        signal,
      });
      // Re-check under the later binding lock because pool identity can change
      // while runner setup is in flight.
      validatePooledDeviceMapping(boot.device, requestedIdentity);

      // Publish only after runner health passes. Readiness remains per-device,
      // so 20-40 concurrent emulators do not serialize on a host-wide gate.
      publishWarmDeviceReady(boot.source, boot.device.deviceId);
      const sessionId = await bindBootedDeviceSession(
        boot.device,
        args,
        boot.sourceImage,
        boot.processHandle
      );
      ownershipTransferred = true;

      if (boot.source === "cold-boot" || boot.provisioned) {
        perf.startOperation("notifyResources");
        await deps.notifyResourcesChanged();
        perf.endOperation("notifyResources");
      }
      return await buildBootedResponse(
        boot.device,
        boot.source,
        perf,
        sessionId,
        boot.processId,
      );
    } catch (error) {
      perf.end();
      if (!ownershipTransferred) {
        cancelUnownedColdBoot(boot);
      }
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to start ${args.platform} device: ${error}`);
    } finally {
      await releaseReadinessReservation?.();
    }
  };


  async function ensureCtrlProxyReady(request: RunnerReadinessRequest): Promise<void> {
    request.perf?.startOperation("ensureCtrlProxy");
    try {
      await createDefaultRunnerReadinessService(
        getDeviceToolsDependencies().timer,
      ).ensureReady(request);
    } finally {
      request.perf?.endOperation("ensureCtrlProxy");
    }
  }

  async function bindBootedDeviceSession(
    device: BootedDevice,
    args: StartDeviceArgs,
    sourceImage?: DeviceInfo,
    childProcess?: ChildProcess | null
  ): Promise<string> {
    // Reserve the exact ready device before resource notifications publish it
    // to concurrent allocators.
    const daemonState = DaemonState.getInstance();
    if (isDevicePoolAutolockEnabled() && daemonState.isInitialized()) {
      const autolockSessionId = await daemonState.getDevicePool().autolockDevice(
        device.deviceId,
        device.platform,
        args.__mcpSessionId,
        sourceImage,
        childProcess,
        device,
      );
      if (autolockSessionId) {
        return autolockSessionId;
      }
    }

    const sessionId = getDeviceToolsDependencies().idGenerator.next();
    if (!daemonState.isInitialized()) {
      return sessionId;
    }
    return daemonState.getDevicePool().bindOrReuseDeviceSession(
      sessionId,
      device.deviceId,
      device.platform,
      sourceImage,
      childProcess,
      device,
    );
  }

  async function buildBootedResponse(
    device: BootedDevice,
    source: "booted" | "cold-boot",
    perf: ReturnType<typeof createPerformanceTracker>,
    sessionId: string,
    processId?: number,
  ) {
    perf.end();
    const timing = perf.getTimings();

    const result: StartDeviceResult = {
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      osVersion: device.osVersion ?? device.iosVersion,
      formFactor: device.formFactor,
      screenSize: device.screenWidth && device.screenHeight
        ? { width: device.screenWidth, height: device.screenHeight }
        : undefined,
      sessionId,
      processId,
      isReady: true,
      source,
      timing,
    };

    return createJSONToolResponse({
      message: `${device.platform} '${device.name}' is ready (${source})`,
      ...result,
    });
  }


  const killDeviceHandler = async (
    args: KillDeviceArgs,
    _progress?: ProgressCallback,
    abortSignal?: AbortSignal,
  ) => {
    const perf = createPerformanceTracker(true);
    perf.serial("killDevice");
    const daemonState = DaemonState.getInstance();
    const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
    const deps = getDeviceToolsDependencies();
    const shutdownDeadlineMs = deps.timer.now() + DEVICE_SHUTDOWN_TIMEOUT_MS;
    const requestAbortSignal = abortSignal ?? getAbortSignal();
    let shutdownReservation: Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>;
    let retainShutdownReservation = false;
    try {
      shutdownReservation = await runWithinShutdownDeadline(
        args.device,
        deps.timer,
        shutdownDeadlineMs,
        "shutdown preparation did not complete",
        requestAbortSignal,
        async signal => await devicePool?.reserveDeviceForShutdown(args.device.deviceId, signal),
      );
      const expectedPooledDevice = shutdownReservation?.device ?? null;
      const retainReservationUntil = (
        operation: Promise<unknown>,
        releaseAfterFailure = false,
      ): void => {
        retainShutdownReservation = true;
        void operation.then(
          () => shutdownReservation?.release(),
          error => {
            if (releaseAfterFailure) {
              void shutdownReservation?.release();
              return;
            }
            logger.warn(
              `[DeviceTools] Retaining shutdown reservation after late teardown failed: ${error}`,
            );
          },
        );
      };
      const shutdownContext: ShutdownDeadlineContext = {
        device: args.device,
        timer: deps.timer,
        deadlineMs: shutdownDeadlineMs,
        requestAbortSignal,
        retainReservationUntil,
      };
      await stopVideoRecordingsBeforeShutdown(shutdownContext, perf);
      await stopIosCtrlProxyBeforeShutdown(shutdownContext, perf);

      const alreadyStoppedMessage = await killProcessAndRetireOwnership(
        deps,
        args.device,
        perf,
        requestAbortSignal,
        devicePool,
        expectedPooledDevice,
        shutdownDeadlineMs,
        retirement => {
          retainReservationUntil(retirement);
        },
      );

      await shutdownReservation?.release();
      shutdownReservation = undefined;

      perf.startOperation("cleanup");
      await clearInstalledAppsAfterShutdown(deps, args.device.deviceId);
      perf.endOperation("cleanup");

      perf.startOperation("notifyResources");
      await notifyResourcesAfterShutdown(deps);
      perf.endOperation("notifyResources");

      perf.end();
      const timing = perf.getTimings();

      return createKillDeviceResponse(args, timing, alreadyStoppedMessage);
    } catch (error) {
      throw new ActionableError(`Failed to kill ${args.device.platform} device: ${error}`);
    } finally {
      if (!retainShutdownReservation) {
        await shutdownReservation?.release();
      }
    }
  };

  // Register with the tool registry
  ToolRegistry.register(
    "listDeviceImages",
    "List device images",
    listDeviceImagesSchema,
    listDeviceImagesHandler
  );

  ToolRegistry.register(
    "listDevices",
    "List devices (resource guidance)",
    listDevicesSchema,
    listDevicesHandler
  );

  ToolRegistry.register("startDevice", "Start device", startDeviceSchema, startDeviceHandler, { supportsProgress: true });

  ToolRegistry.register(
    "killDevice",
    "Kill device",
    killDeviceSchema,
    killDeviceHandler
  );
}

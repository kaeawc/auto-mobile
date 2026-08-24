import { errorMessage } from "../utils/describeUnknownError";
import type { ChildProcess } from "child_process";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import {
  type BootedDeviceDiscovery,
  type DeviceImageDiscovery,
  MultiPlatformDeviceManager,
  PlatformDeviceManager,
} from "../utils/deviceUtils";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ActionableError, BootedDevice, DeviceInfo, Platform, SomePlatform } from "../models";
import type {
  DeviceMatchCriteria,
  FormFactor,
  StartDeviceResult,
} from "../models/DeviceMatchCriteria";
import {
  BOOTED_DEVICE_RESOURCE_URIS,
  notifyBootedDeviceResourcesUpdated,
} from "./bootedDeviceResources";
import {
  DEVICE_IMAGE_RESOURCE_URIS,
  notifyDeviceImageResourcesUpdated,
} from "./deviceImageResources";
import { syncInstalledAppResources } from "./appResources";
import { listActiveVideoRecordings, stopVideoRecording } from "./videoRecordingManager";
import { stopSegmentedVideoRecordingsForDevice } from "./videoRecordingTools";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { getPerformanceMonitor } from "../features/performance/PerformanceMonitor";
import {
  platformSchema,
  withCanonicalDiscriminatedUnionJsonSchema,
  withJsonSchemaOverride,
} from "./toolSchemaHelpers";
import { DefaultDeviceMatcher, type DeviceMatcher } from "../utils/deviceMatcher";
import { DEVICE_POOL_MATCHING, isDevicePoolAutolockEnabled } from "../daemon/poolConfig";
import {
  DEVICE_CREATE_ENV_VAR,
  getDeviceCreationGate,
  type DeviceCreationGate,
} from "../utils/deviceCreationGate";
import {
  createDefaultDeviceProvisioner,
  type DeviceProvisioner,
} from "../utils/deviceProvisioning";
import { DaemonState } from "../daemon/daemonState";
import type { DevicePool, DeviceReadinessReservation, PooledDevice } from "../daemon/devicePool";
import type { SessionManager } from "../daemon/sessionManager";
import { DeviceBootService, type DeviceBootResult } from "../utils/deviceBootService";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { isAdbMissingDeviceError } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getAbortSignal, runWithAbortSignal } from "../utils/AbortContext";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { executionTracker } from "./executionTracker";
import {
  registerDirectSessionDevice,
  unregisterDirectSessionsForDevice,
  unregisterDirectSessionsForStableIdentity,
} from "./directSessionDeviceRegistry";
import {
  createDefaultRunnerReadinessService,
  type RunnerReadinessRequest,
  SystemUiAnrRecoveryRequiredError,
} from "../utils/RunnerReadinessService";
import {
  DEFAULT_RUNNER_READINESS_TIMEOUT_MS,
  MAX_RUNNER_READINESS_TIMEOUT_MS,
  MIN_RUNNER_READINESS_TIMEOUT_MS,
} from "../utils/runnerReadinessConfig";
import { serverConfig } from "../utils/ServerConfig";
import {
  DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS,
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  DEFAULT_PROVISION_DEVICE_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../utils/deviceTimeouts";
import {
  createDefaultExactDeviceProvisioner,
  type ExactDeviceProvisioner,
  type ExactDeviceSpecification,
  ProvisionDeviceError,
} from "../utils/exactDeviceProvisioning";
import { MIN_AVD_RAM_MB } from "../utils/android-cmdline-tools/AvdConfigReader";
import {
  ProvisionDeviceOperationRepository,
  ProvisionDeviceOperationConflictError,
  type ProvisionDeviceOperationStore,
} from "../db/provisionDeviceOperationRepository";
import {
  DeviceTeardownOperationRepository,
  type DeviceTeardownOperationStore,
} from "../db/deviceTeardownOperationRepository";
import { stableStringify } from "../utils/stableStringify";
import {
  getVirtualDeviceLifecycleCoordinator,
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
  type VirtualDeviceLifecycleOperation,
} from "../utils/virtualDeviceLifecycleCoordinator";
import { DeviceTeardownService, type DeviceTeardownPhase } from "../utils/deviceTeardownService";
import { DeviceShutdownService } from "../utils/deviceShutdownService";

// Schema definitions
export const listDeviceImagesSchema = z.object({
  platform: platformSchema,
});

export const listDevicesSchema = z.object({
  platform: platformSchema.optional(),
});

const startDeviceParametersSchema = z.object({
  platform: platformSchema,
  minOsVersion: z
    .string()
    .optional()
    .describe("Minimum OS version, inclusive (e.g., '14', '17.2')"),
  maxOsVersion: z
    .string()
    .optional()
    .describe("Maximum OS version, inclusive (e.g., '15', '18.0')"),
  name: z.string().optional().describe("Device name to match (e.g., 'iPhone 16e', 'Pixel_9_Pro')"),
  formFactor: z.enum(["phone", "tablet"]).optional().describe("Device form factor"),
  screenSize: z
    .object({
      width: z.number().describe("Screen width in pixels"),
      height: z.number().describe("Screen height in pixels"),
    })
    .optional()
    .describe("Desired screen dimensions"),
  deviceId: z.string().optional(),
  preferRunning: z.boolean().optional().describe("Prefer already-booted device (default true)"),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_DEVICE_READY_TIMEOUT_MS)
    .optional()
    .describe("Total device boot and automation-readiness timeout in ms"),
  runnerReadinessTimeoutMs: z
    .number()
    .int()
    .min(MIN_RUNNER_READINESS_TIMEOUT_MS)
    .max(MAX_RUNNER_READINESS_TIMEOUT_MS)
    .optional()
    .describe(
      "Runner-readiness budget in ms within timeoutMs; overrides the shared timeout " +
        `(${MIN_RUNNER_READINESS_TIMEOUT_MS}-${MAX_RUNNER_READINESS_TIMEOUT_MS})`,
    ),
  createIfMissing: z
    .boolean()
    .optional()
    .describe(
      `Create a device when nothing matches (CLI: --create-if-missing). Default off; ` +
        `${DEVICE_CREATE_ENV_VAR}=1 enables it when this flag is not supplied, and the flag wins.`,
    ),
});

export const startDeviceSchema = z.preprocess((input) => {
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
    ...(legacyDevice as Record<string, unknown>),
    ...parsed,
  };
}, startDeviceParametersSchema);

const devicePreparationTimeoutSchema = z
  .object({
    bootTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_DEVICE_READY_TIMEOUT_MS)
      .optional()
      .describe("Maximum time to find, recover, or boot the device operating system"),
    automationReadyTimeoutMs: z
      .number()
      .int()
      .min(MIN_RUNNER_READINESS_TIMEOUT_MS)
      .max(MAX_RUNNER_READINESS_TIMEOUT_MS)
      .optional()
      .describe("Maximum time to install, update, start, and verify the automation runner"),
  })
  .strict()
  .superRefine((value, context) => {
    const totalTimeoutMs =
      (value.bootTimeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS) +
      (value.automationReadyTimeoutMs ?? DEFAULT_RUNNER_READINESS_TIMEOUT_MS);
    if (totalTimeoutMs > MAX_DEVICE_READY_TIMEOUT_MS) {
      context.addIssue({
        code: "custom",
        message: `bootTimeoutMs + automationReadyTimeoutMs must be <= ${MAX_DEVICE_READY_TIMEOUT_MS}`,
        path: ["bootTimeoutMs"],
      });
    }
  });

export const getAndroidSchema = devicePreparationTimeoutSchema.extend({
  avdName: z.string().min(1).describe("Configured Android Virtual Device name"),
});

export const getAppleSchema = devicePreparationTimeoutSchema.extend({
  udid: z.string().min(1).describe("iOS Simulator UDID"),
});

const MODERN_PLAY_IMAGE_MIN_API_LEVEL = 30;

function isModernPlayStoreRuntime(runtime: string): boolean {
  const [kind, apiIdentifier, tag] = runtime.split(";");
  const apiMatch = /^android-(\d+)$/.exec(apiIdentifier ?? "");
  return (
    kind === "system-images" &&
    tag === "google_apis_playstore" &&
    apiMatch !== null &&
    Number(apiMatch[1]) >= MODERN_PLAY_IMAGE_MIN_API_LEVEL
  );
}

const androidProvisionDeviceSpecSchema = z
  .object({
    runtime: z.string().min(1).describe("Installed Android system-image package identifier"),
    deviceType: z.string().min(1).describe("Android avdmanager device profile identifier"),
    configuration: z
      .object({
        memoryMb: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    const memoryMb = spec.configuration?.memoryMb;
    if (
      memoryMb !== undefined &&
      memoryMb < MIN_AVD_RAM_MB &&
      isModernPlayStoreRuntime(spec.runtime)
    ) {
      context.addIssue({
        code: "custom",
        message:
          `memoryMb must be at least ${MIN_AVD_RAM_MB} for Android API ` +
          `${MODERN_PLAY_IMAGE_MIN_API_LEVEL}+ Play Store images`,
        path: ["configuration", "memoryMb"],
      });
    }
  });

const iosProvisionDeviceSpecSchema = z
  .object({
    runtime: z.string().min(1).describe("CoreSimulator runtime identifier"),
    deviceType: z.string().min(1).describe("CoreSimulator device-type identifier"),
  })
  .strict();

export const provisionDeviceSchema = z
  .object({
    operationId: z.string().min(1).describe("Caller-generated idempotency key"),
    device: withCanonicalDiscriminatedUnionJsonSchema(
      z.discriminatedUnion("platform", [
        z
          .object({
            platform: z.literal("android"),
            name: z.string().min(1).describe("Exact AVD name"),
            spec: androidProvisionDeviceSpecSchema,
          })
          .strict(),
        z
          .object({
            platform: z.literal("ios"),
            name: z.string().min(1).describe("Exact simulator name"),
            spec: iosProvisionDeviceSpecSchema,
          })
          .strict(),
      ]),
    ),
    boot: z
      .boolean()
      .default(true)
      .optional()
      .describe("Boot the resolved device after creation or adoption"),
    readiness: z
      .enum(["automation", "none"])
      .default("automation")
      .optional()
      .describe("Whether to wait for the AutoMobile automation runner after device boot"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_DEVICE_READY_TIMEOUT_MS)
      .optional()
      .describe("Total provision, boot, and readiness timeout in ms"),
  })
  .strict();

export const killDeviceSchema = z.object({
  device: z.object({
    name: z.string().describe("Device image name"),
    deviceId: z.string(),
    platform: platformSchema,
    transportId: z.string().optional(),
  }),
});

const TEARDOWN_OPERATION_ID_JSON_SCHEMA_PATTERN =
  "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000)$";

export const teardownDeviceSchema = z
  .object({
    operationId: withJsonSchemaOverride(
      z.string().uuid().describe("Caller-generated idempotency and diagnostic correlation ID"),
      (jsonSchema) => {
        // Zod's UUID JSON Schema pattern differs between platforms.
        jsonSchema.pattern = TEARDOWN_OPERATION_ID_JSON_SCHEMA_PATTERN;
      },
    ),
    target: z
      .object({
        platform: platformSchema.describe("Platform reported by automobile:devices/booted"),
        isVirtual: z
          .literal(true)
          .describe("Virtual-device flag reported by automobile:devices/booted"),
        stableId: z
          .string()
          .min(1)
          .describe("Stable platform device identity from automobile:devices/booted"),
        stableName: z
          .string()
          .min(1)
          .optional()
          .describe("Stable platform representation name when available"),
      })
      .strict(),
    mode: z
      .literal("destroy")
      .describe("Stop and permanently delete the platform device representation"),
    verifyAbsence: z
      .literal(true)
      .describe("Require a complete inventory observation proving durable absence"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_DEVICE_READY_TIMEOUT_MS)
      .optional()
      .describe("Total bounded teardown timeout in ms"),
  })
  .strict();

export const DEVICE_ALREADY_STOPPED_ERROR_CODE = "device_already_stopped";

// A successful platform shutdown command only confirms that the request was
// accepted. Keep the public killDevice result coupled to the observable device
// lifecycle, while bounding the wait so a wedged platform command is actionable.
const DEVICE_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEVICE_SHUTDOWN_POLL_INTERVAL_MS = 1_000;
const DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS = 1_000;
const TEARDOWN_OPERATION_RESULT_TTL_MS = 5 * 60 * 1_000;

function getShutdownInitiatingExecutionId(): string | undefined {
  return getToolSelectionContext()?.execution?.executionId;
}

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
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ success: false, message, error: { code, message } }),
      },
    ],
  };
}

function createKillDeviceResponse(
  args: KillDeviceArgs,
  timing: unknown,
  alreadyStoppedMessage?: string,
) {
  if (alreadyStoppedMessage !== undefined) {
    return createToolErrorResponse(DEVICE_ALREADY_STOPPED_ERROR_CODE, alreadyStoppedMessage);
  }

  return createJSONToolResponse({
    message: `${args.device.platform} '${args.device.name}' shutdown successfully`,
    udid: args.device.deviceId,
    name: args.device.name,
    timing,
    platform: args.device.platform,
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
  /** Internal exact runtime identity used by getAndroid. */
  matchExactName?: boolean;
}

export interface GetAndroidArgs {
  avdName: string;
  bootTimeoutMs?: number;
  automationReadyTimeoutMs?: number;
}

export interface GetAppleArgs {
  udid: string;
  bootTimeoutMs?: number;
  automationReadyTimeoutMs?: number;
}

export interface ProvisionDeviceArgs {
  operationId: string;
  device: {
    platform: "android" | "ios";
    name: string;
    spec: ExactDeviceSpecification;
  };
  boot: boolean;
  readiness: "automation" | "none";
  timeoutMs?: number;
  __mcpSessionId?: string;
}

export interface KillDeviceArgs {
  device: BootedDevice;
}

export interface TeardownDeviceArgs {
  operationId: string;
  target: {
    platform: Platform;
    isVirtual: true;
    stableId: string;
    stableName?: string;
  };
  mode: "destroy";
  verifyAbsence: true;
  timeoutMs?: number;
}

interface StableDeviceTarget {
  platform: Platform;
  stableId: string;
}

type StableDeviceLifecycleTimeoutFactory = (detail: string) => Error;

async function reserveStableDeviceLifecycle(
  target: StableDeviceTarget,
  deadlineDevice: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
  timeoutError: StableDeviceLifecycleTimeoutFactory = (detail) =>
    shutdownTimeoutError(deadlineDevice, detail),
  operation: VirtualDeviceLifecycleOperation = "start",
  coordinator: VirtualDeviceLifecycleCoordinator = getVirtualDeviceLifecycleCoordinator(),
): Promise<VirtualDeviceLifecycleLease> {
  try {
    return await coordinator.reserve(
      {
        kind: "stable",
        platform: target.platform,
        stableId: target.stableId,
      },
      {
        operation,
        deadlineMs,
        signal: requestAbortSignal,
      },
    );
  } catch (error) {
    if (timer.now() >= deadlineMs) {
      throw timeoutError("waiting for stable device lifecycle reservation");
    }
    throw error;
  }
}

function deviceIdentityPayload(
  device: BootedDevice,
  sourceImage?: DeviceInfo,
): Record<string, unknown> {
  if (device.platform === "android") {
    const portMatch = /^emulator-(\d+)$/.exec(device.deviceId);
    return {
      platform: "android",
      avdName: sourceImage?.platform === "android" ? sourceImage.name : device.name,
      adbSerial: device.deviceId,
      emulatorConsolePort: portMatch ? Number(portMatch[1]) : null,
      adbTransportId: device.transportId ?? null,
    };
  }

  return {
    platform: "ios",
    simulatorUdid: device.deviceId,
    simulatorName: device.name,
  };
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
  exactDeviceProvisionerFactory: (
    deviceManager: PlatformDeviceManager,
    deviceCreationGate: DeviceCreationGate,
  ) => ExactDeviceProvisioner;
  provisionDeviceOperationStoreFactory: () => ProvisionDeviceOperationStore;
  teardownDeviceOperationStoreFactory: () => DeviceTeardownOperationStore;
  clearInstalledAppsForDevice: (deviceId: string) => Promise<void>;
  stopPerformanceMonitoring: (deviceId: string) => void;
  stopAndroidObservers: (device: BootedDevice) => Promise<void>;
  idGenerator: IdGenerator;
  timer: Timer;
  lifecycleCoordinator: VirtualDeviceLifecycleCoordinator;
}

const activeProvisionDeviceOperations = new Map<
  string,
  { fingerprint: string; promise: Promise<Record<string, unknown>> }
>();

async function defaultNotifyResourcesChanged(): Promise<void> {
  await notifyBootedDeviceResourcesUpdated();
  await notifyDeviceImageResourcesUpdated();
  await syncInstalledAppResources();
}

async function defaultClearInstalledAppsForDevice(deviceId: string): Promise<void> {
  const { InstalledAppsRepository } = await import("../db/installedAppsRepository");
  const repo = new InstalledAppsRepository();
  await getInstalledAppsCacheWriteCoordinator().invalidate(deviceId, () =>
    getDbWriteBarrier()
      .track(() => repo.clearDeviceSession(deviceId))
      .then(() => undefined),
  );
}

async function defaultStopAndroidObservers(device: BootedDevice): Promise<void> {
  // Resolve the per-device singleton through the statically-imported class rather
  // than a runtime `import()`. On Windows the dynamic specifier resolved to a
  // second module record with its own empty `instances` registry, so
  // getExistingInstance returned null and the observer was never detached
  // (issue #5452 CI failure). A static import shares one class identity with the
  // observe feature that created the singleton, matching the iOS CtrlProxy path.
  const observer = AndroidCtrlProxyClient.getExistingInstance(device.deviceId);
  if (!observer) {
    return;
  }
  try {
    // Detaching the per-device CtrlProxy singleton disables its auto-reconnect,
    // health-check, screenshot-backoff, and work-profile loops so they stop
    // re-referencing the emulator transport while it shuts down.
    await observer.close();
  } finally {
    // close() disables auto-reconnect permanently, so evict the detached client
    // rather than let a re-booted same-serial emulator reuse a stale one.
    AndroidCtrlProxyClient.removeInstance(device.deviceId);
  }
}

async function clearInstalledAppsAfterShutdown(
  dependencies: DeviceToolsDependencies,
  deviceId: string,
): Promise<void> {
  try {
    await dependencies.clearInstalledAppsForDevice(deviceId);
  } catch (error) {
    // The device is already stopped; the next app verification refreshes stale cache rows.
    logger.warn(
      `[DeviceTools] Failed to clear installed apps for ${deviceId} after shutdown: ${error}`,
      error,
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
  timeoutMs: number;
  requestAbortSignal: AbortSignal | undefined;
  retainReservationUntil?: (operation: Promise<unknown>, releaseAfterFailure?: boolean) => void;
}

interface AndroidObserverShutdownState {
  hadActiveObserver: boolean;
  boundSessionId: string | null;
  deviceIdentity: BootedDevice | null;
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
      context.timeoutMs,
    );
  } catch (error) {
    if (shouldPropagateShutdownPreparationError(error, context.requestAbortSignal)) {
      throw error;
    }
    logger.warn(`[DeviceTools] Failed to stop recording ${recordingId} before shutdown: ${error}`);
  }
}

async function stopVideoRecordingsBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
): Promise<void> {
  perf.startOperation("stopRecordings");
  try {
    await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "segmented video recording teardown did not complete",
      context.requestAbortSignal,
      async () => await stopSegmentedVideoRecordingsForDevice(context.device),
      context.timeoutMs,
    );
    const activeRecordings = await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "recording discovery did not complete",
      context.requestAbortSignal,
      async () =>
        await listActiveVideoRecordings({
          deviceId: context.device.deviceId,
          platform: context.device.platform,
        }),
      context.timeoutMs,
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
      context.timeoutMs,
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

async function stopAndroidCtrlProxyBeforeShutdown(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
  stopAndroidObservers: (device: BootedDevice) => Promise<void>,
): Promise<AndroidObserverShutdownState> {
  if (context.device.platform !== "android") {
    return { hadActiveObserver: false, boundSessionId: null, deviceIdentity: null };
  }
  const activeObserver = AndroidCtrlProxyClient.getExistingInstance(context.device.deviceId);
  const activeDeviceIdentity = activeObserver?.getBootedDeviceIdentity();
  const observerState: AndroidObserverShutdownState = {
    hadActiveObserver: activeObserver !== null,
    boundSessionId: activeObserver?.getBoundSessionId() ?? null,
    deviceIdentity: activeDeviceIdentity
      ? {
          ...activeDeviceIdentity,
          transportId: activeDeviceIdentity.transportId ?? context.device.transportId,
        }
      : null,
  };
  let stop: Promise<void> | undefined;
  perf.startOperation("stopAndroidCtrlProxy");
  try {
    stop = stopAndroidObservers(context.device);
    await runWithinShutdownDeadline(
      context.device,
      context.timer,
      context.deadlineMs,
      "Android observer detach did not complete",
      context.requestAbortSignal,
      async () => await stop,
    );
  } catch (error) {
    if (shouldPropagateShutdownPreparationError(error, context.requestAbortSignal)) {
      if (stop) {
        // Observer detach can keep mutating adb/port state after its caller stops
        // waiting. Hold the device unavailable until it settles, releasing after a
        // failed pre-kill teardown because the platform was never shut down.
        context.retainReservationUntil?.(stop, true);
      }
      throw error;
    }
    logger.warn(`[DeviceTools] Failed to stop Android observers before kill: ${error}`);
  } finally {
    perf.endOperation("stopAndroidCtrlProxy");
  }
  return observerState;
}

function shutdownTimeoutError(
  device: BootedDevice,
  detail: string,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
): ActionableError {
  return new ActionableError(
    `Timed out waiting for ${device.platform} device '${device.name}' (${device.deviceId}) ` +
      `to disappear after ${timeoutMs}ms: ${detail}. ` +
      "Verify the platform shutdown state and retry.",
  );
}

function isShutdownTimeoutError(error: unknown): error is ActionableError {
  return (
    error instanceof ActionableError && String(error.message).startsWith("Timed out waiting for")
  );
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

function shouldRestoreAndroidObserverAfterCommandFailure(
  device: BootedDevice,
  error: unknown,
  requestAbortSignal: AbortSignal | undefined,
): boolean {
  return (
    device.platform === "android" &&
    !isAlreadyStoppedDeviceError(device.platform, device.deviceId, error) &&
    !shouldKeepIntentionalShutdownAfterCommandError(error, requestAbortSignal)
  );
}

function hasLiveAndroidObserverSessionBinding(
  device: BootedDevice,
  boundSessionId: string | null,
): boundSessionId is string {
  if (boundSessionId === null) {
    return false;
  }
  const daemonState = DaemonState.getInstance();
  return (
    daemonState.isInitialized() &&
    daemonState.getSessionManager().getSessionForDevice(device.deviceId) === boundSessionId
  );
}

async function restoreAndroidObserverAfterCommandFailure(
  deviceManager: PlatformDeviceManager,
  device: BootedDevice,
  observerState: AndroidObserverShutdownState,
  error: unknown,
  timer: Timer,
  shutdownDeadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  if (
    !observerState.hadActiveObserver ||
    !shouldRestoreAndroidObserverAfterCommandFailure(device, error, requestAbortSignal)
  ) {
    return;
  }
  try {
    // The pre-kill teardown evicts the observer to release its transport hold.
    // Recreate it only after a fresh, uncached discovery proves this exact
    // incarnation survived the failed command; a disappeared device or a
    // same-ID reboot must stay detached.
    const discovery = await getCompleteShutdownDiscovery(
      deviceManager,
      device,
      timer,
      shutdownDeadlineMs,
      requestAbortSignal,
      timeoutMs,
    );
    const survivingDevice = findDiscoveredDevice(discovery, device);
    if (
      survivingDevice &&
      observerState.deviceIdentity?.transportId !== undefined &&
      survivingDevice.transportId !== undefined &&
      isSameBootedDeviceIdentity(observerState.deviceIdentity, survivingDevice)
    ) {
      const observer = AndroidCtrlProxyClient.getInstance(survivingDevice);
      if (hasLiveAndroidObserverSessionBinding(device, observerState.boundSessionId)) {
        observer.bindSession(observerState.boundSessionId);
      }
      const reconnect = async (): Promise<boolean> => {
        try {
          return await runWithinShutdownDeadline(
            device,
            timer,
            shutdownDeadlineMs,
            "Android observer reconnect did not complete",
            requestAbortSignal,
            async () => await observer.ensureConnected(),
            timeoutMs,
          );
        } catch (error) {
          if (isShutdownTimeoutError(error) || requestAbortSignal?.aborted) {
            // Platform setup does not accept an AbortSignal. Invalidate the
            // in-flight client so a late port-forward cannot register a stale
            // observer or leave future callers waiting on its connection.
            await observer.close();
            if (AndroidCtrlProxyClient.getExistingInstance(device.deviceId) === observer) {
              AndroidCtrlProxyClient.removeInstance(device.deviceId);
            }
          }
          throw error;
        }
      };
      let connected = await reconnect();
      if (!connected) {
        // A failed port-forward setup has no WebSocket close event to trigger
        // the normal automatic reconnect. Retry once while the shutdown budget
        // is still live so existing passive subscribers regain their cadence.
        connected = await reconnect();
      }
      if (!connected) {
        logger.warn(
          `[DeviceTools] Failed to reconnect Android observer after kill failure for ${device.deviceId}`,
        );
      }
    }
  } catch (restoreError) {
    // Preserve the original shutdown command failure. A later explicit tool
    // call can still recreate the observer if this confirmation was unavailable.
    logger.warn(
      `[DeviceTools] Failed to restore Android observer after kill failure for ${device.deviceId}: ${restoreError}`,
      restoreError,
    );
  }
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

function rethrowShutdownFailure(
  device: BootedDevice,
  requestAbortSignal: AbortSignal | undefined,
  error: unknown,
): never {
  if (error instanceof ActionableError || requestAbortSignal?.aborted) {
    throw error;
  }
  throw new ActionableError(`Failed to kill ${device.platform} device: ${error}`);
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
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
): Promise<T> {
  const remainingMs = deadlineMs - timer.now();
  if (remainingMs <= 0) {
    throw shutdownTimeoutError(device, detail, timeoutMs);
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
      reject(shutdownTimeoutError(device, detail, timeoutMs));
    }, remainingMs);
  });
  const requestAbort = abortPromise(requestAbortSignal);
  const operationPromise = runWithAbortSignal(signal, () => operation(signal, remainingMs)).catch(
    (error) => {
      if (timedOut) {
        throw shutdownTimeoutError(device, detail, timeoutMs);
      }
      throw error;
    },
  );
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

async function runPostShutdownStep(
  context: ShutdownDeadlineContext,
  perf: ReturnType<typeof createPerformanceTracker>,
  operationName: "cleanup" | "notifyResources",
  detail: string,
  strictDeadline: boolean,
  operation: () => Promise<void>,
): Promise<void> {
  perf.startOperation(operationName);
  try {
    if (strictDeadline) {
      await runWithinShutdownDeadline(
        context.device,
        context.timer,
        context.deadlineMs,
        detail,
        context.requestAbortSignal,
        async () => await operation(),
        context.timeoutMs,
      );
      return;
    }
    await operation();
  } finally {
    perf.endOperation(operationName);
  }
}

async function getShutdownDiscovery(
  deviceManager: PlatformDeviceManager,
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
) {
  return await runWithinShutdownDeadline(
    device,
    timer,
    deadlineMs,
    "platform discovery did not complete",
    requestAbortSignal ?? getAbortSignal(),
    async () =>
      await deviceManager.getBootedDevicesDetailed(device.platform, {
        bypassAndroidDeviceListCache: true,
      }),
    timeoutMs,
  );
}

async function getCompleteShutdownDiscovery(
  deviceManager: PlatformDeviceManager,
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
) {
  for (;;) {
    const discovery = await getShutdownDiscovery(
      deviceManager,
      device,
      timer,
      deadlineMs,
      requestAbortSignal,
      timeoutMs,
    );
    if (discovery.succeededPlatforms.has(device.platform)) {
      return discovery;
    }
    const remainingMs = deadlineMs - timer.now();
    if (remainingMs <= 0) {
      throw shutdownTimeoutError(device, "platform discovery did not complete", timeoutMs);
    }
    await timer.sleep(Math.min(DEVICE_SHUTDOWN_POLL_INTERVAL_MS, remainingMs));
  }
}

async function waitForDeviceShutdown(
  deviceManager: PlatformDeviceManager,
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
): Promise<BootedDevice | undefined> {
  let lastDiscoveryDetail = "platform discovery did not complete";
  for (;;) {
    if (timer.now() >= deadlineMs) {
      throw shutdownTimeoutError(device, lastDiscoveryDetail, timeoutMs);
    }
    const discovery = await getShutdownDiscovery(
      deviceManager,
      device,
      timer,
      deadlineMs,
      requestAbortSignal,
      timeoutMs,
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
      throw shutdownTimeoutError(device, lastDiscoveryDetail, timeoutMs);
    }
    await timer.sleep(Math.min(DEVICE_SHUTDOWN_POLL_INTERVAL_MS, remainingMs));
  }
}

function isSameBootedDeviceIdentity(device: BootedDevice, candidate: BootedDevice): boolean {
  if (device.platform !== candidate.platform || device.deviceId !== candidate.deviceId) {
    return false;
  }
  if (
    device.platform === "android" &&
    device.transportId !== undefined &&
    candidate.transportId !== undefined
  ) {
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
  return discovery.devices.find(
    (candidate) => candidate.platform === device.platform && candidate.deviceId === device.deviceId,
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
  const rebuilt = await devicePool.replaceDeviceForShutdown(expectedPooledDevice, replacement, () =>
    stopPerformanceMonitoring(device.deviceId),
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

function shutdownRecheckDeadlineMs(
  timer: Timer,
  deadlineMs: number,
  strictDeadline: boolean,
): number {
  if (strictDeadline) {
    return deadlineMs;
  }
  return Math.max(deadlineMs, timer.now() + DEVICE_SHUTDOWN_POST_RELEASE_RECHECK_TIMEOUT_MS);
}

async function findReplacementAfterSessionRelease(
  deviceManager: PlatformDeviceManager,
  device: BootedDevice,
  timer: Timer,
  deadlineMs: number,
  requestAbortSignal: AbortSignal | undefined,
  strictDeadline = false,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
): Promise<BootedDevice | undefined> {
  // The absence observation only proves the old incarnation was gone before
  // session release. A same-ID replacement can appear while that release
  // awaits persistence, so ordinary shutdown keeps a short, bounded recheck
  // even after the disappearance deadline was consumed.
  const recheckDeadlineMs = shutdownRecheckDeadlineMs(timer, deadlineMs, strictDeadline);
  const discovery = await getShutdownDiscovery(
    deviceManager,
    device,
    timer,
    recheckDeadlineMs,
    requestAbortSignal,
    timeoutMs,
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
    timeoutMs,
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
  lateRetirement.catch((lateError) => {
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
  retirement.catch((lateError) => {
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
  strictDeadline: boolean,
  timeoutMs: number,
): Promise<BootedDevice | undefined> {
  try {
    return (
      observedReplacement ??
      (await findReplacementAfterSessionRelease(
        deviceManager,
        device,
        timer,
        deadlineMs,
        abortSignal,
        strictDeadline,
        timeoutMs,
      ))
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

async function releaseShutdownSessionOwnership(
  device: BootedDevice,
  expectedPooledDevice: PooledDevice,
  daemonState: DaemonState,
  observedReplacement: BootedDevice | undefined,
  deviceManager: PlatformDeviceManager,
  timer: Timer,
  deadlineMs: number,
  abortSignal: AbortSignal | undefined,
  stopPerformanceMonitoring: (deviceId: string) => void,
  retainReservationUntil: (retirement: Promise<void>) => void,
  strictDeadline: boolean,
  timeoutMs: number,
): Promise<void> {
  const sessionManager = daemonState.getSessionManager();
  const sessionId = expectedPooledDevice.sessionId;
  if (!sessionId || sessionManager.getSessionForDevice(device.deviceId) !== sessionId) {
    return;
  }

  await executionTracker.cancelSessionUuidExecutions(
    sessionId,
    `device-disconnected:${device.deviceId}`,
    { excludeExecutionId: getShutdownInitiatingExecutionId() },
  );
  const release = sessionManager.releaseSession(sessionId, `device-stopped:${device.deviceId}`);
  try {
    await runWithinShutdownDeadline(
      device,
      timer,
      shutdownRecheckDeadlineMs(timer, deadlineMs, strictDeadline),
      "session ownership retirement did not complete",
      abortSignal,
      async () => await release,
      timeoutMs,
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
  strictDeadline = false,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
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

  await releaseShutdownSessionOwnership(
    device,
    expectedPooledDevice,
    daemonState,
    observedReplacement,
    deviceManager,
    timer,
    deadlineMs,
    abortSignal,
    stopPerformanceMonitoring,
    retainReservationUntil,
    strictDeadline,
    timeoutMs,
  );
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
    strictDeadline,
    timeoutMs,
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
  androidObserverState: AndroidObserverShutdownState,
  shutdownDeadlineMs: number,
  retainReservationUntil: (
    retirement: Promise<void>,
    releaseReservationAfterFailure?: boolean,
  ) => void,
  strictDeadline = false,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
): Promise<string | undefined> {
  const deviceManager = dependencies.deviceManagerFactory();
  if (device.platform === "android") {
    devicePool?.markIntentionalShutdown(device.deviceId);
  }

  let shutdownDevice = device;
  let alreadyStoppedMessage: string | undefined;
  let platformShutdown: Promise<BootedDevice | void> | undefined;
  let platformShutdownSettled = false;
  perf.startOperation("killProcess");
  try {
    const killedDevice = await runWithinShutdownDeadline(
      device,
      dependencies.timer,
      shutdownDeadlineMs,
      "platform shutdown command did not complete",
      requestAbortSignal,
      async (signal, timeoutMs) => {
        platformShutdown = deviceManager.killDevice(device, { signal, timeoutMs }).finally(() => {
          platformShutdownSettled = true;
        });
        return await platformShutdown;
      },
      timeoutMs,
    );
    shutdownDevice = killedDevice ?? device;
  } catch (error) {
    retainLatePlatformShutdown(platformShutdown, platformShutdownSettled, retainReservationUntil);
    await restoreAndroidObserverAfterCommandFailure(
      deviceManager,
      device,
      androidObserverState,
      error,
      dependencies.timer,
      shutdownDeadlineMs,
      requestAbortSignal,
      timeoutMs,
    );
    alreadyStoppedMessage = handleShutdownCommandError(
      device,
      error,
      devicePool,
      requestAbortSignal,
    );
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
      timeoutMs,
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
      true,
      strictDeadline,
      timeoutMs,
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

function retainLatePlatformShutdown(
  platformShutdown: Promise<BootedDevice | void> | undefined,
  platformShutdownSettled: boolean,
  retainReservationUntil: (
    retirement: Promise<void>,
    releaseReservationAfterFailure?: boolean,
  ) => void,
): void {
  if (platformShutdown && !platformShutdownSettled) {
    retainReservationUntil(
      platformShutdown.then(() => undefined),
      true,
    );
  }
}

interface ShutdownResult {
  timing: unknown;
  alreadyStoppedMessage?: string;
}

const deviceShutdownService = new DeviceShutdownService();

async function shutdownDevice(
  device: BootedDevice,
  dependencies: DeviceToolsDependencies,
  requestAbortSignal: AbortSignal | undefined,
  shutdownDeadlineMs: number,
  operationName: string,
  strictDeadline = false,
  timeoutMs = DEVICE_SHUTDOWN_TIMEOUT_MS,
  retainLifecycleUntil?: (operation: Promise<unknown>) => void,
): Promise<ShutdownResult> {
  const perf = createPerformanceTracker(true);
  perf.serial(operationName);
  const daemonState = DaemonState.getInstance();
  const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
  return await deviceShutdownService.shutdown({
    prepare: async () =>
      await runWithinShutdownDeadline(
        device,
        dependencies.timer,
        shutdownDeadlineMs,
        "shutdown preparation did not complete",
        requestAbortSignal,
        async (signal) => await devicePool?.reserveDeviceForShutdown(device.deviceId, signal),
        timeoutMs,
      ),
    execute: async (shutdownReservation, retainReservationUntil) => {
      const expectedPooledDevice = shutdownReservation?.device ?? null;
      const retainShutdownUntil = (
        operation: Promise<unknown>,
        releaseReservationAfterFailure = false,
      ): void => {
        retainReservationUntil(operation, releaseReservationAfterFailure);
        retainLifecycleUntil?.(operation);
      };
      const shutdownContext: ShutdownDeadlineContext = {
        device,
        timer: dependencies.timer,
        deadlineMs: shutdownDeadlineMs,
        timeoutMs,
        requestAbortSignal,
        retainReservationUntil: retainShutdownUntil,
      };
      await stopVideoRecordingsBeforeShutdown(shutdownContext, perf);
      await stopIosCtrlProxyBeforeShutdown(shutdownContext, perf);
      const androidObserverState = await stopAndroidCtrlProxyBeforeShutdown(
        shutdownContext,
        perf,
        dependencies.stopAndroidObservers,
      );

      const alreadyStoppedMessage = await killProcessAndRetireOwnership(
        dependencies,
        device,
        perf,
        requestAbortSignal,
        devicePool,
        expectedPooledDevice,
        androidObserverState,
        shutdownDeadlineMs,
        (retirement, releaseReservationAfterFailure) => {
          retainShutdownUntil(retirement, releaseReservationAfterFailure);
        },
        strictDeadline,
        timeoutMs,
      );

      if (alreadyStoppedMessage !== undefined) {
        // The target may have stopped between teardown discovery and the platform
        // kill command. Retire the captured pool incarnation before deletion.
        perf.startOperation("retireOwnership");
        await retireShutdownOwnership(
          device,
          expectedPooledDevice,
          undefined,
          dependencies.deviceManagerFactory(),
          dependencies.timer,
          shutdownDeadlineMs,
          requestAbortSignal,
          dependencies.stopPerformanceMonitoring,
          retainShutdownUntil,
          true,
          strictDeadline,
          timeoutMs,
        );
        perf.endOperation("retireOwnership");
      }

      await shutdownReservation?.release();
      unregisterDirectSessionsForDevice(device.deviceId);

      await runPostShutdownStep(
        shutdownContext,
        perf,
        "cleanup",
        "installed-app cleanup did not complete",
        strictDeadline,
        async () => await clearInstalledAppsAfterShutdown(dependencies, device.deviceId),
      );
      await runPostShutdownStep(
        shutdownContext,
        perf,
        "notifyResources",
        "resource notification did not complete",
        strictDeadline,
        async () => await notifyResourcesAfterShutdown(dependencies),
      );

      perf.end();
      return {
        timing: perf.getTimings(),
        alreadyStoppedMessage,
      };
    },
    failure: (error) => rethrowShutdownFailure(device, requestAbortSignal, error),
  });
}

type TeardownFailurePhase = "precondition" | "stop" | "destroy" | "verification";

type TeardownResolvedTarget =
  | {
      device: DeviceInfo;
      wasBooted: false;
    }
  | {
      device: DeviceInfo;
      wasBooted: true;
      bootedDevice: BootedDevice;
    };

function isVirtualAndroidDevice(device: BootedDevice): boolean {
  return device.platform === "android" && device.deviceId.startsWith("emulator-");
}

function resolveKillDeviceStableTarget(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): StableDeviceTarget | undefined {
  if (device.platform === "ios") {
    return { platform: "ios", stableId: device.deviceId };
  }
  if (!isVirtualAndroidDevice(device)) {
    return undefined;
  }
  if (!isUnknownAndroidRuntimeName(device)) {
    return { platform: "android", stableId: device.name };
  }
  const pooledAvdName = getValidatedPooledAndroidAvdName(device, devicePool);
  return pooledAvdName ? { platform: "android", stableId: pooledAvdName } : undefined;
}

function getValidatedPooledAndroidAvdName(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): string | undefined {
  if (device.platform !== "android" || !isUnknownAndroidRuntimeName(device)) {
    return undefined;
  }
  const pooled = devicePool?.getDevice(device.deviceId);
  if (
    !pooled?.avdName ||
    !pooled.transportId ||
    !device.transportId ||
    pooled.transportId !== device.transportId
  ) {
    return undefined;
  }
  return pooled.avdName;
}

function getBootedAndroidStableName(
  device: BootedDevice,
  devicePool: DevicePool | undefined,
): string {
  return getValidatedPooledAndroidAvdName(device, devicePool) ?? device.name;
}

function matchesTeardownStableId(
  device: BootedDevice,
  stableId: string,
  devicePool: DevicePool | undefined,
): boolean {
  return device.platform === "android" && isVirtualAndroidDevice(device)
    ? getBootedAndroidStableName(device, devicePool) === stableId
    : device.deviceId === stableId;
}

function teardownDeadlineDevice(args: TeardownDeviceArgs): BootedDevice {
  return {
    platform: args.target.platform,
    name: args.target.stableId,
    deviceId: args.target.stableId,
  };
}

function createTeardownResponse(
  args: TeardownDeviceArgs,
  state: "destroyed" | "already_absent",
  command: { stop: "accepted" | "not_required"; destroy: "accepted" | "not_required" },
  verification: { notRunning: "confirmed"; inventory: "complete_absence_confirmed" },
  resolved?: DeviceInfo,
  timing?: unknown,
) {
  return createJSONToolResponse({
    operationId: args.operationId,
    mode: args.mode,
    state,
    target: {
      stableId: args.target.stableId,
      stableName: args.target.stableName,
      platform: resolved?.platform ?? args.target.platform,
      isVirtual: args.target.isVirtual,
    },
    command,
    verification,
    timing,
  });
}

function createTeardownFailureResponse(
  args: TeardownDeviceArgs,
  phase: TeardownFailurePhase,
  code: string,
  message: string,
  resolved?: DeviceInfo,
) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          error: message,
          operationId: args.operationId,
          mode: args.mode,
          state: "failed",
          target: {
            stableId: args.target.stableId,
            stableName: args.target.stableName,
            platform: resolved?.platform ?? args.target.platform,
            isVirtual: args.target.isVirtual,
          },
          failure: { code, phase, message },
        }),
      },
    ],
  };
}

function findMatchingBootedTeardownDevices(
  discovery: BootedDeviceDiscovery,
  args: TeardownDeviceArgs,
  devicePool: DevicePool | undefined,
): BootedDevice[] {
  return discovery.devices.filter(
    (device) =>
      device.platform === args.target.platform &&
      matchesTeardownStableId(device, args.target.stableId, devicePool),
  );
}

function createBootedTeardownTarget(
  device: BootedDevice,
  args: TeardownDeviceArgs,
  devicePool: DevicePool | undefined,
): { target?: TeardownResolvedTarget; conflict?: string; unsupported?: string } {
  const stableName =
    device.platform === "android" ? getBootedAndroidStableName(device, devicePool) : device.name;
  if (args.target.stableName && args.target.stableName !== stableName) {
    return { conflict: "The requested stable name does not match the booted device identity." };
  }
  if (device.platform === "android" && !isVirtualAndroidDevice(device)) {
    return {
      unsupported:
        "Physical Android devices do not have a deletable platform device representation.",
    };
  }
  return {
    target: {
      device: {
        ...device,
        name: stableName,
        isRunning: true,
      },
      wasBooted: true,
      bootedDevice: {
        ...device,
        name: stableName,
      },
    },
  };
}

function findBootedTeardownTarget(
  discovery: BootedDeviceDiscovery,
  args: TeardownDeviceArgs,
  devicePool: DevicePool | undefined,
): { target?: TeardownResolvedTarget; conflict?: string; unsupported?: string } {
  const matchingId = findMatchingBootedTeardownDevices(discovery, args, devicePool);
  if (matchingId.length > 1) {
    return { conflict: "Multiple booted devices matched the requested stable ID." };
  }
  const device = matchingId[0];
  if (device) {
    if (
      device.platform === "android" &&
      isUnknownAndroidRuntimeName(device) &&
      !devicePool?.getDevice(device.deviceId)?.avdName
    ) {
      return {
        unsupported:
          "Cannot safely identify the requested booted Android AVD because its runtime name is unknown.",
      };
    }
    return createBootedTeardownTarget(device, args, devicePool);
  }
  return {};
}

function findInventoryTeardownTarget(
  discovery: DeviceImageDiscovery,
  args: TeardownDeviceArgs,
): { target?: TeardownResolvedTarget; conflict?: string } {
  const matches = discovery.devices.filter(
    (device) =>
      device.platform === args.target.platform &&
      (device.platform === "ios"
        ? device.deviceId === args.target.stableId
        : device.name === args.target.stableId),
  );
  if (matches.length > 1) {
    return {
      conflict: "Multiple platform device representations matched the requested stable ID.",
    };
  }
  const device = matches[0];
  if (device && args.target.stableName && args.target.stableName !== device.name) {
    return { conflict: "The requested stable name does not match the platform device identity." };
  }
  return device ? { target: { device: { ...device, isRunning: false }, wasBooted: false } } : {};
}

function inventoryContainsTarget(
  discovery: DeviceImageDiscovery,
  target: TeardownResolvedTarget,
): boolean {
  return discovery.devices.some(
    (device) =>
      device.platform === target.device.platform &&
      (device.platform === "ios"
        ? device.deviceId === target.device.deviceId
        : device.name === target.device.name),
  );
}

function completedInventoryFor(
  discovery: { succeededPlatforms: Set<SomePlatform> },
  platform: SomePlatform,
): boolean {
  return discovery.succeededPlatforms.has(platform);
}

type TeardownToolResponse =
  | ReturnType<typeof createTeardownResponse>
  | ReturnType<typeof createTeardownFailureResponse>;

function teardownOperationFingerprint(args: TeardownDeviceArgs): string {
  return stableStringify({
    target: args.target,
    mode: args.mode,
    verifyAbsence: args.verifyAbsence,
    timeoutMs: args.timeoutMs,
  });
}

function isTeardownFailure(response: TeardownToolResponse): boolean {
  return "isError" in response && response.isError === true;
}

let deviceTeardownService: DeviceTeardownService | undefined;

function getDeviceTeardownService(dependencies: DeviceToolsDependencies): DeviceTeardownService {
  deviceTeardownService ??= new DeviceTeardownService({
    lifecycleCoordinator: dependencies.lifecycleCoordinator,
    operationStore: dependencies.teardownDeviceOperationStoreFactory(),
    timer: dependencies.timer,
    resultTtlMs: TEARDOWN_OPERATION_RESULT_TTL_MS,
  });
  return deviceTeardownService;
}

type TeardownResolution = { target: TeardownResolvedTarget } | { response: TeardownToolResponse };

interface TeardownContext {
  args: TeardownDeviceArgs;
  dependencies: DeviceToolsDependencies;
  deviceManager: PlatformDeviceManager;
  requestAbortSignal: AbortSignal | undefined;
  deadlineDevice: BootedDevice;
  deadlineMs: number;
  timeoutMs: number;
  lifecycleLease?: VirtualDeviceLifecycleLease;
  initialAndroidRuntimeIds?: Set<string>;
}

async function stopSegmentedVideoRecordingsBeforeDestroy(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<void> {
  await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    "segmented video recording teardown did not complete",
    context.requestAbortSignal,
    async () => await stopSegmentedVideoRecordingsForDevice(target.device),
    context.timeoutMs,
  );
}

async function readTeardownBootedDiscovery(
  context: TeardownContext,
  detail = "booted-device precondition discovery did not complete",
): Promise<BootedDeviceDiscovery> {
  return await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    detail,
    context.requestAbortSignal,
    async () =>
      await context.deviceManager.getBootedDevicesDetailed(context.args.target.platform, {
        bypassAndroidDeviceListCache: true,
      }),
    context.timeoutMs,
  );
}

async function readTeardownInventory(
  context: TeardownContext,
  platform: SomePlatform,
  detail: string,
): Promise<DeviceImageDiscovery> {
  return await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    detail,
    context.requestAbortSignal,
    async () =>
      await context.deviceManager.getDeviceImagesDetailed(platform, {
        bypassIosDeviceListCache: true,
      }),
    context.timeoutMs,
  );
}

async function resolveAbsentTeardownTarget(
  context: TeardownContext,
  booted: BootedDeviceDiscovery,
  inventory: DeviceImageDiscovery,
): Promise<TeardownResolution> {
  const bootedComplete = completedInventoryFor(booted, context.args.target.platform);
  const inventoryComplete = completedInventoryFor(inventory, context.args.target.platform);
  if (!bootedComplete || !inventoryComplete) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "inventory_incomplete",
        "Cannot prove the target is absent because one or more platform inventories did not complete.",
      ),
    };
  }
  await retireAbsentTeardownOwnership(context);
  unregisterDirectSessionsForStableIdentity(
    context.args.target.platform,
    context.args.target.stableId,
  );
  void notifyResourcesAfterShutdown(context.dependencies);
  return {
    response: createTeardownResponse(
      context.args,
      "already_absent",
      { stop: "not_required", destroy: "not_required" },
      { notRunning: "confirmed", inventory: "complete_absence_confirmed" },
    ),
  };
}

async function resolveInventoryTeardownTarget(
  context: TeardownContext,
  booted: BootedDeviceDiscovery,
  inventory: DeviceImageDiscovery,
): Promise<TeardownResolution> {
  const resolution = findInventoryTeardownTarget(inventory, context.args);
  if (resolution.conflict) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_conflict",
        resolution.conflict,
      ),
    };
  }
  const target = resolution.target;
  if (!target) {
    return await resolveAbsentTeardownTarget(context, booted, inventory);
  }
  if (!completedInventoryFor(booted, target.device.platform)) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "booted_inventory_incomplete",
        `Cannot confirm ${target.device.platform} target '${target.device.name}' is not running.`,
        target.device,
      ),
    };
  }
  return { target };
}

async function resolveTeardownTarget(context: TeardownContext): Promise<TeardownResolution> {
  const booted = await readTeardownBootedDiscovery(context);
  if (context.args.target.platform === "android") {
    context.initialAndroidRuntimeIds = new Set(
      booted.devices
        .filter((device) => device.platform === "android")
        .map((device) => device.deviceId),
    );
  }
  const daemonState = DaemonState.getInstance();
  const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
  const bootedTarget = findBootedTeardownTarget(booted, context.args, devicePool);
  if (bootedTarget.conflict) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_conflict",
        bootedTarget.conflict,
      ),
    };
  }
  if (bootedTarget.unsupported) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_not_destroyable",
        bootedTarget.unsupported,
      ),
    };
  }
  if (bootedTarget.target) {
    return { target: bootedTarget.target };
  }
  const unresolvedAndroidRuntime = booted.devices.find(
    (device) =>
      device.platform === "android" &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device) &&
      !getValidatedPooledAndroidAvdName(device, devicePool),
  );
  if (unresolvedAndroidRuntime) {
    return {
      response: createTeardownFailureResponse(
        context.args,
        "precondition",
        "target_identity_unresolved",
        `Android emulator runtime '${unresolvedAndroidRuntime.deviceId}' has no resolvable AVD name; refusing deletion.`,
      ),
    };
  }
  const inventory = await readTeardownInventory(
    context,
    context.args.target.platform,
    "platform inventory precondition did not complete",
  );
  return await resolveInventoryTeardownTarget(context, booted, inventory);
}

function findStoppedTeardownPooledDevices(
  devicePool: DevicePool,
  target: TeardownResolvedTarget,
): PooledDevice[] {
  return devicePool
    .getAllDevices()
    .filter(
      (device) =>
        device.platform === target.device.platform &&
        (device.platform === "ios"
          ? device.id === target.device.deviceId
          : (device.avdName ?? device.name) === target.device.name),
    );
}

function findAbsentTeardownPooledDevices(
  devicePool: DevicePool,
  target: TeardownDeviceArgs["target"],
): PooledDevice[] {
  return devicePool
    .getAllDevices()
    .filter(
      (device) =>
        device.platform === target.platform &&
        (device.platform === "ios"
          ? device.id === target.stableId
          : (device.avdName ?? device.name) === target.stableId),
    );
}

async function retireTeardownPooledOwnership(
  context: TeardownContext,
  expectedPooledDevice: PooledDevice,
  name: string,
): Promise<void> {
  const devicePool = DaemonState.getInstance().getDevicePool();
  const reservation = await runWithinShutdownDeadline(
    context.deadlineDevice,
    context.dependencies.timer,
    context.deadlineMs,
    "stopped-device ownership reservation did not complete",
    context.requestAbortSignal,
    async (signal) => await devicePool.reserveDeviceForShutdown(expectedPooledDevice.id, signal),
    context.timeoutMs,
  );
  if (!reservation || reservation.device !== expectedPooledDevice) {
    await reservation?.release();
    return;
  }

  let retainsReservation = false;
  const retainReservationUntil = (retirement: Promise<unknown>): void => {
    retainsReservation = true;
    void retirement.then(
      () => reservation.release(),
      () => reservation.release(),
    );
  };
  const retirementDevice: BootedDevice = {
    platform: expectedPooledDevice.platform,
    name,
    deviceId: expectedPooledDevice.id,
    ...(expectedPooledDevice.transportId ? { transportId: expectedPooledDevice.transportId } : {}),
  };
  try {
    await stopVideoRecordingsBeforeShutdown(
      {
        device: retirementDevice,
        timer: context.dependencies.timer,
        deadlineMs: context.deadlineMs,
        timeoutMs: context.timeoutMs,
        requestAbortSignal: context.requestAbortSignal,
        retainReservationUntil,
      },
      createPerformanceTracker(true),
    );
    await retireShutdownOwnership(
      retirementDevice,
      expectedPooledDevice,
      undefined,
      context.deviceManager,
      context.dependencies.timer,
      context.deadlineMs,
      context.requestAbortSignal,
      context.dependencies.stopPerformanceMonitoring,
      retainReservationUntil,
      false,
      true,
      context.timeoutMs,
    );
  } finally {
    if (!retainsReservation) {
      await reservation.release();
    }
  }
}

async function retireStoppedTeardownOwnership(
  context: TeardownContext,
  target: TeardownResolvedTarget,
): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const expectedPooledDevices = findStoppedTeardownPooledDevices(
    daemonState.getDevicePool(),
    target,
  );
  for (const expectedPooledDevice of expectedPooledDevices) {
    await retireTeardownPooledOwnership(context, expectedPooledDevice, target.device.name);
  }
}

async function retireAbsentTeardownOwnership(context: TeardownContext): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const expectedPooledDevices = findAbsentTeardownPooledDevices(
    daemonState.getDevicePool(),
    context.args.target,
  );
  for (const expectedPooledDevice of expectedPooledDevices) {
    await retireTeardownPooledOwnership(
      context,
      expectedPooledDevice,
      expectedPooledDevice.platform === "android"
        ? (expectedPooledDevice.avdName ?? expectedPooledDevice.name)
        : expectedPooledDevice.name,
    );
  }
}

async function destroyTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  retainStableLifecycleUntil: (operation: Promise<unknown>) => void,
  markDestructionStarted: () => void,
): Promise<void> {
  const deadlineTarget: BootedDevice = {
    name: target.device.name,
    platform: target.device.platform,
    deviceId: target.device.deviceId ?? context.args.target.stableId,
  };
  let destroy: Promise<void> | undefined;
  try {
    await runWithinShutdownDeadline(
      deadlineTarget,
      context.dependencies.timer,
      context.deadlineMs,
      "platform deletion command did not complete",
      context.requestAbortSignal,
      async (signal, timeoutMs) => {
        markDestructionStarted();
        destroy = context.deviceManager.destroyDevice(target.device, {
          signal,
          timeoutMs,
          lifecycleLease: context.lifecycleLease,
        });
        return await destroy;
      },
      context.timeoutMs,
    );
  } catch (error) {
    if (destroy) {
      retainStableLifecycleUntil(destroy);
    }
    throw error;
  }
}

async function checkForRestartedTeardownTarget(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  phase: "stop" | "verification",
): Promise<TeardownToolResponse | undefined> {
  if (target.device.platform !== "android") {
    return undefined;
  }
  const booted = await readTeardownBootedDiscovery(
    context,
    phase === "stop"
      ? "post-shutdown booted-device discovery did not complete"
      : "post-delete booted-device discovery did not complete",
  );
  if (!completedInventoryFor(booted, target.device.platform)) {
    return createTeardownFailureResponse(
      context.args,
      phase,
      "booted_inventory_incomplete",
      "Cannot confirm the Android AVD is not running.",
      target.device,
    );
  }
  const daemonState = DaemonState.getInstance();
  const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
  const newlyAppearedUnresolvedRuntime = booted.devices.find(
    (device) =>
      device.platform === "android" &&
      isVirtualAndroidDevice(device) &&
      isUnknownAndroidRuntimeName(device) &&
      !getValidatedPooledAndroidAvdName(device, devicePool) &&
      (!context.initialAndroidRuntimeIds?.has(device.deviceId) ||
        (target.wasBooted && device.deviceId === target.bootedDevice.deviceId)),
  );
  if (newlyAppearedUnresolvedRuntime) {
    return createTeardownFailureResponse(
      context.args,
      phase,
      "target_identity_unresolved",
      `A new Android emulator runtime '${newlyAppearedUnresolvedRuntime.deviceId}' appeared ` +
        "without a resolvable AVD name; refusing deletion.",
      target.device,
    );
  }
  const replacement = findMatchingBootedTeardownDevices(booted, context.args, devicePool)[0];
  if (!replacement) {
    return undefined;
  }
  return createTeardownFailureResponse(
    context.args,
    phase,
    phase === "stop" ? "target_restarted" : "target_still_running",
    phase === "stop"
      ? "The Android AVD restarted after shutdown confirmation; refusing deletion."
      : "The Android AVD is still running after deletion.",
    target.device,
  );
}

async function verifyTeardownAbsence(
  context: TeardownContext,
  target: TeardownResolvedTarget,
  stop: "accepted" | "not_required",
): Promise<TeardownToolResponse> {
  const restarted = await checkForRestartedTeardownTarget(context, target, "verification");
  if (restarted) {
    return restarted;
  }
  const inventory = await readTeardownInventory(
    context,
    target.device.platform,
    "post-delete platform inventory did not complete",
  );
  if (!completedInventoryFor(inventory, target.device.platform)) {
    return createTeardownFailureResponse(
      context.args,
      "verification",
      "inventory_incomplete",
      "The platform deletion command completed, but durable absence could not be verified.",
      target.device,
    );
  }
  if (inventoryContainsTarget(inventory, target)) {
    return createTeardownFailureResponse(
      context.args,
      "verification",
      "target_still_present",
      "The platform deletion command completed, but the target is still present in inventory.",
      target.device,
    );
  }
  void notifyResourcesAfterShutdown(context.dependencies);
  return createTeardownResponse(
    context.args,
    "destroyed",
    { stop, destroy: "accepted" },
    { notRunning: "confirmed", inventory: "complete_absence_confirmed" },
    target.device,
  );
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
      exactDeviceProvisionerFactory: (deviceManager, deviceCreationGate) =>
        createDefaultExactDeviceProvisioner(deviceManager, deviceCreationGate),
      provisionDeviceOperationStoreFactory: () => new ProvisionDeviceOperationRepository(),
      teardownDeviceOperationStoreFactory: () => new DeviceTeardownOperationRepository(),
      clearInstalledAppsForDevice: defaultClearInstalledAppsForDevice,
      stopPerformanceMonitoring: (deviceId) => getPerformanceMonitor().stopMonitoring(deviceId),
      stopAndroidObservers: defaultStopAndroidObservers,
      idGenerator: defaultIdGenerator,
      timer: defaultTimer,
      lifecycleCoordinator: getVirtualDeviceLifecycleCoordinator(),
    };
  }
  return moduleDependencies;
}

function provisionDeviceDependencyOverrides(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): Pick<
  DeviceToolsDependencies,
  "exactDeviceProvisionerFactory" | "provisionDeviceOperationStoreFactory"
> {
  return {
    exactDeviceProvisionerFactory:
      deps.exactDeviceProvisionerFactory ?? currentDeps.exactDeviceProvisionerFactory,
    provisionDeviceOperationStoreFactory:
      deps.provisionDeviceOperationStoreFactory ?? currentDeps.provisionDeviceOperationStoreFactory,
  };
}

function resolveDeviceToolsLifecycleCoordinator(
  deps: Partial<DeviceToolsDependencies>,
  currentDeps: DeviceToolsDependencies,
): VirtualDeviceLifecycleCoordinator {
  if (deps.lifecycleCoordinator) {
    return deps.lifecycleCoordinator;
  }
  return deps.timer
    ? new InMemoryVirtualDeviceLifecycleCoordinator(deps.timer)
    : currentDeps.lifecycleCoordinator;
}

// The override merger intentionally keeps all dependency seams in one place.
// oxlint-disable-next-line complexity
export function setDeviceToolsDependencies(deps: Partial<DeviceToolsDependencies>): void {
  const currentDeps = getDeviceToolsDependencies();
  moduleDependencies = {
    deviceManagerFactory: deps.deviceManagerFactory ?? currentDeps.deviceManagerFactory,
    deviceMatcherFactory: deps.deviceMatcherFactory ?? currentDeps.deviceMatcherFactory,
    notifyResourcesChanged: deps.notifyResourcesChanged ?? currentDeps.notifyResourcesChanged,
    ensureCtrlProxyReady: deps.ensureCtrlProxyReady ?? currentDeps.ensureCtrlProxyReady,
    deviceCreationGateFactory:
      deps.deviceCreationGateFactory ?? currentDeps.deviceCreationGateFactory,
    deviceProvisionerFactory: deps.deviceProvisionerFactory ?? currentDeps.deviceProvisionerFactory,
    ...provisionDeviceDependencyOverrides(deps, currentDeps),
    teardownDeviceOperationStoreFactory:
      deps.teardownDeviceOperationStoreFactory ?? currentDeps.teardownDeviceOperationStoreFactory,
    clearInstalledAppsForDevice:
      deps.clearInstalledAppsForDevice ?? currentDeps.clearInstalledAppsForDevice,
    stopPerformanceMonitoring:
      deps.stopPerformanceMonitoring ?? currentDeps.stopPerformanceMonitoring,
    stopAndroidObservers: deps.stopAndroidObservers ?? currentDeps.stopAndroidObservers,
    idGenerator: deps.idGenerator ?? currentDeps.idGenerator,
    timer: deps.timer ?? currentDeps.timer,
    lifecycleCoordinator: resolveDeviceToolsLifecycleCoordinator(deps, currentDeps),
  };
}

export function resetDeviceToolsDependencies(): void {
  deviceTeardownService?.dispose();
  deviceTeardownService = undefined;
  moduleDependencies = null;
  activeProvisionDeviceOperations.clear();
}

function describeStartDeviceRequest(args: StartDeviceArgs): string {
  return [
    `platform=${args.platform}`,
    args.deviceId ? `deviceId=${args.deviceId}` : undefined,
    args.name ? `name=${args.name}` : undefined,
    args.minOsVersion ? `minOsVersion=${args.minOsVersion}` : undefined,
    args.maxOsVersion ? `maxOsVersion=${args.maxOsVersion}` : undefined,
    args.formFactor ? `formFactor=${args.formFactor}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");
}

function resolveRunnerReadinessTimeoutMs(args: StartDeviceArgs): number {
  return (
    args.runnerReadinessTimeoutMs ?? args.timeoutMs ?? serverConfig.getRunnerReadinessTimeoutMs()
  );
}

function provisionDeviceFingerprint(args: ProvisionDeviceArgs): string {
  return createHash("sha256")
    .update(
      stableStringify({
        device: args.device,
        boot: args.boot,
        readiness: args.readiness,
        timeoutMs: args.timeoutMs,
      }),
    )
    .digest("hex");
}

function parseProvisionDeviceArgs(input: ProvisionDeviceArgs): ProvisionDeviceArgs {
  const __mcpSessionId = input.__mcpSessionId;
  const publicInput: Record<string, unknown> = { ...input };
  delete publicInput.__mcpSessionId;
  delete publicInput.__executionId;
  delete publicInput.__executionStartTime;
  const parsed = provisionDeviceSchema.parse(publicInput);
  return {
    ...parsed,
    boot: parsed.boot ?? true,
    readiness: parsed.readiness ?? "automation",
    __mcpSessionId,
  };
}

function provisionDeviceTimeoutError(phase: string): ProvisionDeviceError {
  return new ProvisionDeviceError(
    "timeout",
    `provisionDevice timeout exhausted while ${phase}; remainingBudgetMs=0`,
  );
}

async function runProvisionDeviceWithinDeadline<T>(
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">,
  totalDeadlineMs: number,
  requestSignal: AbortSignal | undefined,
  phase: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remainingMs = Math.floor(totalDeadlineMs - timer.now());
  if (remainingMs <= 0) {
    throw provisionDeviceTimeoutError(phase);
  }

  const controller = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, controller.signal])
    : controller.signal;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  const operationPromise = operation(signal);
  void operationPromise.catch(() => {});

  try {
    return await Promise.race([
      operationPromise,
      new Promise<never>((_resolve, reject) => {
        timeoutHandle = timer.setTimeout(() => {
          const error = provisionDeviceTimeoutError(phase);
          controller.abort(error);
          reject(error);
        }, remainingMs);
      }),
      ...(requestSignal
        ? [
            new Promise<never>((_resolve, reject) => {
              const rejectForAbort = () => reject(requestSignal.reason);
              if (requestSignal.aborted) {
                rejectForAbort();
                return;
              }
              requestSignal.addEventListener("abort", rejectForAbort, { once: true });
              removeAbortListener = () =>
                requestSignal.removeEventListener("abort", rejectForAbort);
            }),
          ]
        : []),
    ]);
  } finally {
    if (timeoutHandle) {
      timer.clearTimeout(timeoutHandle);
    }
    removeAbortListener?.();
  }
}

async function waitForSharedOperation<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    throw signal.reason;
  }

  let removeAbortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        const rejectForAbort = () => reject(signal.reason);
        signal.addEventListener("abort", rejectForAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", rejectForAbort);
      }),
    ]);
  } finally {
    removeAbortListener?.();
  }
}

function createProvisionDeviceResponse(result: Record<string, unknown>) {
  const device = result.device as { name: string; platform: string };
  return createJSONToolResponse({
    message: `${device.platform} '${device.name}' provisioned (${result.lifecycleState})`,
    ...result,
  });
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

function cancelUnownedColdBoot(boot: DeviceBootResult | undefined): Promise<void> | undefined {
  if (boot?.source !== "cold-boot" || !boot.processHandle) {
    return undefined;
  }
  const daemonState = DaemonState.getInstance();
  if (
    daemonState.isInitialized() &&
    daemonState.getDevicePool().hasStartedDeviceProcess(boot.device.deviceId, boot.processHandle)
  ) {
    logger.info(
      `[DeviceTools] Cold boot ${boot.device.deviceId} process ownership transferred before cleanup`,
    );
    return undefined;
  }
  const processSettlement =
    typeof boot.processHandle.once !== "function" ||
    boot.processHandle.exitCode !== null ||
    boot.processHandle.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          boot.processHandle?.once("exit", () => resolve());
        });
  try {
    boot.processHandle.kill();
  } catch (error) {
    logger.warn(
      `[DeviceTools] Failed to cancel unowned cold boot ${boot.device.deviceId}: ${error}`,
      error,
    );
  }
  return processSettlement;
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

function isUnknownAndroidRuntimeName(device: BootedDevice): boolean {
  return device.name === `Unknown (${device.deviceId})`;
}

async function resolveSystemUiRecoveryImage(
  boot: DeviceBootResult,
  deviceManager: PlatformDeviceManager,
  devicePool: DevicePool | undefined,
  timer: Timer,
  totalDeadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<DeviceInfo> {
  const pooled = devicePool?.getDevice(boot.device.deviceId);
  const avdName =
    pooled?.avdName ??
    (boot.sourceImage?.platform === "android" ? boot.sourceImage.name : undefined) ??
    (isUnknownAndroidRuntimeName(boot.device) ? undefined : boot.device.name);
  if (!avdName) {
    throw new ActionableError(
      `Cannot restart Android device '${boot.device.deviceId}' after a System UI ANR because its AVD name is unknown.`,
    );
  }
  const images = await runWithinShutdownDeadline(
    boot.device,
    timer,
    totalDeadlineMs,
    "System UI recovery image lookup did not complete",
    signal,
    async () => await deviceManager.listDeviceImages("android"),
  );
  const image = images.find(
    (candidate) => candidate.platform === "android" && candidate.name === avdName,
  );
  if (!image) {
    throw new ActionableError(
      `Cannot restart Android device '${boot.device.deviceId}' after a System UI ANR because AVD '${avdName}' is unavailable.`,
    );
  }
  return { ...image, isRunning: false };
}

async function rebootAndroidAfterSystemUiAnr(
  boot: DeviceBootResult,
  args: StartDeviceArgs,
  bootService: DeviceBootService,
  deviceManager: PlatformDeviceManager,
  devicePool: DevicePool | undefined,
  totalDeadlineMs: number,
  timer: Timer,
  signal: AbortSignal | undefined,
  progress: { report: ProgressCallback } | undefined,
): Promise<{
  boot: DeviceBootResult;
  preservedSessionId?: string;
  releaseReadinessReservation?: DeviceReadinessReservation;
  retireReplacement?: () => Promise<void>;
  validatePreservedSession?: () => Promise<void>;
}> {
  const sourceImage = await resolveSystemUiRecoveryImage(
    boot,
    deviceManager,
    devicePool,
    timer,
    totalDeadlineMs,
    signal,
  );
  const releaseReadinessReservation = devicePool
    ? await devicePool.reserveDeviceForReadiness(
        boot.device.deviceId,
        boot.device,
        sourceImage.name,
        sourceImage.name,
      )
    : undefined;
  let shutdownReservation: Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>;
  let shutdownWasConfirmed = false;
  let keepReadinessReservation = false;
  let replacementBoot: DeviceBootResult | undefined;
  try {
    shutdownReservation = await reserveSystemUiAnrShutdown(
      devicePool,
      boot.device.deviceId,
      signal,
    );
    await shutdownAndroidForSystemUiAnr(boot.device, deviceManager, timer, totalDeadlineMs, signal);
    shutdownWasConfirmed = true;

    replacementBoot = await bootSystemUiAnrReplacement(
      bootService,
      args,
      sourceImage,
      totalDeadlineMs,
      signal,
      progress,
    );
    const adoptedReplacementBoot = replacementBoot;
    const handoff = await handoffSystemUiAnrReplacement(
      devicePool,
      shutdownReservation,
      adoptedReplacementBoot,
      sourceImage,
    );
    keepReadinessReservation = true;
    return {
      boot: adoptedReplacementBoot,
      preservedSessionId: handoff?.preservedSessionId,
      releaseReadinessReservation,
      retireReplacement: async () =>
        await retireSystemUiAnrReplacement(
          devicePool,
          handoff?.replacementDevice,
          adoptedReplacementBoot,
        ),
      validatePreservedSession: handoff?.validatePreservedSession,
    };
  } catch (error) {
    // The pool rolls an adopted replacement back before rejecting its handoff,
    // so any replacement still in scope here is safe to cancel as an unowned
    // cold boot.
    void cancelUnownedColdBoot(replacementBoot);
    try {
      await cleanUpFailedSystemUiAnrRecovery(
        devicePool,
        shutdownReservation,
        shutdownWasConfirmed,
        boot.device.deviceId,
        signal,
      );
    } catch (cleanupError) {
      logger.warn(
        `[DeviceTools] Failed to clean up after System UI ANR recovery failure: ${cleanupError}`,
        cleanupError,
      );
    }
    throw error;
  } finally {
    await shutdownReservation?.release();
    if (!keepReadinessReservation) {
      await releaseReadinessReservation?.();
    }
  }
}

async function reserveSystemUiAnrShutdown(
  devicePool: DevicePool | undefined,
  deviceId: string,
  signal: AbortSignal | undefined,
): Promise<Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>> {
  if (!devicePool) {
    return undefined;
  }
  const reservation = await devicePool.reserveDeviceForShutdown(deviceId, signal);
  if (reservation) {
    devicePool.markIntentionalShutdown(deviceId);
  }
  return reservation;
}

async function shutdownAndroidForSystemUiAnr(
  device: BootedDevice,
  deviceManager: PlatformDeviceManager,
  timer: Timer,
  totalDeadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const shutdownDevice = await runWithinShutdownDeadline(
    device,
    timer,
    totalDeadlineMs,
    "System UI recovery shutdown command did not complete",
    signal,
    async (shutdownSignal, timeoutMs) =>
      await deviceManager.killDevice(device, { signal: shutdownSignal, timeoutMs }),
  );
  await waitForDeviceShutdown(
    deviceManager,
    shutdownDevice ?? device,
    timer,
    totalDeadlineMs,
    signal,
  );
}

async function bootSystemUiAnrReplacement(
  bootService: DeviceBootService,
  args: StartDeviceArgs,
  sourceImage: DeviceInfo,
  totalDeadlineMs: number,
  signal: AbortSignal | undefined,
  progress: { report: ProgressCallback } | undefined,
): Promise<DeviceBootResult> {
  const replacement = await bootService.boot(
    {
      ...args,
      deviceId: undefined,
      name: sourceImage.name,
      preferRunning: false,
      totalDeadlineMs,
      signal,
    },
    progress,
  );
  return { ...replacement, sourceImage };
}

async function handoffSystemUiAnrReplacement(
  devicePool: DevicePool | undefined,
  shutdownReservation: Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>,
  replacementBoot: DeviceBootResult,
  sourceImage: DeviceInfo,
): Promise<Awaited<ReturnType<DevicePool["replaceDeviceForSystemUiAnrRecovery"]>> | undefined> {
  if (!devicePool || !shutdownReservation) {
    return undefined;
  }
  return await devicePool.replaceDeviceForSystemUiAnrRecovery(
    shutdownReservation.device,
    replacementBoot.device,
    sourceImage,
    replacementBoot.processHandle,
  );
}

async function cleanUpFailedSystemUiAnrRecovery(
  devicePool: DevicePool | undefined,
  shutdownReservation: Awaited<ReturnType<DevicePool["reserveDeviceForShutdown"]>>,
  shutdownWasConfirmed: boolean,
  deviceId: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!shutdownReservation) {
    return;
  }
  if (shutdownWasConfirmed) {
    await devicePool?.retireDeviceAfterSystemUiAnrRecoveryFailure(shutdownReservation.device);
    return;
  }
  // Caller cancellation may have already stopped the emulator while shutdown
  // confirmation was still in flight. Retain the intentional-shutdown marker so
  // the deferred process-exit is not treated as unexpected loss, mirroring the
  // regular kill path's guard.
  if (shouldClearIntentionalShutdownAfterFailure("android", signal)) {
    devicePool?.clearIntentionalShutdown(deviceId);
  }
}

async function retireSystemUiAnrReplacement(
  devicePool: DevicePool | undefined,
  expectedReplacement: PooledDevice | undefined,
  replacementBoot: DeviceBootResult,
): Promise<void> {
  try {
    if (expectedReplacement) {
      await devicePool?.retireDeviceAfterSystemUiAnrRecoveryFailure(expectedReplacement);
    }
  } finally {
    // Retiring the pool entry drops its process tracking, allowing the existing
    // cold-boot cleanup to terminate this recovered emulator deterministically.
    void cancelUnownedColdBoot(replacementBoot);
  }
}

type SystemUiAnrRecoveryResult = Awaited<ReturnType<typeof rebootAndroidAfterSystemUiAnr>>;

async function validatePreservedSystemUiAnrRecoverySession(
  preservedSessionId: string | undefined,
  validatePreservedSession: (() => Promise<void>) | undefined,
  retireReplacement: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!preservedSessionId) {
    return;
  }
  try {
    await validatePreservedSession?.();
  } catch (error) {
    try {
      await retireReplacement?.();
    } catch (retireError) {
      logger.warn(
        `[DeviceTools] Failed to retire stale System UI recovery replacement: ${retireError}`,
        retireError,
      );
    }
    throw error;
  }
}

async function ensureRunnerReadyWithSystemUiAnrRecovery(
  boot: DeviceBootResult,
  ensureRunnerReady: (candidate: DeviceBootResult) => Promise<void>,
  rebootAfterSystemUiAnr: (candidate: DeviceBootResult) => Promise<SystemUiAnrRecoveryResult>,
): Promise<SystemUiAnrRecoveryResult & { recovered: boolean }> {
  try {
    await ensureRunnerReady(boot);
    return { boot, recovered: false };
  } catch (error) {
    if (
      !(error instanceof SystemUiAnrRecoveryRequiredError) ||
      boot.device.platform !== "android"
    ) {
      throw error;
    }
    const recovery = await rebootAfterSystemUiAnr(boot);
    try {
      await ensureRunnerReady(recovery.boot);
    } catch (readinessError) {
      try {
        await recovery.retireReplacement?.();
      } catch (retireError) {
        logger.warn(
          `[DeviceTools] Failed to retire System UI recovery replacement: ${retireError}`,
          retireError,
        );
      }
      try {
        // rebootAfterSystemUiAnr retained the readiness reservation for the
        // replacement, but it only reaches the caller's ordered cleanup once this
        // returns. Release it here so a failed second readiness check does not
        // strand the recovered AVD out of general allocation forever.
        await recovery.releaseReadinessReservation?.();
      } catch (releaseError) {
        logger.warn(
          `[DeviceTools] Failed to release System UI recovery readiness reservation: ${releaseError}`,
          releaseError,
        );
      }
      throw readinessError;
    }
    return { ...recovery, recovered: true };
  }
}

async function reserveRecoveredDeviceForReadiness(
  devicePool: DevicePool | undefined,
  boot: DeviceBootResult,
  args: StartDeviceArgs,
  requestedIdentity: string,
  releaseReadinessReservations: DeviceReadinessReservation[],
): Promise<void> {
  validateBootIdentity(args, boot.device, boot.source, boot.sourceImage);
  validatePooledDeviceMapping(boot.device, requestedIdentity);
  if (devicePool) {
    releaseReadinessReservations.push(
      await devicePool.reserveDeviceForReadiness(
        boot.device.deviceId,
        boot.device,
        boot.sourceImage?.name ?? boot.device.name,
      ),
    );
  }
  clearColdBootShutdownMarker(boot.source, boot.device.deviceId);
}

async function reserveInitialDeviceForReadiness(
  daemonState: DaemonState,
  boot: DeviceBootResult,
  releaseReadinessReservations: DeviceReadinessReservation[],
): Promise<void> {
  const devicePool = getStartDevicePool(daemonState);
  if (!devicePool) {
    return;
  }
  releaseReadinessReservations.push(
    await devicePool.reserveDeviceForReadiness(
      boot.device.deviceId,
      boot.device,
      boot.sourceImage?.name ?? boot.device.name,
    ),
  );
}

async function notifyResourcesAfterDeviceBoot(
  boot: DeviceBootResult,
  perf: ReturnType<typeof createPerformanceTracker>,
  notifyResourcesChanged: () => Promise<void>,
): Promise<void> {
  if (boot.source !== "cold-boot" && !boot.provisioned) {
    return;
  }
  perf.startOperation("notifyResources");
  await notifyResourcesChanged();
  perf.endOperation("notifyResources");
}

interface StartDeviceRunnerReadinessInput {
  boot: DeviceBootResult;
  args: StartDeviceArgs;
  bootService: DeviceBootService;
  deviceUtils: PlatformDeviceManager;
  daemonState: DaemonState;
  totalDeadlineMs: number;
  readinessTimeoutMs: number;
  timer: Timer;
  signal: AbortSignal | undefined;
  progress: ProgressCallback | undefined;
  perf: ReturnType<typeof createPerformanceTracker>;
  requestedIdentity: string;
  ensureCtrlProxyReady: (request: RunnerReadinessRequest) => Promise<void>;
  releaseReadinessReservations: DeviceReadinessReservation[];
}

async function prepareStartDeviceRunnerReadiness(
  input: StartDeviceRunnerReadinessInput,
): Promise<SystemUiAnrRecoveryResult & { recovered: boolean }> {
  const devicePool = getStartDevicePool(input.daemonState);
  const readinessResult = await ensureRunnerReadyWithSystemUiAnrRecovery(
    input.boot,
    createRunnerReadinessAttempt(input),
    createSystemUiAnrRebooter(input, devicePool),
  );
  if (readinessResult.recovered) {
    try {
      await prepareRecoveredDeviceForRunnerReadiness(input, devicePool, readinessResult);
    } catch (error) {
      try {
        await readinessResult.retireReplacement?.();
      } catch (cleanupError) {
        logger.warn(
          `[DeviceTools] Failed to retire replacement after recovered readiness reservation failed: ${cleanupError}`,
          cleanupError,
        );
      }
      throw error;
    }
  }
  return readinessResult;
}

function getStartDevicePool(daemonState: DaemonState): DevicePool | undefined {
  return daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
}

async function reserveAndroidStartupLease(
  args: StartDeviceArgs,
  budgets: { androidAvdName?: string },
  bootDeadlineMs: number,
  timer: Timer,
  signal?: AbortSignal,
): Promise<(() => Promise<void>) | undefined> {
  if (args.platform !== "android") {
    return undefined;
  }
  const devicePool = getStartDevicePool(DaemonState.getInstance());
  if (!devicePool) {
    return undefined;
  }
  const remainingMs = bootDeadlineMs - timer.now();
  const requestedName = budgets.androidAvdName ?? args.name;
  if (remainingMs <= 0) {
    throw new ActionableError(
      `Timed out waiting for Android AVD reset recovery${requestedName ? ` of '${requestedName}'` : ""}`,
    );
  }
  const timeoutController = new AbortController();
  const abortForTimeout = () =>
    timeoutController.abort(
      new ActionableError(
        `Timed out waiting for Android AVD reset recovery${requestedName ? ` of '${requestedName}'` : ""}`,
      ),
    );
  const abortForCaller = () =>
    timeoutController.abort(signal?.reason ?? new Error("Device preparation cancelled"));
  if (signal?.aborted) {
    abortForCaller();
  } else {
    signal?.addEventListener("abort", abortForCaller, { once: true });
  }
  const timeout = timer.setTimeout(abortForTimeout, remainingMs);
  try {
    return await devicePool.reserveAndroidStartupLease(
      requestedName,
      budgets.androidAvdName !== undefined,
      timeoutController.signal,
    );
  } finally {
    timer.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortForCaller);
  }
}

function createRunnerReadinessAttempt(
  input: StartDeviceRunnerReadinessInput,
): (candidate: DeviceBootResult) => Promise<void> {
  return async (candidate) =>
    await input.ensureCtrlProxyReady({
      device: candidate.device,
      requestedIdentity: input.requestedIdentity,
      totalDeadlineMs: input.totalDeadlineMs,
      readinessTimeoutMs: input.readinessTimeoutMs,
      skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
      perf: input.perf,
      signal: input.signal,
    });
}

function createSystemUiAnrRebooter(
  input: StartDeviceRunnerReadinessInput,
  devicePool: DevicePool | undefined,
): (candidate: DeviceBootResult) => Promise<SystemUiAnrRecoveryResult> {
  return async (candidate) =>
    await rebootAndroidAfterSystemUiAnr(
      candidate,
      input.args,
      input.bootService,
      input.deviceUtils,
      devicePool,
      input.totalDeadlineMs,
      input.timer,
      input.signal,
      input.progress ? { report: input.progress } : undefined,
    );
}

async function prepareRecoveredDeviceForRunnerReadiness(
  input: StartDeviceRunnerReadinessInput,
  devicePool: DevicePool | undefined,
  recovery: SystemUiAnrRecoveryResult,
): Promise<void> {
  if (recovery.releaseReadinessReservation) {
    input.releaseReadinessReservations.push(recovery.releaseReadinessReservation);
  }
  await reserveRecoveredDeviceForReadiness(
    devicePool,
    recovery.boot,
    input.args,
    input.requestedIdentity,
    input.releaseReadinessReservations,
  );
}

function getVerifiedWarmAndroidAvdIdentity(
  boot: DeviceBootResult,
  sourceImage: DeviceInfo | undefined,
): DeviceInfo | undefined {
  if (boot.source === "booted" && sourceImage?.platform === "android") {
    return sourceImage;
  }
  return undefined;
}

async function resolveAndroidStartStableDeviceLifecycleTarget(
  deviceId: string,
  deadlineMs: number,
  deviceUtils: PlatformDeviceManager,
  timer: Timer,
  signal: AbortSignal | undefined,
): Promise<StableDeviceTarget | undefined> {
  const bootedDiscovery = await runWithinShutdownDeadline(
    { name: deviceId, platform: "android", deviceId },
    timer,
    deadlineMs,
    "Android booted-device identity discovery did not complete",
    signal,
    async () =>
      await deviceUtils.getBootedDevicesDetailed("android", {
        bypassAndroidDeviceListCache: true,
      }),
  );
  const bootedMatches = bootedDiscovery.devices.filter(
    (device) => device.platform === "android" && device.deviceId === deviceId,
  );
  if (bootedMatches.length > 1) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  const bootedMatch = bootedMatches[0];
  if (bootedMatch && !isVirtualAndroidDevice(bootedMatch)) {
    // Physical devices have no AVD representation; coordinate by the request selector.
    return undefined;
  }

  const imageDiscovery = await runWithinShutdownDeadline(
    { name: deviceId, platform: "android", deviceId },
    timer,
    deadlineMs,
    "Android AVD identity discovery did not complete",
    signal,
    async () => await deviceUtils.getDeviceImagesDetailed("android"),
  );
  if (!imageDiscovery.succeededPlatforms.has("android")) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  const imageMatches = imageDiscovery.devices.filter(
    (device) =>
      device.platform === "android" && (device.deviceId === deviceId || device.name === deviceId),
  );
  if (imageMatches.length > 1) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  if (imageMatches.length === 1) {
    return { platform: "android", stableId: imageMatches[0].name };
  }

  const daemonState = DaemonState.getInstance();
  const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
  const stableIds = new Set(
    bootedMatches.map((device) => getBootedAndroidStableName(device, devicePool)),
  );
  if (stableIds.size === 0) {
    if (!bootedDiscovery.succeededPlatforms.has("android")) {
      throw new ActionableError(
        `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
      );
    }
    return undefined;
  }
  if (
    stableIds.size !== 1 ||
    bootedMatches.some(
      (device) =>
        isUnknownAndroidRuntimeName(device) &&
        !getValidatedPooledAndroidAvdName(device, devicePool),
    )
  ) {
    throw new ActionableError(
      `Cannot uniquely resolve Android device '${deviceId}' for lifecycle coordination.`,
    );
  }
  return { platform: "android", stableId: [...stableIds][0] };
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
        platform: args.platform,
      });
    } catch (error) {
      throw new ActionableError(`Failed to list ${args.platform} AVDs: ${error}`);
    }
  };

  const listDevicesHandler = async (args: ListDevicesArgs) => {
    const platformFilter = args.platform ? ` (${args.platform} only)` : "";

    return createJSONToolResponse({
      message:
        `To list devices${platformFilter}, use these MCP resources:\n\n` +
        "RUNNING DEVICES (booted/active):\n" +
        `  - automobile:devices/booted - All running devices\n` +
        `  - automobile:devices/booted/android - Android devices only\n` +
        `  - automobile:devices/booted/ios - iOS simulators only\n\n` +
        "AVAILABLE DEVICE IMAGES (can be started):\n" +
        `  - automobile:devices/images - All available images\n` +
        `  - automobile:devices/images/android - Android AVDs\n` +
        `  - automobile:devices/images/ios - iOS simulator runtimes\n\n` +
        "WORKFLOW:\n" +
        "  1. Read 'automobile:devices/images/android' to select an Android AVD by name\n" +
        "  2. Read 'automobile:devices/images/ios' to select an iOS simulator by UDID\n" +
        "  3. Call getAndroid or getApple, then use its returned sessionId for automation",
      resources: [
        BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED,
        `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/android`,
        `${BOOTED_DEVICE_RESOURCE_URIS.ALL_BOOTED}/ios`,
        DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES,
        `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/android`,
        `${DEVICE_IMAGE_RESOURCE_URIS.ALL_IMAGES}/ios`,
      ],
      note: "All resource URIs use the 'automobile:' prefix. URIs like 'android://devices' are not supported.",
    });
  };

  const provisionDeviceHandler = async (
    input: ProvisionDeviceArgs,
    _progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const args = parseProvisionDeviceArgs(input);
    const fingerprint = provisionDeviceFingerprint(args);
    const active = activeProvisionDeviceOperations.get(args.operationId);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        return createToolErrorResponse(
          "operation_conflict",
          `operationId '${args.operationId}' is already running with a different provisionDevice request.`,
        );
      }
      try {
        return createProvisionDeviceResponse(await waitForSharedOperation(active.promise, signal));
      } catch (error) {
        return provisionDeviceErrorResponse(error);
      }
    }

    const sharedController = new AbortController();
    const promise = executeProvisionDevice(args, fingerprint, sharedController.signal);
    activeProvisionDeviceOperations.set(args.operationId, { fingerprint, promise });
    void promise.then(
      () => {
        if (activeProvisionDeviceOperations.get(args.operationId)?.promise === promise) {
          activeProvisionDeviceOperations.delete(args.operationId);
        }
      },
      () => {
        if (activeProvisionDeviceOperations.get(args.operationId)?.promise === promise) {
          activeProvisionDeviceOperations.delete(args.operationId);
        }
      },
    );
    try {
      return createProvisionDeviceResponse(await waitForSharedOperation(promise, signal));
    } catch (error) {
      return provisionDeviceErrorResponse(error);
    }
  };

  async function executeProvisionDevice(
    args: ProvisionDeviceArgs,
    fingerprint: string,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const deps = getDeviceToolsDependencies();
    const store = deps.provisionDeviceOperationStoreFactory();
    const operation = await store.begin(args.operationId, fingerprint);
    try {
      if (!operation.started) {
        if (
          await canReplayCompletedProvisionDeviceOperation(args, deps, operation.result, signal)
        ) {
          return operation.result;
        }
        await releaseErroredProvisionDeviceSession(operation.result);

        // Sessions are daemon-local and are expired during daemon startup. A
        // replay of a completed boot operation therefore runs the idempotent
        // lifecycle again to bind a live session before reporting readiness.
        const rebound = await runProvisionDeviceLifecycle(
          args,
          deps,
          operation.reconcileExistingConfiguration,
          () => store.markDeviceCreationStarted(args.operationId),
          signal,
        );
        const refreshed = preserveProvisionDeviceOwnership(operation.result, rebound);
        await completeProvisionDeviceOperation(store, args.operationId, refreshed);
        return refreshed;
      }

      const result = await runProvisionDeviceLifecycle(
        args,
        deps,
        operation.reconcileExistingConfiguration,
        () => store.markDeviceCreationStarted(args.operationId),
        signal,
      );
      await completeProvisionDeviceOperation(store, args.operationId, result);
      return result;
    } catch (error) {
      const provisionError = toProvisionDeviceError(args, error);
      await store.fail(args.operationId, provisionError.code, provisionError.message);
      throw provisionError;
    }
  }

  interface PersistedProvisionDevice {
    name: string;
    platform: "android" | "ios";
    deviceId?: string;
  }

  function getPersistedProvisionDevice(
    result: Record<string, unknown>,
  ): PersistedProvisionDevice | undefined {
    const device = result.device;
    if (typeof device !== "object" || device === null || Array.isArray(device)) {
      return undefined;
    }
    const deviceRecord = device as Record<string, unknown>;
    if (typeof deviceRecord.name !== "string") {
      return undefined;
    }
    if (deviceRecord.platform !== "android" && deviceRecord.platform !== "ios") {
      return undefined;
    }
    return {
      name: deviceRecord.name,
      platform: deviceRecord.platform,
      deviceId: typeof deviceRecord.deviceId === "string" ? deviceRecord.deviceId : undefined,
    };
  }

  async function reserveProvisionDeviceReplayLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    result: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<VirtualDeviceLifecycleLease | undefined> {
    const device = getPersistedProvisionDevice(result);
    const stableId = device?.platform === "android" ? device.name : device?.deviceId;
    if (!device || !stableId) {
      return undefined;
    }
    const totalDeadlineMs =
      deps.timer.now() + (args.timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
    return await reserveStableDeviceLifecycle(
      { platform: device.platform, stableId },
      {
        platform: device.platform,
        name: device.name,
        deviceId: device.deviceId ?? stableId,
      },
      deps.timer,
      totalDeadlineMs,
      signal,
      (detail) =>
        new ProvisionDeviceError(
          "timeout",
          `Timed out replaying provisioned ${device.platform} device '${device.name}': ${detail}.`,
        ),
      "provision",
      deps.lifecycleCoordinator,
    );
  }

  async function canReplayCompletedProvisionDeviceOperation(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    result: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const replayLease = await reserveProvisionDeviceReplayLifecycle(args, deps, result, signal);
    const replaySignal = replayLease
      ? signal
        ? AbortSignal.any([signal, replayLease.signal])
        : replayLease.signal
      : signal;
    try {
      return (
        !args.boot || (await revalidateProvisionDeviceReplay(args, deps, result, replaySignal))
      );
    } finally {
      replayLease?.release();
    }
  }

  async function revalidateLiveProvisionDeviceSession(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    result: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const liveSession = getLiveProvisionDeviceSession(result);
    if (!liveSession) {
      return false;
    }
    if (args.readiness === "automation") {
      const perf = createPerformanceTracker(true);
      perf.serial("provisionDeviceReplay");
      try {
        const totalDeadlineMs =
          deps.timer.now() + (args.timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
        await ensureProvisionDeviceReadiness(
          args,
          deps,
          liveSession.device,
          `platform=${args.device.platform} name=${args.device.name}`,
          totalDeadlineMs,
          perf,
          signal,
        );
      } finally {
        perf.end();
      }
    }
    const revalidatedSession = getPersistedProvisionDeviceSession(result);
    if (!revalidatedSession || !getLiveProvisionDeviceSession(result)) {
      return false;
    }
    await DaemonState.getInstance()
      .getDevicePool()
      .attachAutolockSessionToMcpSession(revalidatedSession.sessionId, args.__mcpSessionId);
    return true;
  }

  async function revalidateProvisionDeviceReplay(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    result: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    try {
      return await revalidateLiveProvisionDeviceSession(args, deps, result, signal);
    } catch (error) {
      await releaseProvisionDeviceSession(result, "provision-device-replay-validation-failed");
      throw error;
    }
  }

  function getLiveProvisionDeviceSession(
    result: Record<string, unknown>,
  ): { device: BootedDevice } | undefined {
    const persistedSession = getPersistedProvisionDeviceSession(result);
    const daemonState = DaemonState.getInstance();
    if (!persistedSession || !daemonState.isInitialized()) {
      return undefined;
    }

    const session = daemonState.getSessionManager().getSession(persistedSession.sessionId);
    const pooledDevice = daemonState
      .getDevicePool()
      .getDeviceForSession(persistedSession.sessionId);
    if (
      session?.assignedDevice === persistedSession.deviceId &&
      session.platform === persistedSession.platform &&
      pooledDevice?.id === persistedSession.deviceId &&
      pooledDevice.platform === persistedSession.platform &&
      pooledDevice.status === "busy"
    ) {
      return { device: persistedSession.device };
    }
    return undefined;
  }

  function getPersistedProvisionDeviceSession(
    result: Record<string, unknown>,
  ):
    | { sessionId: string; deviceId: string; platform: "android" | "ios"; device: BootedDevice }
    | undefined {
    if (typeof result.sessionId !== "string") {
      return undefined;
    }
    const device = getPersistedProvisionDevice(result);
    if (!device?.deviceId) {
      return undefined;
    }
    const persistedDevice: BootedDevice = {
      name: device.name,
      platform: device.platform,
      deviceId: device.deviceId,
    };
    return {
      sessionId: result.sessionId,
      deviceId: device.deviceId,
      platform: device.platform,
      device: persistedDevice,
    };
  }

  async function releaseErroredProvisionDeviceSession(
    result: Record<string, unknown>,
  ): Promise<void> {
    const persistedSession = getPersistedProvisionDeviceSession(result);
    const daemonState = DaemonState.getInstance();
    if (!persistedSession || !daemonState.isInitialized()) {
      return;
    }
    const pooledDevice = daemonState
      .getDevicePool()
      .getDeviceForSession(persistedSession.sessionId);
    if (pooledDevice?.status !== "error") {
      return;
    }
    await releaseProvisionDeviceSession(result, "provision-device-errored-replay");
  }

  async function completeProvisionDeviceOperation(
    store: ProvisionDeviceOperationStore,
    operationId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    try {
      await store.complete(operationId, result);
    } catch (error) {
      await releaseProvisionDeviceSession(result, "provision-device-persistence-failed");
      throw error;
    }
  }

  async function releaseProvisionDeviceSession(
    result: Record<string, unknown>,
    reason: string,
  ): Promise<void> {
    const persistedSession = getPersistedProvisionDeviceSession(result);
    const daemonState = DaemonState.getInstance();
    if (!persistedSession || !daemonState.isInitialized()) {
      return;
    }
    const sessionManager = daemonState.getSessionManager();
    const session = sessionManager.getSession(persistedSession.sessionId);
    if (
      session?.assignedDevice !== persistedSession.deviceId ||
      session.platform !== persistedSession.platform
    ) {
      return;
    }
    try {
      const releasedDeviceId = await sessionManager.releaseSession(
        persistedSession.sessionId,
        reason,
      );
      if (releasedDeviceId === persistedSession.deviceId) {
        await daemonState
          .getDevicePool()
          .releaseDevice(releasedDeviceId, persistedSession.sessionId);
      }
    } catch (error) {
      logger.warn(
        `[DeviceTools] Failed to release provisionDevice session ${persistedSession.sessionId}: ${error}`,
      );
    }
  }

  function preserveProvisionDeviceOwnership(
    persisted: Record<string, unknown>,
    refreshed: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      ...refreshed,
      created: persisted.created,
      adopted: persisted.adopted,
    };
  }

  function toProvisionDeviceError(args: ProvisionDeviceArgs, error: unknown): ProvisionDeviceError {
    if (error instanceof ProvisionDeviceError) {
      return error;
    }
    return new ProvisionDeviceError(
      "platform_command_failed",
      `Failed to provision ${args.device.platform} device '${args.device.name}': ${errorMessage(error)}`,
    );
  }

  async function reserveExistingIosProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    deviceManager: PlatformDeviceManager,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<VirtualDeviceLifecycleLease | undefined> {
    const discovery = await runProvisionDeviceWithinDeadline(
      deps.timer,
      totalDeadlineMs,
      signal,
      "resolving the exact iOS simulator identity",
      async () =>
        await deviceManager.getDeviceImagesDetailed("ios", {
          bypassIosDeviceListCache: true,
        }),
    );
    if (!discovery.succeededPlatforms.has("ios")) {
      throw new ProvisionDeviceError(
        "platform_command_failed",
        `Cannot provision iOS device '${args.device.name}' because simulator identity discovery did not complete.`,
      );
    }
    const spec = args.device.spec;
    const candidates = discovery.devices.filter(
      (device) =>
        device.platform === "ios" &&
        device.name === args.device.name &&
        device.deviceId &&
        device.runtime === spec.runtime &&
        device.deviceType === spec.deviceType,
    );
    const existing = candidates.find((device) => device.isAvailable !== false) ?? candidates[0];
    if (!existing?.deviceId) {
      return undefined;
    }
    return await reserveIosProvisionDeviceLifecycle(args, deps, existing, totalDeadlineMs, signal);
  }

  async function reserveIosProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    device: Pick<DeviceInfo, "deviceId">,
    totalDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<VirtualDeviceLifecycleLease> {
    if (!device.deviceId) {
      throw new ProvisionDeviceError(
        "identity_conflict",
        `Exact iOS simulator '${args.device.name}' has no UDID.`,
      );
    }
    const target: StableDeviceTarget = { platform: "ios", stableId: device.deviceId };
    return await reserveStableDeviceLifecycle(
      target,
      {
        platform: target.platform,
        name: args.device.name,
        deviceId: target.stableId,
      },
      deps.timer,
      totalDeadlineMs,
      signal,
      (detail) =>
        new ProvisionDeviceError(
          "timeout",
          `Timed out provisioning ${target.platform} device '${args.device.name}': ${detail}.`,
        ),
      "provision",
      deps.lifecycleCoordinator,
    );
  }

  async function runProvisionDeviceLifecycle(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    reconcileExistingConfiguration: boolean,
    markDeviceCreationStarted: () => Promise<void>,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    const perf = createPerformanceTracker(true);
    perf.serial("provisionDevice");
    const totalDeadlineMs =
      deps.timer.now() + (args.timeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS);
    const deviceManager = deps.deviceManagerFactory();
    let lifecycleLease: VirtualDeviceLifecycleLease | undefined;
    try {
      if (args.device.platform === "android") {
        lifecycleLease = await reserveStableDeviceLifecycle(
          { platform: "android", stableId: args.device.name },
          {
            platform: "android",
            name: args.device.name,
            deviceId: args.device.name,
          },
          deps.timer,
          totalDeadlineMs,
          signal,
          (detail) =>
            new ProvisionDeviceError(
              "timeout",
              `Timed out provisioning Android AVD '${args.device.name}': ${detail}.`,
            ),
          "provision",
          deps.lifecycleCoordinator,
        );
      } else {
        lifecycleLease = await reserveExistingIosProvisionDeviceLifecycle(
          args,
          deps,
          deviceManager,
          totalDeadlineMs,
          signal,
        );
        lifecycleLease ??= await deps.lifecycleCoordinator.reserve(
          { kind: "selector", platform: "ios", selector: args.device.name },
          { operation: "provision", deadlineMs: totalDeadlineMs, signal },
        );
      }
      const deviceCreationGate = deps.deviceCreationGateFactory();
      const provisioned = await provisionExactDevice(
        args,
        deps.exactDeviceProvisionerFactory(deviceManager, deviceCreationGate),
        perf,
        deps.timer,
        totalDeadlineMs,
        reconcileExistingConfiguration,
        markDeviceCreationStarted,
        lifecycleLease,
        signal,
      );
      const createdByOperation = reconcileExistingConfiguration || provisioned.created;
      if (!args.boot) {
        if (provisioned.created) {
          await deps.notifyResourcesChanged();
        }
        perf.end();
        return buildProvisionDeviceResult(args, provisioned, createdByOperation, perf, undefined);
      }
      const booted = await bootExactProvisionedDevice(
        args,
        deps,
        deviceManager,
        deviceCreationGate,
        provisioned,
        perf,
        totalDeadlineMs,
        lifecycleLease,
        signal,
      );
      if (provisioned.created || booted.source === "cold-boot") {
        await deps.notifyResourcesChanged();
      }
      perf.end();
      return buildProvisionDeviceResult(args, provisioned, createdByOperation, perf, booted);
    } catch (error) {
      perf.end();
      throw error;
    } finally {
      lifecycleLease?.release();
    }
  }

  async function provisionExactDevice(
    args: ProvisionDeviceArgs,
    provisioner: ExactDeviceProvisioner,
    perf: ReturnType<typeof createPerformanceTracker>,
    timer: Timer,
    totalDeadlineMs: number,
    reconcileExistingConfiguration: boolean,
    markDeviceCreationStarted: () => Promise<void>,
    lifecycleLease: VirtualDeviceLifecycleLease,
    signal: AbortSignal | undefined,
  ): Promise<Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>> {
    perf.startOperation("provisionExactDevice");
    try {
      return await runProvisionDeviceWithinDeadline(
        timer,
        totalDeadlineMs,
        signal,
        "provisioning the exact device",
        async (deadlineSignal) =>
          await provisioner.provision({
            platform: args.device.platform,
            name: args.device.name,
            spec: args.device.spec,
            reconcileExistingConfiguration,
            onBeforeCreate: markDeviceCreationStarted,
            lifecycleLease,
            deadlineMs: totalDeadlineMs,
            signal: deadlineSignal,
          }),
      );
    } finally {
      perf.endOperation("provisionExactDevice");
    }
  }

  async function bootExactProvisionedDevice(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    deviceManager: PlatformDeviceManager,
    deviceCreationGate: DeviceCreationGate,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
    perf: ReturnType<typeof createPerformanceTracker>,
    totalDeadlineMs: number,
    lifecycleLease: VirtualDeviceLifecycleLease,
    signal: AbortSignal | undefined,
  ): Promise<{ device: BootedDevice; sessionId: string; source: "booted" | "cold-boot" }> {
    const requestedIdentity = `platform=${args.device.platform} name=${args.device.name}`;
    const bootService = new DeviceBootService({
      deviceManager,
      deviceMatcher: deps.deviceMatcherFactory(),
      deviceCreationGate,
      deviceProvisioner: deps.deviceProvisionerFactory(),
      matchingStrategy: DEVICE_POOL_MATCHING,
      timer: deps.timer,
      lifecycleLease,
      lifecycleCoordinator: deps.lifecycleCoordinator,
    });
    let boot: DeviceBootResult | undefined;
    let ownershipTransferred = false;
    let releaseReadinessReservation: (() => Promise<void>) | undefined;
    try {
      const alreadyBooted = await runProvisionDeviceWithinDeadline(
        deps.timer,
        totalDeadlineMs,
        signal,
        "discovering an already-running exact device",
        async () => await deviceManager.getBootedDevices(args.device.platform),
      );
      const exactBootedDevice =
        args.device.platform === "ios"
          ? alreadyBooted.find((device) => device.deviceId === provisioned.device.deviceId)
          : alreadyBooted.find(
              (device) =>
                device.deviceId === provisioned.device.deviceId ||
                device.name === provisioned.device.name,
            );
      if (args.device.platform === "ios" && !provisioned.device.deviceId) {
        throw new ProvisionDeviceError(
          "identity_conflict",
          `Exact iOS simulator '${args.device.name}' has no UDID.`,
        );
      }
      perf.startOperation("bootDevice");
      boot = await bootService.boot({
        platform: args.device.platform,
        deviceId:
          exactBootedDevice?.deviceId ?? provisioned.device.deviceId ?? provisioned.device.name,
        timeoutMs: Math.max(1, totalDeadlineMs - deps.timer.now()),
        totalDeadlineMs,
        signal,
      });
      perf.endOperation("bootDevice");
      if (args.device.platform === "ios" && boot.device.deviceId !== provisioned.device.deviceId) {
        throw new ProvisionDeviceError(
          "identity_conflict",
          `Exact iOS simulator '${args.device.name}' resolved to unexpected UDID '${boot.device.deviceId}'.`,
        );
      }
      validatePooledDeviceMapping(boot.device, requestedIdentity);
      releaseReadinessReservation = await reserveProvisionDeviceReadiness(boot.device);
      clearColdBootShutdownMarker(boot.source, boot.device.deviceId);
      await ensureProvisionDeviceReadiness(
        args,
        deps,
        boot.device,
        requestedIdentity,
        totalDeadlineMs,
        perf,
        signal,
      );
      validatePooledDeviceMapping(boot.device, requestedIdentity);
      publishWarmDeviceReady(boot.source, boot.device.deviceId);
      const sessionId = await bindBootedDeviceSession(
        boot.device,
        {
          platform: args.device.platform,
          name: args.device.name,
          timeoutMs: args.timeoutMs,
          __mcpSessionId: args.__mcpSessionId,
        },
        provisioned.device,
        boot.processHandle,
      );
      ownershipTransferred = true;
      return { device: boot.device, sessionId, source: boot.source };
    } catch (error) {
      if (!ownershipTransferred) {
        void cancelUnownedColdBoot(boot);
      }
      throw error;
    } finally {
      await releaseReadinessReservation?.();
    }
  }

  async function reserveProvisionDeviceReadiness(
    device: BootedDevice,
  ): Promise<(() => Promise<void>) | undefined> {
    const daemonState = DaemonState.getInstance();
    if (!daemonState.isInitialized()) {
      return undefined;
    }
    return await daemonState.getDevicePool().reserveDeviceForReadiness(device.deviceId, device);
  }

  async function ensureProvisionDeviceReadiness(
    args: ProvisionDeviceArgs,
    deps: DeviceToolsDependencies,
    device: BootedDevice,
    requestedIdentity: string,
    totalDeadlineMs: number,
    perf: ReturnType<typeof createPerformanceTracker>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (args.readiness !== "automation") {
      return;
    }
    const ctrlProxySetup = deps.ensureCtrlProxyReady ?? ensureCtrlProxyReady;
    await ctrlProxySetup({
      device,
      requestedIdentity,
      totalDeadlineMs,
      readinessTimeoutMs: args.timeoutMs ?? serverConfig.getRunnerReadinessTimeoutMs(),
      skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
      perf,
      signal,
    });
  }

  function buildProvisionDeviceResult(
    args: ProvisionDeviceArgs,
    provisioned: Awaited<ReturnType<ExactDeviceProvisioner["provision"]>>,
    createdByOperation: boolean,
    perf: ReturnType<typeof createPerformanceTracker>,
    booted: { device: BootedDevice; sessionId: string } | undefined,
  ): Record<string, unknown> {
    return {
      operationId: args.operationId,
      device: booted?.device ?? provisioned.device,
      requestedSpec: args.device.spec,
      resolvedSpec: provisioned.resolvedSpec,
      created: createdByOperation,
      adopted: !createdByOperation,
      lifecycleState: booted ? "ready" : createdByOperation ? "created" : "adopted",
      readiness: {
        mode: args.readiness,
        status: booted
          ? args.readiness === "automation"
            ? "automation_ready"
            : "device_ready"
          : "not_requested",
      },
      ...(booted ? { sessionId: booted.sessionId } : {}),
      timing: perf.getTimings(),
    };
  }

  function provisionDeviceErrorResponse(error: unknown) {
    if (error instanceof ProvisionDeviceError) {
      return createToolErrorResponse(error.code, error.message);
    }
    if (error instanceof ProvisionDeviceOperationConflictError) {
      return createToolErrorResponse("operation_conflict", error.message);
    }
    return createToolErrorResponse("platform_command_failed", errorMessage(error));
  }

  type DevicePreparationBudgets = {
    bootTimeoutMs: number;
    automationReadyTimeoutMs: number;
    automationDeadlineMs: number;
    operationName: string;
    androidAvdName?: string;
    stableTarget?: StableDeviceTarget;
  };

  const reserveStartStableDeviceLifecycle = async (
    stableTarget: StableDeviceTarget | undefined,
    timer: Timer,
    deadlineMs: number,
    signal: AbortSignal | undefined,
    coordinator: VirtualDeviceLifecycleCoordinator,
  ): Promise<VirtualDeviceLifecycleLease | undefined> => {
    if (!stableTarget) {
      return undefined;
    }
    return await reserveStableDeviceLifecycle(
      stableTarget,
      {
        name: stableTarget.stableId,
        platform: stableTarget.platform,
        deviceId: stableTarget.stableId,
      },
      timer,
      deadlineMs,
      signal,
      undefined,
      "start",
      coordinator,
    );
  };

  const resolveStartStableDeviceLifecycleTarget = async (
    args: StartDeviceArgs,
    budgets: DevicePreparationBudgets,
    deviceUtils: PlatformDeviceManager,
    deviceMatcher: DeviceMatcher,
    timer: Timer,
    signal: AbortSignal | undefined,
  ): Promise<StableDeviceTarget | undefined> => {
    if (budgets.stableTarget) {
      return budgets.stableTarget;
    }
    if (args.platform === "android" && args.deviceId) {
      return await resolveAndroidStartStableDeviceLifecycleTarget(
        args.deviceId,
        budgets.automationDeadlineMs,
        deviceUtils,
        timer,
        signal,
      );
    }
    if (args.platform !== "ios" || !args.name || args.deviceId) {
      return undefined;
    }
    const discovery = await runWithinShutdownDeadline(
      { name: args.name, platform: "ios", deviceId: args.name },
      timer,
      budgets.automationDeadlineMs,
      "iOS simulator identity discovery did not complete",
      signal,
      async () =>
        await deviceUtils.getDeviceImagesDetailed("ios", {
          bypassIosDeviceListCache: true,
        }),
    );
    if (!discovery.succeededPlatforms.has("ios")) {
      throw new ActionableError(
        `Cannot uniquely resolve iOS device '${args.name}' for lifecycle coordination; provide deviceId.`,
      );
    }
    const criteria: DeviceMatchCriteria = {
      platform: "ios",
      name: args.name,
      minOsVersion: args.minOsVersion,
      maxOsVersion: args.maxOsVersion,
      formFactor: args.formFactor,
      screenSize: args.screenSize,
    };
    const match = deviceMatcher.matchDeviceImage(
      criteria,
      discovery.devices.filter((device) => device.platform === "ios" && device.deviceId),
      DEVICE_POOL_MATCHING,
    );
    if (!match?.deviceId) {
      // This legacy name is a creation criterion when create-if-missing is
      // enabled, not the stable identity of an existing simulator.
      return undefined;
    }
    return { platform: "ios", stableId: match.deviceId };
  };

  const reserveStartDeviceLifecycleReservations = async (
    args: StartDeviceArgs,
    budgets: DevicePreparationBudgets,
    deps: DeviceToolsDependencies,
    deviceUtils: PlatformDeviceManager,
    deviceMatcher: DeviceMatcher,
    bootDeadlineMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{
    releaseAndroidStartupLease: (() => Promise<void>) | undefined;
    lifecycleLease: VirtualDeviceLifecycleLease;
  }> => {
    let releaseAndroidStartupLease: (() => Promise<void>) | undefined;
    let lifecycleLease: VirtualDeviceLifecycleLease | undefined;
    try {
      releaseAndroidStartupLease = await reserveAndroidStartupLease(
        args,
        budgets,
        bootDeadlineMs,
        deps.timer,
        signal,
      );
      const stableTarget = await resolveStartStableDeviceLifecycleTarget(
        args,
        budgets,
        deviceUtils,
        deviceMatcher,
        deps.timer,
        signal,
      );
      lifecycleLease =
        (await reserveStartStableDeviceLifecycle(
          stableTarget,
          deps.timer,
          budgets.automationDeadlineMs,
          signal,
          deps.lifecycleCoordinator,
        )) ??
        (await deps.lifecycleCoordinator.reserve(
          {
            kind: "selector",
            platform: args.platform,
            selector: stableStringify({
              deviceId: args.deviceId,
              name: args.name,
              minOsVersion: args.minOsVersion,
              maxOsVersion: args.maxOsVersion,
              formFactor: args.formFactor,
              screenSize: args.screenSize,
            }),
          },
          { operation: "start", deadlineMs: budgets.automationDeadlineMs, signal },
        ));
      if (stableTarget?.platform === "ios" && args.name && !args.deviceId) {
        const revalidatedTarget = await resolveStartStableDeviceLifecycleTarget(
          args,
          budgets,
          deviceUtils,
          deviceMatcher,
          deps.timer,
          signal,
        );
        if (
          revalidatedTarget?.platform !== "ios" ||
          revalidatedTarget.stableId !== stableTarget.stableId
        ) {
          throw new ActionableError(
            `iOS simulator '${args.name}' changed while waiting for lifecycle coordination; retry the request.`,
          );
        }
      }
      return { releaseAndroidStartupLease, lifecycleLease };
    } catch (error) {
      lifecycleLease?.release();
      await releaseAndroidStartupLease?.();
      throw error;
    }
  };

  const bootAndPrepareDevice = async (
    args: StartDeviceArgs,
    budgets: DevicePreparationBudgets,
    deps: DeviceToolsDependencies,
    deviceUtils: PlatformDeviceManager,
    deviceMatcher: DeviceMatcher,
    bootDeadlineMs: number,
    requestedIdentity: string,
    progress: ProgressCallback | undefined,
    signal: AbortSignal | undefined,
    perf: ReturnType<typeof createPerformanceTracker>,
    releaseReadinessReservations: DeviceReadinessReservation[],
    lifecycleLease: VirtualDeviceLifecycleLease,
    state: { boot: DeviceBootResult | undefined; ownershipTransferred: boolean },
  ) => {
    const bootService = new DeviceBootService({
      deviceManager: deviceUtils,
      deviceMatcher,
      deviceCreationGate: deps.deviceCreationGateFactory(),
      deviceProvisioner: deps.deviceProvisionerFactory(),
      matchingStrategy: DEVICE_POOL_MATCHING,
      timer: deps.timer,
      lifecycleLease,
      lifecycleCoordinator: deps.lifecycleCoordinator,
    });
    perf.startOperation("bootDevice");
    state.boot = await bootService.boot(
      {
        ...args,
        timeoutMs: budgets.bootTimeoutMs,
        totalDeadlineMs: bootDeadlineMs,
        signal,
      },
      progress ? { report: progress } : undefined,
    );
    perf.endOperation("bootDevice");
    validateBootIdentity(args, state.boot.device, state.boot.source, state.boot.sourceImage);
    validatePooledDeviceMapping(state.boot.device, requestedIdentity);
    // A warm AVD has no cold-boot source image, but its explicit getAndroid
    // identifier is still the stable identity needed for later recovery.
    let sourceImage =
      state.boot.sourceImage ??
      (budgets.androidAvdName
        ? {
            name: budgets.androidAvdName,
            platform: "android" as const,
            isRunning: true,
            source: "local" as const,
          }
        : undefined);
    const daemonState = DaemonState.getInstance();
    await reserveInitialDeviceForReadiness(daemonState, state.boot, releaseReadinessReservations);

    // A new incarnation must not inherit a prior intentional-shutdown marker
    // while its per-device runner setup is in flight.
    clearColdBootShutdownMarker(state.boot.source, state.boot.device.deviceId);

    const ctrlProxySetup = deps.ensureCtrlProxyReady ?? ensureCtrlProxyReady;
    const readinessResult = await prepareStartDeviceRunnerReadiness({
      boot: state.boot,
      args,
      bootService,
      deviceUtils,
      daemonState,
      totalDeadlineMs: budgets.automationDeadlineMs,
      readinessTimeoutMs: budgets.automationReadyTimeoutMs,
      timer: deps.timer,
      signal,
      progress,
      perf,
      requestedIdentity,
      ensureCtrlProxyReady: ctrlProxySetup,
      releaseReadinessReservations,
    });
    state.boot = readinessResult.boot;
    sourceImage = state.boot.sourceImage ?? sourceImage;
    // Re-check under the later binding lock because pool identity can change
    // while runner setup is in flight.
    validatePooledDeviceMapping(state.boot.device, requestedIdentity);

    // Publish only after runner health passes. Readiness remains per-device,
    // so 20-40 concurrent emulators do not serialize on a host-wide gate.
    publishWarmDeviceReady(state.boot.source, state.boot.device.deviceId);
    await validatePreservedSystemUiAnrRecoverySession(
      readinessResult.preservedSessionId,
      readinessResult.validatePreservedSession,
      readinessResult.retireReplacement,
    );
    const verifiedWarmAndroidAvdIdentity = getVerifiedWarmAndroidAvdIdentity(
      state.boot,
      sourceImage,
    );
    const sessionId =
      readinessResult.preservedSessionId ??
      (await bindBootedDeviceSession(
        state.boot.device,
        args,
        state.boot.source === "cold-boot" ? sourceImage : undefined,
        state.boot.processHandle,
        new Set(releaseReadinessReservations.map((reservation) => reservation.owner)),
        verifiedWarmAndroidAvdIdentity,
      ));
    state.ownershipTransferred = true;

    await notifyResourcesAfterDeviceBoot(state.boot, perf, deps.notifyResourcesChanged);
    return await buildBootedResponse(
      state.boot.device,
      state.boot.source,
      perf,
      sessionId,
      state.boot.processId,
      sourceImage,
    );
  };

  const prepareDevice = async (
    args: StartDeviceArgs,
    budgets: DevicePreparationBudgets,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const perf = createPerformanceTracker(true);
    perf.serial(budgets.operationName);
    const deps = getDeviceToolsDependencies();
    const deviceUtils = deps.deviceManagerFactory();
    const deviceMatcher = deps.deviceMatcherFactory();
    const bootDeadlineMs = deps.timer.now() + budgets.bootTimeoutMs;
    const requestedIdentity = describeStartDeviceRequest(args);
    const state: { boot: DeviceBootResult | undefined; ownershipTransferred: boolean } = {
      boot: undefined,
      ownershipTransferred: false,
    };
    const releaseReadinessReservations: DeviceReadinessReservation[] = [];
    let lifecycleReservations:
      | Awaited<ReturnType<typeof reserveStartDeviceLifecycleReservations>>
      | undefined;
    let unownedColdBootSettlement: Promise<void> | undefined;

    try {
      lifecycleReservations = await reserveStartDeviceLifecycleReservations(
        args,
        budgets,
        deps,
        deviceUtils,
        deviceMatcher,
        bootDeadlineMs,
        signal,
      );
      const coordinatedSignals = [signal, lifecycleReservations.lifecycleLease.signal].filter(
        (candidate): candidate is AbortSignal => candidate !== undefined,
      );
      const coordinatedSignal =
        coordinatedSignals.length === 1
          ? coordinatedSignals[0]
          : AbortSignal.any(coordinatedSignals);
      return await bootAndPrepareDevice(
        args,
        budgets,
        deps,
        deviceUtils,
        deviceMatcher,
        bootDeadlineMs,
        requestedIdentity,
        progress,
        coordinatedSignal,
        perf,
        releaseReadinessReservations,
        lifecycleReservations.lifecycleLease,
        state,
      );
    } catch (error) {
      perf.end();
      if (!state.ownershipTransferred) {
        unownedColdBootSettlement = cancelUnownedColdBoot(state.boot);
      }
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to start ${args.platform} device: ${error}`);
    } finally {
      for (const releaseReservation of releaseReadinessReservations.reverse()) {
        await releaseReservation();
      }
      if (unownedColdBootSettlement) {
        void unownedColdBootSettlement.then(() => lifecycleReservations?.lifecycleLease.release());
      } else {
        lifecycleReservations?.lifecycleLease.release();
      }
      await lifecycleReservations?.releaseAndroidStartupLease?.();
    }
  };

  // Compatibility implementation. New callers use getAndroid/getApple so their
  // platform identity and readiness budgets are explicit.
  const startDeviceHandler = async (
    rawArgs: StartDeviceArgs,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const internalSessionId = rawArgs.__mcpSessionId;
    const args = {
      ...startDeviceSchema.parse(rawArgs),
      __mcpSessionId: internalSessionId,
    };
    const totalTimeoutMs = args.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
    return await prepareDevice(
      args,
      {
        bootTimeoutMs: totalTimeoutMs,
        automationReadyTimeoutMs: resolveRunnerReadinessTimeoutMs(args),
        automationDeadlineMs: getDeviceToolsDependencies().timer.now() + totalTimeoutMs,
        operationName: "startDevice",
        stableTarget:
          args.platform === "android" && args.name && !args.deviceId
            ? { platform: "android", stableId: args.name }
            : args.platform === "ios" && args.deviceId
              ? { platform: "ios", stableId: args.deviceId }
              : undefined,
      },
      progress,
      signal,
    );
  };

  const getAndroidHandler = async (
    rawArgs: GetAndroidArgs & Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const { __mcpSessionId } = rawArgs;
    const externalArgs = { ...rawArgs };
    delete externalArgs.__mcpSessionId;
    delete externalArgs.__executionId;
    delete externalArgs.__executionStartTime;
    const args = getAndroidSchema.parse(externalArgs);
    const bootTimeoutMs = args.bootTimeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
    const automationReadyTimeoutMs =
      args.automationReadyTimeoutMs ?? DEFAULT_RUNNER_READINESS_TIMEOUT_MS;
    const startedAtMs = getDeviceToolsDependencies().timer.now();
    return await prepareDevice(
      {
        platform: "android",
        name: args.avdName,
        matchExactName: true,
        preferRunning: true,
        createIfMissing: false,
        __mcpSessionId: typeof __mcpSessionId === "string" ? __mcpSessionId : undefined,
      },
      {
        bootTimeoutMs,
        automationReadyTimeoutMs,
        automationDeadlineMs: startedAtMs + bootTimeoutMs + automationReadyTimeoutMs,
        operationName: "getAndroid",
        androidAvdName: args.avdName,
        stableTarget: { platform: "android", stableId: args.avdName },
      },
      progress,
      signal,
    );
  };

  const getAppleHandler = async (
    rawArgs: GetAppleArgs & Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
  ) => {
    const { __mcpSessionId } = rawArgs;
    const externalArgs = { ...rawArgs };
    delete externalArgs.__mcpSessionId;
    delete externalArgs.__executionId;
    delete externalArgs.__executionStartTime;
    const args = getAppleSchema.parse(externalArgs);
    const bootTimeoutMs = args.bootTimeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;
    const automationReadyTimeoutMs =
      args.automationReadyTimeoutMs ?? DEFAULT_RUNNER_READINESS_TIMEOUT_MS;
    const startedAtMs = getDeviceToolsDependencies().timer.now();
    return await prepareDevice(
      {
        platform: "ios",
        deviceId: args.udid,
        preferRunning: true,
        createIfMissing: false,
        __mcpSessionId: typeof __mcpSessionId === "string" ? __mcpSessionId : undefined,
      },
      {
        bootTimeoutMs,
        automationReadyTimeoutMs,
        automationDeadlineMs: startedAtMs + bootTimeoutMs + automationReadyTimeoutMs,
        operationName: "getApple",
        stableTarget: { platform: "ios", stableId: args.udid },
      },
      progress,
      signal,
    );
  };

  async function ensureCtrlProxyReady(request: RunnerReadinessRequest): Promise<void> {
    request.perf?.startOperation("ensureCtrlProxy");
    try {
      await createDefaultRunnerReadinessService(getDeviceToolsDependencies().timer).ensureReady(
        request,
      );
    } finally {
      request.perf?.endOperation("ensureCtrlProxy");
    }
  }

  async function bindBootedDeviceSession(
    device: BootedDevice,
    args: StartDeviceArgs,
    sourceImage?: DeviceInfo,
    childProcess?: ChildProcess | null,
    readinessReservationOwners?: ReadonlySet<symbol>,
    verifiedAndroidAvdIdentity?: DeviceInfo,
  ): Promise<string> {
    // Reserve the exact ready device before resource notifications publish it
    // to concurrent allocators.
    const daemonState = DaemonState.getInstance();
    if (isDevicePoolAutolockEnabled() && daemonState.isInitialized()) {
      const autolockSessionId = await daemonState
        .getDevicePool()
        .autolockDevice(
          device.deviceId,
          device.platform,
          args.__mcpSessionId,
          sourceImage,
          childProcess,
          device,
          readinessReservationOwners,
          verifiedAndroidAvdIdentity,
        );
      if (autolockSessionId) {
        return autolockSessionId;
      }
    }

    const sessionId = getDeviceToolsDependencies().idGenerator.next();
    if (!daemonState.isInitialized()) {
      registerDirectSessionDevice(sessionId, device);
      return sessionId;
    }
    return daemonState
      .getDevicePool()
      .bindOrReuseDeviceSession(
        sessionId,
        device.deviceId,
        device.platform,
        sourceImage,
        childProcess,
        device,
        false,
        readinessReservationOwners,
        verifiedAndroidAvdIdentity,
      );
  }

  async function buildBootedResponse(
    device: BootedDevice,
    source: "booted" | "cold-boot",
    perf: ReturnType<typeof createPerformanceTracker>,
    sessionId: string,
    processId?: number,
    sourceImage?: DeviceInfo,
  ) {
    perf.end();
    const timing = perf.getTimings();

    const result: StartDeviceResult = {
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      osVersion: device.osVersion ?? device.iosVersion,
      formFactor: device.formFactor,
      screenSize:
        device.screenWidth && device.screenHeight
          ? { width: device.screenWidth, height: device.screenHeight }
          : undefined,
      sessionId,
      processId,
      isReady: true,
      source,
      // TimingData's runtime shape is serialized as the legacy flat result.
      // oxlint-disable-next-line auto-mobile/no-unknown-cast
      timing: (timing ?? {}) as unknown as Record<string, number>,
    };

    return createJSONToolResponse({
      message: `${device.platform} '${device.name}' is ready (${source})`,
      ...result,
      deviceIdentity: deviceIdentityPayload(device, sourceImage),
    });
  }

  const killDeviceHandler = async (
    args: KillDeviceArgs,
    _progress?: ProgressCallback,
    abortSignal?: AbortSignal,
  ) => {
    const deps = getDeviceToolsDependencies();
    const requestAbortSignal = abortSignal ?? getAbortSignal();
    const deadlineMs = deps.timer.now() + DEVICE_SHUTDOWN_TIMEOUT_MS;
    const daemonState = DaemonState.getInstance();
    const devicePool = daemonState.isInitialized() ? daemonState.getDevicePool() : undefined;
    const stableTarget = resolveKillDeviceStableTarget(args.device, devicePool);
    const lifecycleLease = stableTarget
      ? await reserveStableDeviceLifecycle(
          stableTarget,
          args.device,
          deps.timer,
          deadlineMs,
          requestAbortSignal,
          undefined,
          "shutdown",
          deps.lifecycleCoordinator,
        )
      : await deps.lifecycleCoordinator.reserve(
          { kind: "selector", platform: args.device.platform, selector: args.device.deviceId },
          { operation: "shutdown", deadlineMs, signal: requestAbortSignal },
        );
    const signals = [requestAbortSignal, lifecycleLease.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined,
    );
    let retainLifecycleLease = false;
    const retainLifecycleUntil = (operation: Promise<unknown>): void => {
      retainLifecycleLease = true;
      void operation.then(
        () => lifecycleLease.release(),
        () => lifecycleLease.release(),
      );
    };
    try {
      const result = await shutdownDevice(
        args.device,
        deps,
        signals.length === 1 ? signals[0] : AbortSignal.any(signals),
        deadlineMs,
        "killDevice",
        false,
        DEVICE_SHUTDOWN_TIMEOUT_MS,
        retainLifecycleUntil,
      );
      return createKillDeviceResponse(args, result.timing, result.alreadyStoppedMessage);
    } finally {
      if (!retainLifecycleLease) {
        lifecycleLease.release();
      }
    }
  };

  const deleteDeviceHandler = async (
    args: TeardownDeviceArgs,
    _progress?: ProgressCallback,
    abortSignal?: AbortSignal,
  ) => {
    const deps = getDeviceToolsDependencies();
    const callerSignal = abortSignal ?? getAbortSignal();
    const timeoutMs = args.timeoutMs ?? DEFAULT_DEVICE_TEARDOWN_TIMEOUT_MS;
    const deadlineMs = deps.timer.now() + timeoutMs;
    type TeardownState = {
      context: TeardownContext;
      target: TeardownResolvedTarget;
      earlyResponse?: TeardownToolResponse;
    };
    try {
      return await getDeviceTeardownService(deps).teardown<
        TeardownState,
        "accepted" | "not_required",
        TeardownToolResponse
      >(
        {
          operationId: args.operationId,
          fingerprint: teardownOperationFingerprint(args),
          identity: args.target,
          deadlineMs,
          callerSignal,
        },
        {
          resolve: async (requestAbortSignal, lifecycleLease) => {
            const context: TeardownContext = {
              args,
              dependencies: deps,
              deviceManager: deps.deviceManagerFactory(),
              requestAbortSignal,
              deadlineDevice: teardownDeadlineDevice(args),
              deadlineMs,
              timeoutMs,
              lifecycleLease,
            };
            const resolution = await resolveTeardownTarget(context);
            if ("response" in resolution) {
              return { response: resolution.response };
            }
            return { target: { context, target: resolution.target } };
          },
          stop: async (state, requestAbortSignal, retainLeaseUntil) => {
            const { context, target } = state;
            let stop: "accepted" | "not_required" = "not_required";
            if (target.wasBooted) {
              const stopped = await shutdownDevice(
                target.bootedDevice,
                deps,
                requestAbortSignal,
                context.deadlineMs,
                "deleteDevice",
                true,
                context.timeoutMs,
                retainLeaseUntil,
              );
              stop = stopped.alreadyStoppedMessage ? "not_required" : "accepted";
            } else {
              await stopSegmentedVideoRecordingsBeforeDestroy(context, target);
              await retireStoppedTeardownOwnership(context, target);
            }

            const restarted = await checkForRestartedTeardownTarget(context, target, "stop");
            if (restarted) {
              state.earlyResponse = restarted;
            }
            return stop;
          },
          destroy: async (state, _requestAbortSignal, retainLeaseUntil, markDestructionStarted) => {
            if (state.earlyResponse) {
              return;
            }
            const { context, target } = state;
            await destroyTeardownTarget(context, target, retainLeaseUntil, markDestructionStarted);
            unregisterDirectSessionsForStableIdentity(
              target.device.platform,
              target.device.platform === "android"
                ? target.device.name
                : (target.device.deviceId ?? args.target.stableId),
            );
          },
          verify: async (state, stop) => {
            if (state.earlyResponse) {
              return state.earlyResponse;
            }
            return await verifyTeardownAbsence(state.context, state.target, stop);
          },
          conflict: () =>
            createTeardownFailureResponse(
              args,
              "precondition",
              "operation_id_conflict",
              "The operation ID has already been used with different teardown arguments.",
            ),
          failure: (phase: DeviceTeardownPhase, error, state) => {
            const effectiveError =
              phase === "precondition" &&
              error instanceof Error &&
              error.message.startsWith("Timed out waiting to teardown")
                ? shutdownTimeoutError(
                    teardownDeadlineDevice(args),
                    "waiting for stable device lifecycle reservation",
                    timeoutMs,
                  )
                : error;
            logger.warn(
              `[DeviceTools] teardown operation ${args.operationId} failed during ${phase} ` +
                `for ${args.target.platform}:${args.target.stableId}: ${effectiveError}`,
              effectiveError,
            );
            return createTeardownFailureResponse(
              args,
              phase,
              "operation_failed",
              String(effectiveError instanceof Error ? effectiveError.message : effectiveError),
              state?.target.device,
            );
          },
          isFailure: isTeardownFailure,
        },
      );
    } catch (error) {
      // Caller cancellation ends only this wait; the accepted teardown continues independently.
      logger.debug(
        `[DeviceTools] teardown caller stopped waiting for ${args.operationId}: ${String(error instanceof Error ? error.message : error)}`,
      );
      return createTeardownFailureResponse(
        args,
        "precondition",
        "operation_cancelled",
        String(error instanceof Error ? error.message : error),
      );
    }
  };

  // Register with the tool registry
  ToolRegistry.register(
    "listDeviceImages",
    "List device images",
    listDeviceImagesSchema,
    listDeviceImagesHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.register(
    "listDevices",
    "List devices (resource guidance)",
    listDevicesSchema,
    listDevicesHandler,
    { defaultEnabled: true },
  );

  ToolRegistry.register(
    "getAndroid",
    "Find or recover an Android AVD and prepare it for automation.",
    getAndroidSchema,
    getAndroidHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.register(
    "getApple",
    "Find or recover an iOS Simulator and prepare it for automation.",
    getAppleSchema,
    getAppleHandler,
    { defaultEnabled: true, supportsProgress: true },
  );

  ToolRegistry.register("startDevice", "Start device", startDeviceSchema, startDeviceHandler, {
    defaultEnabled: true,
    supportsProgress: true,
    hidden: true,
  });

  ToolRegistry.register(
    "provisionDevice",
    "Provision exact virtual device",
    provisionDeviceSchema,
    provisionDeviceHandler,
    { defaultEnabled: false },
  );

  ToolRegistry.register("killDevice", "Kill device", killDeviceSchema, killDeviceHandler, {
    defaultEnabled: true,
  });

  ToolRegistry.register(
    "deleteDevice",
    "Stop and permanently delete a device, with verified platform-inventory absence",
    teardownDeviceSchema,
    deleteDeviceHandler,
    { defaultEnabled: false },
  );
}

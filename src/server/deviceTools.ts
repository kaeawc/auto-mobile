import type { ChildProcess } from "child_process";
import { z } from "zod";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { MultiPlatformDeviceManager, PlatformDeviceManager } from "../utils/deviceUtils";
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
import { platformSchema } from "./toolSchemaHelpers";
import { DefaultDeviceMatcher, type DeviceMatcher } from "../utils/deviceMatcher";
import { DEVICE_POOL_MATCHING, isDevicePoolAutolockEnabled } from "../daemon/poolConfig";
import { DEVICE_CREATE_ENV_VAR, getDeviceCreationGate, type DeviceCreationGate } from "../utils/deviceCreationGate";
import { createDefaultDeviceProvisioner, type DeviceProvisioner } from "../utils/deviceProvisioning";
import { DaemonState } from "../daemon/daemonState";
import { DeviceBootService, type DeviceBootResult } from "../utils/deviceBootService";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";
import { isAdbMissingDeviceError } from "../utils/android-cmdline-tools/AdbDeviceHealth";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
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
    platform: platformSchema
  })
});

export const DEVICE_ALREADY_STOPPED_ERROR_CODE = "device_already_stopped";

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


  const killDeviceHandler = async (args: KillDeviceArgs) => {
    const perf = createPerformanceTracker(true);
    perf.serial("killDevice");
    try {
      perf.startOperation("stopRecordings");
      const activeRecordings = await listActiveVideoRecordings({
        deviceId: args.device.deviceId,
        platform: args.device.platform,
      });
      for (const recording of activeRecordings) {
        try {
          await stopVideoRecording(recording.recordingId);
        } catch (error) {
          logger.warn(
            `[DeviceTools] Failed to stop recording ${recording.recordingId} before shutdown: ${error}`
          );
        }
      }
      perf.endOperation("stopRecordings");

      // Stop CtrlProxy iOS before shutting down iOS simulators
      if (args.device.platform === "ios") {
        perf.startOperation("stopCtrlProxy");
        try {
          const xcTestManager = IOSCtrlProxyManager.getInstance({
            name: args.device.name,
            platform: "ios",
            deviceId: args.device.deviceId,
            source: "local",
          });
          await xcTestManager.stop();
        } catch (error) {
          logger.warn(`[DeviceTools] Failed to stop CtrlProxy iOS before kill: ${error}`);
        }
        perf.endOperation("stopCtrlProxy");
      }

      const deps = getDeviceToolsDependencies();
      const deviceUtils = deps.deviceManagerFactory();
      perf.startOperation("killProcess");
      const devicePool = DaemonState.getInstance().isInitialized()
        ? DaemonState.getInstance().getDevicePool()
        : undefined;
      if (args.device.platform === "android") {
        devicePool?.markIntentionalShutdown(args.device.deviceId);
      }
      let alreadyStoppedMessage: string | undefined;
      try {
        await deviceUtils.killDevice(args.device);
      } catch (error) {
        if (isAlreadyStoppedDeviceError(args.device.platform, args.device.deviceId, error)) {
          alreadyStoppedMessage = `Failed to kill ${args.device.platform} device: ${error}`;
        } else {
          devicePool?.clearIntentionalShutdown(args.device.deviceId);
          throw error;
        }
      }
      perf.endOperation("killProcess");

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

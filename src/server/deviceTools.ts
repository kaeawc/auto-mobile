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
import { checkIosCtrlProxyOverride } from "../utils/iosCtrlProxyOverride";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { platformSchema } from "./toolSchemaHelpers";
import { DefaultDeviceMatcher, type DeviceMatcher } from "../utils/deviceMatcher";
import { DEVICE_POOL_MATCHING, isDevicePoolAutolockEnabled } from "../daemon/poolConfig";
import { DEVICE_CREATE_ENV_VAR, getDeviceCreationGate, type DeviceCreationGate } from "../utils/deviceCreationGate";
import { createDefaultDeviceProvisioner, type DeviceProvisioner } from "../utils/deviceProvisioning";
import { DaemonState } from "../daemon/daemonState";
import { DeviceBootService } from "../utils/deviceBootService";
import { getInstalledAppsCacheWriteCoordinator } from "../db/installedAppsCacheWriteCoordinator";
import { getDbWriteBarrier } from "../db/dbWriteBarrier";

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
  timeoutMs: z.number().optional().describe("Boot timeout in ms"),
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

function isAlreadyStoppedDeviceError(platform: SomePlatform, error: unknown): boolean {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (platform === "android") {
    return message.includes("not running") && message.includes("emulator");
  }
  if (platform === "ios") {
    return (
      message.includes("already shut down") ||
      message.includes("already shutdown") ||
      message.includes("not booted") ||
      message.includes("invalid device state")
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
  ensureCtrlProxyReady?: (device: BootedDevice, perf: ReturnType<typeof createPerformanceTracker>) => Promise<void>;
  deviceCreationGateFactory: () => DeviceCreationGate;
  deviceProvisionerFactory: () => DeviceProvisioner;
  clearInstalledAppsForDevice: (deviceId: string) => Promise<void>;
  idGenerator: IdGenerator;
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
  };
}

export function resetDeviceToolsDependencies(): void {
  moduleDependencies = null;
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
  const startDeviceHandler = async (args: StartDeviceArgs, progress?: ProgressCallback) => {
    const perf = createPerformanceTracker(true);
    perf.serial("startDevice");
    const deps = getDeviceToolsDependencies();
    const deviceUtils = deps.deviceManagerFactory();

    try {
      const bootService = new DeviceBootService({
        deviceManager: deviceUtils,
        deviceMatcher: deps.deviceMatcherFactory(),
        deviceCreationGate: deps.deviceCreationGateFactory(),
        deviceProvisioner: deps.deviceProvisionerFactory(),
        matchingStrategy: DEVICE_POOL_MATCHING,
      });
      perf.startOperation("bootDevice");
      const boot = await bootService.boot(args, progress ? { report: progress } : undefined);
      perf.endOperation("bootDevice");

      // A ready device may reuse an existing serial. Invalidate daemon-side
      // per-device state before any later await lets socket traffic reach it.
      if (DaemonState.getInstance().isInitialized()) {
        const pool = DaemonState.getInstance().getDevicePool();
        if (boot.source === "cold-boot") {
          pool.clearIntentionalShutdown(boot.device.deviceId);
        } else {
          pool.notifyDeviceReady(boot.device.deviceId);
        }
      }

      const ctrlProxySetup = deps.ensureCtrlProxyReady ?? ensureCtrlProxyReady;
      await ctrlProxySetup(boot.device, perf);
      const sessionId = await bindBootedDeviceSession(
        boot.device,
        args,
        boot.sourceImage,
        boot.processHandle
      );

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
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to start ${args.platform} device: ${error}`);
    }
  };


  async function ensureCtrlProxyReady(
    device: BootedDevice,
    perf: ReturnType<typeof createPerformanceTracker>,
  ) {
    if (device.platform !== "ios") {
      return;
    }

    // Fail closed on an unusable runner override before any warm-path return.
    // startDevice has its own enforcement here, and it returns early when the
    // CtrlProxy client is already connected -- skipping the builder that would
    // validate the override -- so a directory- or typo-valued
    // AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH would otherwise silently reuse the
    // cached released runner (#4221).
    const iosOverride = await checkIosCtrlProxyOverride();
    if (iosOverride.present && !iosOverride.usable) {
      throw new ActionableError(
        `AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH / _IPA_PATH is set but unusable: ${iosOverride.reason}`
      );
    }

    perf.startOperation("ensureCtrlProxy");
    try {
      await IOSCtrlProxyManager.awaitStartupOrphanRunnerReap();
      const manager = IOSCtrlProxyManager.getInstance(device);
      const xcTestClient = IOSCtrlProxyClient.getInstance(device, manager.getServicePort());

      // If WebSocket already connected and responsive, nothing to do
      if (xcTestClient.isConnected()) {
        const isReady = await xcTestClient.verifyServiceReady(2, 200, 2000);
        if (isReady) {
          logger.info(`[startDevice] CtrlProxy iOS already ready for ${device.deviceId}`);
          perf.endOperation("ensureCtrlProxy");
          return;
        }
      }

      // Setup: download bundle if needed, start xcodebuild, wait for service
      const setupResult = await manager.setup(false, perf);
      if (!setupResult.success) {
        logger.warn(`[startDevice] CtrlProxy iOS setup failed for ${device.deviceId}: ${setupResult.error ?? setupResult.message}`);
        perf.endOperation("ensureCtrlProxy");
        return;
      }

      // Wait for WebSocket connection and verify responsiveness
      const connected = await xcTestClient.waitForConnection(5, 1000);
      if (connected) {
        await xcTestClient.verifyServiceReady(5, 1000, 5000);
      }
    } catch (error) {
      logger.warn(`[startDevice] CtrlProxy iOS setup failed (non-fatal): ${error}`);
    }
    perf.endOperation("ensureCtrlProxy");
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
        childProcess
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
      childProcess
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
        if (isAlreadyStoppedDeviceError(args.device.platform, error)) {
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

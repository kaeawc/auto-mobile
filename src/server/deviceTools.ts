import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { MultiPlatformDeviceManager, PlatformDeviceManager, waitForDeviceReadyOrCancel } from "../utils/deviceUtils";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ActionableError, BootedDevice, DeviceInfo, SomePlatform } from "../models";
import type { DeviceMatchCriteria, FormFactor, MatchingStrategy, StartDeviceResult } from "../models/DeviceMatchCriteria";
import { BOOTED_DEVICE_RESOURCE_URIS, notifyBootedDeviceResourcesUpdated } from "./bootedDeviceResources";
import { DEVICE_IMAGE_RESOURCE_URIS, notifyDeviceImageResourcesUpdated } from "./deviceImageResources";
import { syncInstalledAppResources } from "./appResources";
import { listActiveVideoRecordings, stopVideoRecording } from "./videoRecordingManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { platformSchema } from "./toolSchemaHelpers";
import { DefaultDeviceMatcher, type DeviceMatcher } from "./deviceMatcher";
import { DEVICE_POOL_MATCHING, isDevicePoolAutolockEnabled } from "../daemon/poolConfig";
import { DEVICE_CREATE_ENV_VAR, getDeviceCreationGate, type DeviceCreationGate } from "../utils/deviceCreationGate";
import { createDefaultDeviceProvisioner, type DeviceProvisioner } from "../utils/deviceProvisioning";
import { DaemonState } from "../daemon/daemonState";

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
}

async function defaultNotifyResourcesChanged(): Promise<void> {
  await notifyBootedDeviceResourcesUpdated();
  await notifyDeviceImageResourcesUpdated();
  await syncInstalledAppResources();
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
  };
}

export function resetDeviceToolsDependencies(): void {
  moduleDependencies = null;
}

export function registerDeviceTools() {
  // List AVDs handler
  const listDeviceImagesHandler = async (args: ListDeviceImagesArgs) => {
    try {

      const deviceUtils = getDeviceToolsDependencies().deviceManagerFactory();
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
    const deviceMatcher = deps.deviceMatcherFactory();
    const strategy: MatchingStrategy = DEVICE_POOL_MATCHING;
    const preferRunning = args.preferRunning !== false;

    try {
      // --- Direct deviceId lookup ---
      if (args.deviceId) {
        perf.startOperation("directLookup");
        // Check booted devices first
        const booted = await deviceUtils.getBootedDevices(args.platform);
        const found = booted.find(d => d.deviceId === args.deviceId);
        perf.endOperation("directLookup");

        if (found) {
          const readyDevice = await waitForAlreadyRunningDevice(found, deviceUtils, perf, args);
          return await buildBootedResponse(readyDevice, "booted", perf, args);
        }

        // Check images — need to boot
        const images = await deviceUtils.listDeviceImages(args.platform);
        const image = images.find(d => d.deviceId === args.deviceId || d.name === args.deviceId);
        if (image) {
          return await bootAndRespond(image, deviceUtils, perf, progress, args);
        }

        throw new ActionableError(
          `Device '${args.deviceId}' not found. ` +
          `Available booted: ${booted.map(d => d.deviceId).join(", ") || "none"}. ` +
          `Available images: ${images.map(d => d.name).join(", ") || "none"}.`
        );
      }

      // --- Criteria-based matching ---
      const criteria: DeviceMatchCriteria = {
        platform: args.platform,
        minOsVersion: args.minOsVersion,
        maxOsVersion: args.maxOsVersion,
        name: args.name,
        formFactor: args.formFactor,
        screenSize: args.screenSize,
      };

      // Fetch images upfront — needed for both booted enrichment and fallback matching
      perf.startOperation("listImages");
      const images = await deviceUtils.listDeviceImages(args.platform);
      perf.endOperation("listImages");

      // Try booted devices first (if preferRunning)
      if (preferRunning) {
        perf.startOperation("matchBooted");
        const booted = await deviceUtils.getBootedDevices(args.platform);
        // Enrich booted devices with metadata from images (config.ini data)
        const enrichedBooted = enrichBootedDevicesFromImages(booted, images);
        const match = deviceMatcher.matchBootedDevice(criteria, enrichedBooted, strategy);
        perf.endOperation("matchBooted");

        if (match) {
          if (progress) {
            await progress(100, 100, "Found matching running device");
          }
          const readyDevice = await waitForAlreadyRunningDevice(match, deviceUtils, perf, args);
          return await buildBootedResponse(readyDevice, "booted", perf, args);
        }
      }

      // Fall back to images — boot one
      perf.startOperation("matchImage");
      const imageMatch = deviceMatcher.matchDeviceImage(criteria, images, strategy);
      perf.endOperation("matchImage");

      if (imageMatch) {
        // If the matched image is already running, return it as booted
        if (imageMatch.isRunning) {
          const booted = await deviceUtils.getBootedDevices(args.platform);
          const running = booted.find(d => d.name === imageMatch.name || d.deviceId === imageMatch.deviceId);
          if (running) {
            const readyDevice = await waitForAlreadyRunningDevice(running, deviceUtils, perf, args);
            return await buildBootedResponse(
              { ...readyDevice, osVersion: imageMatch.osVersion, formFactor: imageMatch.formFactor, screenWidth: imageMatch.screenWidth, screenHeight: imageMatch.screenHeight },
              "booted",
              perf,
              args,
            );
          }
        }
        return await bootAndRespond(imageMatch, deviceUtils, perf, progress, args);
      }

      // No match at all — provision one only when the opt-in gate is on.
      const gate = deps.deviceCreationGateFactory();
      if (gate.isCreationAllowed(args.createIfMissing)) {
        logger.info(
          `[startDevice] No ${args.platform} device matched; creating one ` +
          `(gate: ${gate.describeSource(args.createIfMissing)})`
        );
        const provisioned = await deps.deviceProvisionerFactory().provision(criteria);
        const createdImage: DeviceInfo = {
          name: provisioned.name,
          platform: provisioned.platform,
          deviceId: provisioned.deviceId,
          isRunning: false,
          formFactor: args.formFactor,
        } as DeviceInfo;
        await getDeviceToolsDependencies().notifyResourcesChanged();
        return await bootAndRespond(createdImage, deviceUtils, perf, progress, args);
      }

      throw new ActionableError(
        `No ${args.platform} device matching criteria found. ` +
        (args.minOsVersion ? `minOsVersion>=${args.minOsVersion} ` : "") +
        (args.maxOsVersion ? `maxOsVersion<=${args.maxOsVersion} ` : "") +
        (args.name ? `name=${args.name} ` : "") +
        (args.formFactor ? `formFactor=${args.formFactor} ` : "") +
        (args.screenSize ? `screenSize=${args.screenSize.width}x${args.screenSize.height} ` : "") +
        `\nAvailable images: ${images.map(d => `${d.name}${d.osVersion ? " (v" + d.osVersion + ")" : ""}`).join(", ") || "none"}.`
      );
    } catch (error) {
      perf.end();
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to start ${args.platform} device: ${error}`);
    }
  };

  async function waitForAlreadyRunningDevice(
    device: BootedDevice,
    deviceUtils: PlatformDeviceManager,
    perf: ReturnType<typeof createPerformanceTracker>,
    args: StartDeviceArgs,
  ): Promise<BootedDevice> {
    perf.startOperation("waitForReady");
    const readyDevice = await deviceUtils.waitForDeviceReady(
      { ...device, isRunning: true },
      args.timeoutMs,
    );
    perf.endOperation("waitForReady");
    return { ...device, ...readyDevice };
  }

  async function bootAndRespond(
    image: DeviceInfo,
    deviceUtils: PlatformDeviceManager,
    perf: ReturnType<typeof createPerformanceTracker>,
    progress: ProgressCallback | undefined,
    args: StartDeviceArgs,
  ) {
    if (image.platform === "ios" && !image.deviceId) {
      throw new ActionableError("iOS simulator deviceId (UDID) is required to start a simulator.");
    }

    const timeoutMs = args.timeoutMs ?? DEFAULT_DEVICE_READY_TIMEOUT_MS;

    perf.startOperation("launchProcess");
    const childProcess = await deviceUtils.startDevice(image, timeoutMs);
    perf.endOperation("launchProcess");

    if (progress) {
      await progress(60, 100, "Device started, waiting for readiness...");
    }

    perf.startOperation("waitForReady");
    const readyDevice = await waitForDeviceReadyOrCancel(deviceUtils, image, childProcess, timeoutMs);
    perf.endOperation("waitForReady");

    if (progress) {
      await progress(100, 100, "Device is ready for use");
    }

    perf.startOperation("notifyResources");
    await getDeviceToolsDependencies().notifyResourcesChanged();
    perf.endOperation("notifyResources");

    return await buildBootedResponse(
      { ...readyDevice, osVersion: image.osVersion, formFactor: image.formFactor, screenWidth: image.screenWidth, screenHeight: image.screenHeight },
      "cold-boot",
      perf,
      args,
      childProcess?.pid,
    );
  }

  async function ensureCtrlProxyReady(
    device: BootedDevice,
    perf: ReturnType<typeof createPerformanceTracker>,
  ) {
    if (device.platform !== "ios") {
      return;
    }

    perf.startOperation("ensureCtrlProxy");
    try {
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

  async function buildBootedResponse(
    device: BootedDevice,
    source: "booted" | "cold-boot",
    perf: ReturnType<typeof createPerformanceTracker>,
    args: StartDeviceArgs,
    processId?: number,
  ) {
    // Ensure iOS automation proxy is installed and running before returning.
    // This avoids the first observe/tap call paying the full setup cost.
    const deps = getDeviceToolsDependencies();
    const ctrlProxySetup = deps.ensureCtrlProxyReady ?? ensureCtrlProxyReady;
    await ctrlProxySetup(device, perf);

    // Always generate a session ID for consistent device interactions.
    // When autolock is enabled, lock the device to a pool-issued session UUID that
    // is enforced for all subsequent tool calls and auto-released after an idle timeout.
    // When disabled, still bind the returned session to this exact device so callers
    // can mix startDevice -> setActiveDevice -> session-targeted tools without the
    // session path assigning a different simulator/device on first use.
    let sessionId: string | undefined;
    if (isDevicePoolAutolockEnabled() && DaemonState.getInstance().isInitialized()) {
      sessionId = await DaemonState.getInstance()
        .getDevicePool()
        .autolockDevice(device.deviceId, device.platform, args.__mcpSessionId);
    }
    if (!sessionId) {
      sessionId = randomUUID();
      if (DaemonState.getInstance().isInitialized()) {
        sessionId = await DaemonState.getInstance()
          .getDevicePool()
          .bindOrReuseDeviceSession(sessionId, device.deviceId, device.platform);
      }
    }

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

  /**
   * Enrich booted devices with metadata from image list (config.ini / simctl data).
   * Booted devices lack osVersion/formFactor/screen data; images have it from enrichment.
   */
  function enrichBootedDevicesFromImages(booted: BootedDevice[], images: DeviceInfo[]): BootedDevice[] {
    if (images.length === 0) {return booted;}
    const imageById = new Map(images.filter(i => i.deviceId).map(i => [i.deviceId!, i]));
    const imageByName = new Map(images.map(i => [i.name, i]));

    return booted.map(device => {
      const image = (device.deviceId ? imageById.get(device.deviceId) : undefined) ?? imageByName.get(device.name);
      if (!image) {return device;}
      return {
        ...device,
        osVersion: device.osVersion ?? image.osVersion,
        formFactor: device.formFactor ?? image.formFactor,
        screenWidth: device.screenWidth ?? image.screenWidth,
        screenHeight: device.screenHeight ?? image.screenHeight,
      };
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

      const deviceUtils = getDeviceToolsDependencies().deviceManagerFactory();
      perf.startOperation("killProcess");
      await deviceUtils.killDevice(args.device);
      perf.endOperation("killProcess");

      perf.startOperation("cleanup");
      const { InstalledAppsRepository } = await import("../db/installedAppsRepository");
      const repo = new InstalledAppsRepository();
      await repo.clearDeviceSession(args.device.deviceId);
      perf.endOperation("cleanup");

      perf.startOperation("notifyResources");
      await notifyBootedDeviceResourcesUpdated();
      await notifyDeviceImageResourcesUpdated();
      await syncInstalledAppResources();
      perf.endOperation("notifyResources");

      perf.end();
      const timing = perf.getTimings();

      return createJSONToolResponse({
        message: `${args.device.platform} '${args.device.name}' shutdown successfully`,
        udid: args.device.deviceId,
        name: args.device.name,
        timing,
        platform: args.device.platform
      });
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

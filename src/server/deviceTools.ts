import { z } from "zod";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { MultiPlatformDeviceManager, PlatformDeviceManager } from "../utils/deviceUtils";
import { createJSONToolResponse } from "../utils/toolUtils";
import { ActionableError, BootedDevice, DeviceInfo, SomePlatform } from "../models";
import { BOOTED_DEVICE_RESOURCE_URIS, notifyBootedDeviceResourcesUpdated } from "./bootedDeviceResources";
import { DEVICE_IMAGE_RESOURCE_URIS, notifyDeviceImageResourcesUpdated } from "./deviceImageResources";
import { syncInstalledAppResources } from "./appResources";
import { listActiveVideoRecordings, stopVideoRecording } from "./videoRecordingManager";
import { IOSCtrlProxyManager } from "../utils/IOSCtrlProxyManager";
import { logger } from "../utils/logger";
import { createPerformanceTracker } from "../utils/PerformanceTracker";
import { platformSchema } from "./toolSchemaHelpers";

// Schema definitions
export const listDeviceImagesSchema = z.object({
  platform: platformSchema
});

export const listDevicesSchema = z.object({
  platform: platformSchema.optional()
});

export const startDeviceSchema = z.object({
  device: z.object({
    name: z.string().describe("Device name"),
    platform: platformSchema,
    deviceId: z.string().optional().describe("Device ID"),
    isRunning: z.boolean().optional().describe("Running status"),
    source: z.string().optional().describe("Source (local/remote)")
  }).describe("Device to start"),
  timeoutMs: z.number().optional().describe("Readiness timeout ms")
});

export const killDeviceSchema = z.object({
  device: z.object({
    name: z.string().describe("Device image name"),
    deviceId: z.string().describe("Device ID"),
    platform: platformSchema
  })
});

// Export interfaces for type safety
export interface StartDeviceArgs {
  device: DeviceInfo;
  timeoutMs?: number;
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
}

let moduleDependencies: DeviceToolsDependencies | null = null;

function getDeviceToolsDependencies(): DeviceToolsDependencies {
  if (!moduleDependencies) {
    moduleDependencies = {
      deviceManagerFactory: () => new MultiPlatformDeviceManager()
    };
  }
  return moduleDependencies;
}

export function setDeviceToolsDependencies(deps: Partial<DeviceToolsDependencies>): void {
  const currentDeps = getDeviceToolsDependencies();
  moduleDependencies = {
    deviceManagerFactory: deps.deviceManagerFactory ?? currentDeps.deviceManagerFactory
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

  // Start emulator handler
  const startDeviceHandler = async (args: StartDeviceArgs, progress?: ProgressCallback) => {
    const perf = createPerformanceTracker(true);
    perf.serial("startDevice");
    try {
      if (args.device.platform === "ios" && !args.device.deviceId) {
        throw new ActionableError("iOS simulator deviceId (UDID) is required to start a simulator.");
      }

      const deviceUtils = getDeviceToolsDependencies().deviceManagerFactory();
      perf.startOperation("launchProcess");
      const childProcess = await deviceUtils.startDevice(args.device);
      perf.endOperation("launchProcess");

      if (progress) {
        await progress(60, 100, "Device started, waiting for readiness...");
      }

      // Wait for device to be ready
      perf.startOperation("waitForReady");
      const readyDevice = await deviceUtils.waitForDeviceReady(args.device, args.timeoutMs);
      perf.endOperation("waitForReady");

      if (progress) {
        await progress(100, 100, "Device is ready for use");
      }

      // Notify that booted device resources have changed
      perf.startOperation("notifyResources");
      await notifyBootedDeviceResourcesUpdated();
      await notifyDeviceImageResourcesUpdated();
      await syncInstalledAppResources();
      perf.endOperation("notifyResources");

      perf.end();
      const timing = perf.getTimings();

      return createJSONToolResponse({
        message: `${args.device.platform} '${args.device.name}' started and is ready`,
        name: readyDevice.name,
        processId: childProcess.pid,
        isReady: true,
        deviceId: readyDevice.deviceId,
        source: args.device.source,
        platform: args.device.platform,
        timing,
      });
    } catch (error) {
      perf.end();
      if (error instanceof ActionableError) {
        throw error;
      }
      throw new ActionableError(`Failed to start ${args.device.platform} device: ${error}`);
    }
  };

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

  ToolRegistry.register(
    "startDevice",
    "Start device",
    startDeviceSchema,
    startDeviceHandler,
    true // Supports progress notifications
  );

  ToolRegistry.register(
    "killDevice",
    "Kill device",
    killDeviceSchema,
    killDeviceHandler
  );
}

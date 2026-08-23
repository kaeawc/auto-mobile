import { logger } from "../utils/logger";
import type { BootedDevice, Platform, ViewHierarchyResult } from "../models";
import type { DeviceDataStreamSocketServer } from "./deviceDataStreamSocketServer";
import type { PerformanceTracker } from "../utils/PerformanceTracker";
import type {
  AccessibilityHierarchy,
  AccessibilityHierarchyResponse,
} from "../features/observe/android";
import type { ScreenshotCaptureResult } from "../features/observe/ScreenshotBackoffScheduler";
import type {
  CtrlProxyHierarchy,
  CtrlProxyHierarchyResponse,
  CtrlProxyScreenshotResult,
} from "../features/observe/ios/types";
import {
  IOS_CTRLPROXY_SCREENSHOT_METADATA,
  metadataForScreenshotFormat,
  pickScreenshotMetadata,
} from "../features/observe/ScreenshotMetadata";
import { readScreenScaleMetadata } from "../models/ScreenScaleMetadata";
import { COORDINATE_SPACE_PX } from "./canonicalPixels";

const INITIAL_FRAME_HIERARCHY_TIMEOUT_MS = 3_000;
const INITIAL_FRAME_SCREENSHOT_TIMEOUT_MS = 3_000;
const ANDROID_DEFAULT_SCREEN_WIDTH = 1080;
const ANDROID_DEFAULT_SCREEN_HEIGHT = 2340;
const IOS_DEFAULT_SCREEN_WIDTH = 1170;
const IOS_DEFAULT_SCREEN_HEIGHT = 2532;

export interface ObservationStreamDevice {
  id: string;
  name: string;
  platform: Platform;
}

export interface ObservationStreamAndroidClient {
  ensureConnected(): Promise<boolean>;
  getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
  ): Promise<AccessibilityHierarchyResponse>;
  requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ hierarchy: AccessibilityHierarchy; frameContext?: string } | null>;
  convertToViewHierarchyResult(hierarchy: AccessibilityHierarchy): ViewHierarchyResult;
  recordInitialObservationStreamHierarchy(
    hierarchy: ViewHierarchyResult,
    captureSequence: number | null,
  ): void;
  captureScreenshotForObservationStream(): Promise<ScreenshotCaptureResult>;
}

export interface ObservationStreamIosClient {
  ensureConnected(): Promise<boolean>;
  getLatestHierarchy(
    waitForFresh?: boolean,
    timeout?: number,
    perf?: PerformanceTracker,
    skipWaitForFresh?: boolean,
    minTimestamp?: number,
  ): Promise<CtrlProxyHierarchyResponse>;
  requestHierarchySyncWithoutObservationStreamPush(
    perf?: PerformanceTracker,
    disableAllFiltering?: boolean,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ hierarchy: unknown; frameContext?: string } | null>;
  convertToViewHierarchyResult(hierarchy: unknown): ViewHierarchyResult;
  recordInitialObservationStreamHierarchy(
    hierarchy: ViewHierarchyResult,
    captureSequence: number | null,
  ): void;
  requestScreenshotWithoutObservationStreamPush(
    timeoutMs?: number,
    perf?: PerformanceTracker,
  ): Promise<CtrlProxyScreenshotResult>;
}

export interface ObservationInitialFrameDependencies {
  streamServer: Pick<DeviceDataStreamSocketServer, "pushHierarchyUpdate" | "pushScreenshotUpdate">;
  androidClientFactory: (device: BootedDevice) => ObservationStreamAndroidClient;
  iosClientFactory: (device: BootedDevice) => ObservationStreamIosClient;
}

export async function pushInitialObservationFramesForSubscriber(
  requestedDeviceId: string | null,
  devices: ObservationStreamDevice[],
  dependencies: ObservationInitialFrameDependencies,
): Promise<void> {
  const targetDevices = devices.filter(
    (device) => requestedDeviceId === null || device.id === requestedDeviceId,
  );

  await Promise.all(
    targetDevices.map((device) => pushInitialObservationFrameForDevice(device, dependencies)),
  );
}

async function pushInitialObservationFrameForDevice(
  device: ObservationStreamDevice,
  dependencies: ObservationInitialFrameDependencies,
): Promise<void> {
  const bootedDevice: BootedDevice = {
    deviceId: device.id,
    name: device.name,
    platform: device.platform,
  };

  try {
    if (device.platform === "android") {
      await pushAndroidInitialObservationFrame(bootedDevice, dependencies);
      return;
    }

    if (device.platform === "ios") {
      await pushIosInitialObservationFrame(bootedDevice, dependencies);
    }
  } catch (error) {
    logger.warn(`[Daemon] Failed to push initial observation frame for ${device.id}: ${error}`);
  }
}

async function pushAndroidInitialObservationFrame(
  device: BootedDevice,
  dependencies: ObservationInitialFrameDependencies,
): Promise<void> {
  const client = dependencies.androidClientFactory(device);
  const connected = await client.ensureConnected();
  if (!connected) {
    logger.warn(`[Daemon] Failed to connect WebSocket to ${device.deviceId}`);
    return;
  }

  logger.info(`[Daemon] WebSocket connected to ${device.deviceId} for observation stream`);

  const initialHierarchy = await getAndroidInitialHierarchy(client);
  if (!initialHierarchy) {
    logger.warn(
      `[Daemon] No hierarchy available for initial observation frame on ${device.deviceId}`,
    );
    return;
  }

  const viewHierarchy = client.convertToViewHierarchyResult(initialHierarchy.hierarchy);
  const frameContext = initialHierarchy.frameContext ?? viewHierarchy.frameContext;
  const captureSequence = dependencies.streamServer.pushHierarchyUpdate(
    device.deviceId,
    viewHierarchy,
    frameContext,
  );
  client.recordInitialObservationStreamHierarchy(viewHierarchy, captureSequence);

  await pushAndroidInitialScreenshot(
    device.deviceId,
    client,
    dependencies.streamServer,
    viewHierarchy,
    captureSequence,
    frameContext,
  );
}

async function pushAndroidInitialScreenshot(
  deviceId: string,
  client: ObservationStreamAndroidClient,
  streamServer: Pick<DeviceDataStreamSocketServer, "pushScreenshotUpdate">,
  viewHierarchy: ViewHierarchyResult,
  captureSequence: number | null,
  hierarchyFrameContext: string | undefined,
): Promise<void> {
  const screenshot = await client.captureScreenshotForObservationStream();
  if (screenshot.success && screenshot.data) {
    const dimensions = getAndroidScreenshotDimensions(viewHierarchy);
    streamServer.pushScreenshotUpdate(
      deviceId,
      screenshot.data,
      dimensions.width,
      dimensions.height,
      pickScreenshotMetadata(screenshot),
      {
        ...captureSequenceOptions(captureSequence, hierarchyFrameContext, screenshot.frameContext),
        ...canonicalPixelScreenshotOptions(viewHierarchy),
        rotation: screenshot.rotation,
        ...(screenshot.frameContext === undefined ? {} : { frameContext: screenshot.frameContext }),
      },
    );
  }
}

/**
 * Declare `coordinateSpace: "px"` on the screenshot when — and only when — the runner supplied
 * complete scale metadata (#4549), matching the stamp `pushHierarchyUpdate` applies to the paired
 * hierarchy. A pre-#4548 runner has no metadata, so the frame stays legacy point-space.
 */
function canonicalPixelScreenshotOptions(
  hierarchy: ViewHierarchyResult,
): { coordinateSpace: typeof COORDINATE_SPACE_PX; nativeScale: number } | Record<string, never> {
  const metadata = readScreenScaleMetadata(hierarchy);
  return metadata
    ? { coordinateSpace: COORDINATE_SPACE_PX, nativeScale: metadata.nativeScale }
    : {};
}

/**
 * A screenshot captured after the paired hierarchy may describe a same-size new screen. When
 * both device-authored contexts are present, only an exact match proves the old identity still
 * applies. Legacy runners omit one or both contexts, so they retain the existing identity rule.
 */
function captureSequenceOptions(
  captureSequence: number | null,
  hierarchyFrameContext: string | undefined,
  screenshotFrameContext: string | undefined,
): { captureSequence?: number } {
  if (
    captureSequence === null ||
    (hierarchyFrameContext !== undefined &&
      screenshotFrameContext !== undefined &&
      hierarchyFrameContext !== screenshotFrameContext)
  ) {
    return {};
  }
  return { captureSequence };
}

async function getAndroidInitialHierarchy(
  client: ObservationStreamAndroidClient,
): Promise<{ hierarchy: AccessibilityHierarchy; frameContext?: string } | null> {
  const hierarchyResponse = await client.getLatestHierarchy(
    false,
    INITIAL_FRAME_HIERARCHY_TIMEOUT_MS,
    undefined,
    true,
  );
  if (hierarchyResponse.hierarchy && hierarchyResponse.fresh) {
    return {
      hierarchy: hierarchyResponse.hierarchy,
      frameContext: hierarchyResponse.frameContext,
    };
  }

  const syncHierarchy = await client.requestHierarchySyncWithoutObservationStreamPush(
    undefined,
    false,
    undefined,
    INITIAL_FRAME_HIERARCHY_TIMEOUT_MS,
  );
  return syncHierarchy
    ? { hierarchy: syncHierarchy.hierarchy, frameContext: syncHierarchy.frameContext }
    : null;
}

async function pushIosInitialObservationFrame(
  device: BootedDevice,
  dependencies: ObservationInitialFrameDependencies,
): Promise<void> {
  const client = dependencies.iosClientFactory(device);
  const connected = await client.ensureConnected();
  if (!connected) {
    logger.warn(`[Daemon] Failed to connect CtrlProxy iOS to ${device.deviceId}`);
    return;
  }

  logger.info(`[Daemon] CtrlProxy iOS connected to ${device.deviceId} for observation stream`);

  const initialHierarchy = await getIosInitialHierarchy(client);
  if (!initialHierarchy) {
    logger.warn(
      `[Daemon] No hierarchy available for initial observation frame on ${device.deviceId}`,
    );
    return;
  }

  const viewHierarchy = client.convertToViewHierarchyResult(initialHierarchy.hierarchy);
  const frameContext = initialHierarchy.frameContext ?? viewHierarchy.frameContext;
  const captureSequence = dependencies.streamServer.pushHierarchyUpdate(
    device.deviceId,
    viewHierarchy,
    frameContext,
  );
  client.recordInitialObservationStreamHierarchy(viewHierarchy, captureSequence);

  const screenshot = await client.requestScreenshotWithoutObservationStreamPush(
    INITIAL_FRAME_SCREENSHOT_TIMEOUT_MS,
  );
  if (screenshot.success && screenshot.data) {
    const dimensions = getIosScreenshotDimensions(viewHierarchy);
    dependencies.streamServer.pushScreenshotUpdate(
      device.deviceId,
      screenshot.data,
      dimensions.width,
      dimensions.height,
      metadataForScreenshotFormat(IOS_CTRLPROXY_SCREENSHOT_METADATA, screenshot.format),
      {
        ...captureSequenceOptions(captureSequence, frameContext, screenshot.frameContext),
        ...canonicalPixelScreenshotOptions(viewHierarchy),
        rotation: screenshot.rotation,
        ...(screenshot.frameContext === undefined ? {} : { frameContext: screenshot.frameContext }),
      },
    );
  }
}

async function getIosInitialHierarchy(
  client: ObservationStreamIosClient,
): Promise<{ hierarchy: CtrlProxyHierarchy; frameContext?: string } | null> {
  const hierarchyResponse = await client.getLatestHierarchy(
    false,
    INITIAL_FRAME_HIERARCHY_TIMEOUT_MS,
    undefined,
    true,
  );
  if (hierarchyResponse.hierarchy && hierarchyResponse.fresh) {
    return {
      hierarchy: hierarchyResponse.hierarchy,
      frameContext: hierarchyResponse.frameContext,
    };
  }

  const syncHierarchy = await client.requestHierarchySyncWithoutObservationStreamPush(
    undefined,
    false,
    undefined,
    INITIAL_FRAME_HIERARCHY_TIMEOUT_MS,
  );
  return syncHierarchy
    ? {
        hierarchy: syncHierarchy.hierarchy as CtrlProxyHierarchy,
        frameContext: syncHierarchy.frameContext,
      }
    : null;
}

function getAndroidScreenshotDimensions(hierarchy: ViewHierarchyResult): {
  width: number;
  height: number;
} {
  return {
    width: hierarchy.screenWidth ?? ANDROID_DEFAULT_SCREEN_WIDTH,
    height: hierarchy.screenHeight ?? ANDROID_DEFAULT_SCREEN_HEIGHT,
  };
}

function getIosScreenshotDimensions(hierarchy: ViewHierarchyResult): {
  width: number;
  height: number;
} {
  // Canonical pixels (#4549): when the runner supplied complete scale metadata, the physical
  // screenshot pixel dimensions are the runner-reported `pixelWidth`/`pixelHeight` — the daemon no
  // longer multiplies points by a screen scale for them. A pre-#4548 runner has no metadata, so
  // fall back to the legacy `round(points * screenScale)` claim, byte-identical to before.
  const metadata = readScreenScaleMetadata(hierarchy);
  if (metadata) {
    return { width: metadata.pixelWidth, height: metadata.pixelHeight };
  }
  const scale = hierarchy.screenScale ?? 1;
  return {
    width: hierarchy.screenWidth
      ? Math.round(hierarchy.screenWidth * scale)
      : IOS_DEFAULT_SCREEN_WIDTH,
    height: hierarchy.screenHeight
      ? Math.round(hierarchy.screenHeight * scale)
      : IOS_DEFAULT_SCREEN_HEIGHT,
  };
}

import { errorMessage } from "../utils/describeUnknownError";
import type { InitialFrameSubscriber } from "./deviceDataStreamSocketServer";
import type { ObservationInitialFrameCoordinator } from "./observationInitialFrameCoordinator";
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
import type { PassiveWorkPolicy } from "./PassiveWorkPolicy";

export type ObservationStreamPolicy = Pick<PassiveWorkPolicy, "allows">;

const INITIAL_FRAME_HIERARCHY_TIMEOUT_MS = 3_000;
const INITIAL_FRAME_SCREENSHOT_TIMEOUT_MS = 3_000;
export const INITIAL_FRAME_MAX_CONCURRENCY = 2;
const ANDROID_DEFAULT_SCREEN_WIDTH = 1080;
const ANDROID_DEFAULT_SCREEN_HEIGHT = 2340;
const IOS_DEFAULT_SCREEN_WIDTH = 1170;
const IOS_DEFAULT_SCREEN_HEIGHT = 2532;

export interface ObservationStreamDevice {
  id: string;
  name: string;
  platform: Platform;
}

/** Select devices whose initial observation stream connection is passive-work eligible. */
export function selectObservationStreamDevices(
  devices: readonly ObservationStreamDevice[],
  policy: ObservationStreamPolicy,
  onSkipped?: (device: ObservationStreamDevice) => void,
): ObservationStreamDevice[] {
  return devices.filter((device) => {
    if (policy.allows(device.platform, "observation-stream", device.id)) {
      return true;
    }
    onSkipped?.(device);
    return false;
  });
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
  streamServer: Pick<DeviceDataStreamSocketServer, "pushHierarchyUpdate" | "pushScreenshotUpdate"> &
    Partial<
      Pick<
        DeviceDataStreamSocketServer,
        "getCurrentFrameContextGeneration" | "getLiveFrameGeneration" | "getDeviceSessionUuid"
      >
    >;
  androidClientFactory: (device: BootedDevice) => ObservationStreamAndroidClient;
  iosClientFactory: (device: BootedDevice) => ObservationStreamIosClient;
  maxConcurrency?: number;
  coordinator?: ObservationInitialFrameCoordinator;
  subscriber?: InitialFrameSubscriber;
  isDeviceAllowed?: (deviceId: string) => boolean;
}

export async function pushInitialObservationFramesForSubscriber(
  requestedDeviceId: string | null,
  devices: ObservationStreamDevice[],
  dependencies: ObservationInitialFrameDependencies,
): Promise<void> {
  const targetDevices = devices.filter(
    (device) => requestedDeviceId === null || device.id === requestedDeviceId,
  );

  const maxConcurrency = dependencies.maxConcurrency ?? INITIAL_FRAME_MAX_CONCURRENCY;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("Initial observation frame concurrency must be a positive integer");
  }

  if (dependencies.coordinator) {
    if (!dependencies.subscriber) {
      throw new Error("Coalesced initial frames require a subscriber target");
    }
    const { coordinator, subscriber } = dependencies;
    await Promise.all(
      targetDevices.map(async (device) => {
        try {
          const result = await coordinator.request(
            device.id,
            () => captureInitialObservationFrame(device, dependencies),
            subscriber.signal,
            dependencies.maxConcurrency,
          );
          if (
            result &&
            !subscriber.signal.aborted &&
            (dependencies.isDeviceAllowed?.(device.id) ?? true)
          ) {
            deliverInitialObservationFrame(device.id, result.frame, dependencies, {
              ...subscriber,
              replay: result.replay,
            });
          }
        } catch (error) {
          logger.warn(
            `[Daemon] Failed to push initial observation frame for ${device.id}: ${errorMessage(error)}`,
            error,
          );
        }
      }),
    );
    return;
  }

  let nextDeviceIndex = 0;
  async function captureNextDevices(): Promise<void> {
    while (nextDeviceIndex < targetDevices.length) {
      const device = targetDevices[nextDeviceIndex++];
      await pushInitialObservationFrameForDevice(device, dependencies);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(maxConcurrency, targetDevices.length) }, () =>
      captureNextDevices(),
    ),
  );
}

export interface InitialObservationFrame {
  hierarchy: ViewHierarchyResult;
  frameContext?: string;
  screenshot?: {
    data: string;
    width: number;
    height: number;
    metadata: ReturnType<typeof pickScreenshotMetadata>;
    frameContext?: string;
    rotation?: number;
  };
  screenshotFailure?: { error: unknown };
  captureSequence?: number;
  frameContextGeneration?: number;
  liveFrameGeneration?: number;
  deviceSessionUuid?: string | null;
  recordHierarchy: (captureSequence: number | null) => void;
}

async function pushInitialObservationFrameForDevice(
  device: ObservationStreamDevice,
  dependencies: ObservationInitialFrameDependencies,
): Promise<void> {
  try {
    const frame = await captureInitialObservationFrame(device, dependencies);
    if (frame) {
      deliverInitialObservationFrame(device.id, frame, dependencies);
    }
  } catch (error) {
    logger.warn(
      `[Daemon] Failed to push initial observation frame for ${device.id}: ${errorMessage(error)}`,
      error,
    );
  }
}

async function captureInitialObservationFrame(
  device: ObservationStreamDevice,
  dependencies: ObservationInitialFrameDependencies,
): Promise<InitialObservationFrame | undefined> {
  const bootedDevice: BootedDevice = {
    deviceId: device.id,
    name: device.name,
    platform: device.platform,
  };
  if (device.platform !== "android" && device.platform !== "ios") {
    return undefined;
  }
  // Bind provenance before connection setup, which can itself cross a device boundary.
  const liveFrameGeneration = dependencies.streamServer.getLiveFrameGeneration?.(device.id);
  const deviceSessionUuid = dependencies.streamServer.getDeviceSessionUuid?.(device.id);
  // Narrow platform-specific calls before combining the common capture contract.
  const source =
    device.platform === "android"
      ? androidCaptureSource(dependencies.androidClientFactory(bootedDevice))
      : iosCaptureSource(dependencies.iosClientFactory(bootedDevice));
  if (!(await source.client.ensureConnected())) {
    throw new Error(`Failed to connect CtrlProxy to ${device.id}`);
  }
  logger.info(`[Daemon] Capturing initial observation frame for ${device.id}`);
  const frameContextGeneration = dependencies.streamServer.getCurrentFrameContextGeneration?.(
    device.id,
  );
  const initialHierarchy = await source.hierarchy();
  if (!initialHierarchy) {
    throw new Error(`No hierarchy available for initial observation frame on ${device.id}`);
  }
  const hierarchy = initialHierarchy.hierarchy;
  const frame: InitialObservationFrame = {
    hierarchy,
    frameContext: initialHierarchy.frameContext ?? hierarchy.frameContext,
    frameContextGeneration,
    liveFrameGeneration,
    deviceSessionUuid,
    recordHierarchy: (sequence) =>
      source.client.recordInitialObservationStreamHierarchy(hierarchy, sequence),
  };
  // Return a typed partial frame so delivery reports a screenshot failure once per waiter,
  // while retaining the hierarchy that the old initial-frame path already sent.
  const screenshot = await Promise.resolve()
    .then(() => source.screenshot())
    .then(
      (value) => value,
      (error: unknown) => {
        frame.screenshotFailure = { error };
        return undefined;
      },
    );
  if (screenshot) {
    const dimensions =
      device.platform === "android"
        ? getAndroidScreenshotDimensions(hierarchy)
        : getIosScreenshotDimensions(hierarchy);
    frame.screenshot = { ...screenshot, ...dimensions };
  }
  return frame;
}

function androidCaptureSource(client: ObservationStreamAndroidClient) {
  return {
    client,
    hierarchy: async () => {
      const initial = await getAndroidInitialHierarchy(client);
      return initial
        ? {
            hierarchy: client.convertToViewHierarchyResult(initial.hierarchy),
            frameContext: initial.frameContext,
          }
        : null;
    },
    screenshot: async () => {
      const screenshot = await client.captureScreenshotForObservationStream();
      return screenshot.success && screenshot.data
        ? {
            data: screenshot.data,
            metadata: pickScreenshotMetadata(screenshot),
            frameContext: screenshot.frameContext,
            rotation: screenshot.rotation,
          }
        : undefined;
    },
  };
}

function iosCaptureSource(client: ObservationStreamIosClient) {
  return {
    client,
    hierarchy: async () => {
      const initial = await getIosInitialHierarchy(client);
      return initial
        ? {
            hierarchy: client.convertToViewHierarchyResult(initial.hierarchy),
            frameContext: initial.frameContext,
          }
        : null;
    },
    screenshot: async () => {
      const screenshot = await client.requestScreenshotWithoutObservationStreamPush(
        INITIAL_FRAME_SCREENSHOT_TIMEOUT_MS,
      );
      return screenshot.success && screenshot.data
        ? {
            data: screenshot.data,
            metadata: metadataForScreenshotFormat(
              IOS_CTRLPROXY_SCREENSHOT_METADATA,
              screenshot.format,
            ),
            frameContext: screenshot.frameContext,
            rotation: screenshot.rotation,
          }
        : undefined;
    },
  };
}

function deliverInitialObservationFrame(
  deviceId: string,
  frame: InitialObservationFrame,
  dependencies: ObservationInitialFrameDependencies,
  subscriber?: InitialFrameSubscriber,
): void {
  // Recheck after awaiting the shared job/cache too: a live push may have occurred
  // between coordinator completion and this subscriber's delivery continuation.
  if (!isInitialObservationFrameCurrent(deviceId, frame, dependencies.streamServer)) {
    return;
  }
  // The first fresh delivery reached every entitled current subscriber, including
  // joined waiters. Only a subsequent cache hit needs a targeted replay.
  if (subscriber && !subscriber.replay && frame.captureSequence !== undefined) {
    // Each live request boundary still reports the shared screenshot failure.
    if (frame.screenshotFailure) {
      throw frame.screenshotFailure.error;
    }
    return;
  }
  const sequence = dependencies.streamServer.pushHierarchyUpdate(
    deviceId,
    frame.hierarchy,
    frame.frameContext,
    subscriber
      ? {
          ...subscriber,
          liveFrameGeneration: frame.liveFrameGeneration,
          deviceSessionUuid: frame.deviceSessionUuid,
          captureSequence: frame.captureSequence,
          frameContextGeneration: frame.frameContextGeneration,
        }
      : undefined,
  );
  if (!subscriber || (frame.captureSequence === undefined && sequence !== null)) {
    frame.recordHierarchy(sequence);
  }
  if (sequence !== null) {
    frame.captureSequence = sequence;
    frame.frameContextGeneration =
      dependencies.streamServer.getCurrentFrameContextGeneration?.(deviceId);
  }
  pushInitialObservationScreenshot(
    deviceId,
    frame,
    sequence,
    dependencies.streamServer,
    subscriber,
  );
}

function isInitialObservationFrameCurrent(
  deviceId: string,
  frame: InitialObservationFrame,
  streamServer: ObservationInitialFrameDependencies["streamServer"],
): boolean {
  if (
    frame.liveFrameGeneration !== undefined &&
    streamServer.getLiveFrameGeneration &&
    frame.liveFrameGeneration !== streamServer.getLiveFrameGeneration(deviceId)
  ) {
    return false;
  }
  if (
    frame.deviceSessionUuid !== undefined &&
    streamServer.getDeviceSessionUuid &&
    frame.deviceSessionUuid !== streamServer.getDeviceSessionUuid(deviceId)
  ) {
    return false;
  }
  return (
    frame.frameContextGeneration === undefined ||
    frame.frameContextGeneration === streamServer.getCurrentFrameContextGeneration?.(deviceId)
  );
}

function pushInitialObservationScreenshot(
  deviceId: string,
  frame: InitialObservationFrame,
  sequence: number | null,
  streamServer: ObservationInitialFrameDependencies["streamServer"],
  subscriber?: InitialFrameSubscriber,
): void {
  const screenshot = frame.screenshot;
  if (screenshot && (!subscriber || sequence !== null)) {
    streamServer.pushScreenshotUpdate(
      deviceId,
      screenshot.data,
      screenshot.width,
      screenshot.height,
      screenshot.metadata,
      {
        ...captureSequenceOptions(sequence, frame.frameContext, screenshot.frameContext),
        ...canonicalPixelScreenshotOptions(frame.hierarchy),
        initialFrameSubscriber: subscriber
          ? {
              ...subscriber,
              liveFrameGeneration: frame.liveFrameGeneration,
              deviceSessionUuid: frame.deviceSessionUuid,
            }
          : undefined,
        rotation: screenshot.rotation,
        ...(screenshot.frameContext === undefined ? {} : { frameContext: screenshot.frameContext }),
      },
    );
  }
  if (frame.screenshotFailure) {
    throw frame.screenshotFailure.error;
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

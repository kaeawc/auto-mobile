import { promises as fs } from "node:fs";
import type { BootedDevice } from "../../models";
import { requireAndroidOrIosPlatform } from "../../models";
import { ActionableError } from "../../models/ActionableError";
import type { ElementBounds } from "../../models/ElementBounds";
import type { ViewHierarchyResult } from "../../models/ViewHierarchyResult";
import type { ImageBackend } from "../../utils/image/backend/ImageBackend";
import { createDeviceHierarchyCapture } from "../observe/DeviceHierarchyCapture";
import type { HierarchyCapture, HierarchySnapshot } from "../observe/HierarchyCapture";
import type { ScreenshotService } from "../observe/interfaces/ScreenshotService";
import { TakeScreenshot } from "../observe/TakeScreenshot";
import { isSessionlessDeviceRead } from "../toolSelection/toolSelectionContext";
import { DisplayConfig, type DisplayConfigResult } from "../utility/DisplayConfig";
import { ElementResolver } from "../utility/ElementResolver";
import type { VisualScreen } from "./CompareScreenshot";
import type { VisualDeviceProfile } from "./VisualDeviceProfile";
import { captureTvosScreenshot, type TvosScreenshotCapture } from "../tvos/TvosScreenshot";
import { tvosRunners } from "../tvos/TvosRunnerRegistry";
import {
  captureWatchSimctlScreenshot,
  type WatchScreenshotCapture,
} from "../watch/WatchScreenshot";
import { watchRunners } from "../watch/WatchRunnerRegistry";
import { WatchRunnerError } from "../watch/WatchRunnerError";
import { readImageHeaderDimensions } from "../../utils/screenshot/imageHeaderDimensions";

export interface DeviceVisualScreenDependencies {
  hierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
  screenshotFactory?: (device: BootedDevice) => Pick<ScreenshotService, "execute">;
  readFile?: (filePath: string) => Promise<Buffer>;
  /** Apple TV screen capture; defaults to the runner's screenshot, else `simctl io screenshot`. */
  tvosScreenshot?: TvosScreenshotCapture;
  /** Whether a tvOS runner (and so a view hierarchy) is connected for the device. */
  tvosRunnerConnected?: (deviceId: string) => boolean;
  /** Apple Watch screen capture; defaults to `simctl io screenshot` on the watch's display. */
  watchScreenshot?: WatchScreenshotCapture;
  /** Whether a watch runner (and so a view hierarchy) is connected for the device. */
  watchRunnerConnected?: (deviceId: string) => boolean;
}

/** Why an Apple TV comparison without a runner can compare only the full screen. */
export const TVOS_REGIONS_NEED_RUNNER_MESSAGE =
  "compareScreenshot target and mask regions on tvOS need the tvOS runner's view hierarchy, " +
  "and no runner is connected. Call startDevice to prepare the runner, or compare the full " +
  "screen without target or mask.";

/** Why an Apple Watch comparison without a runner can compare only the full screen. */
export const WATCH_REGIONS_NEED_RUNNER_MESSAGE =
  "compareScreenshot target and mask regions on watchOS need the watch runner's view hierarchy, " +
  "and no runner is connected. Call startDevice to prepare the runner, or compare the full " +
  "screen without target or mask.";

/** Why an Apple Watch comparison whose runner app is in the background compares the full screen. */
export const WATCH_REGIONS_NEED_FOREGROUND_APP_MESSAGE =
  "compareScreenshot target and mask regions on watchOS need the runner's target app in the " +
  "foreground, and it is not. Launch the app with launchApp, or compare the full screen without " +
  "target or mask.";

type EdgeInsets = { top: number; right: number; bottom: number; left: number };

/** The native rectangles the visible system bars cover, from the hierarchy's insets. */
export function systemBarRects(
  hierarchy: Pick<ViewHierarchyResult, "insets" | "systemInsets">,
  screen: { width: number; height: number },
): ElementBounds[] {
  const insets: EdgeInsets | undefined =
    hierarchy.insets?.systemBars?.visible ?? hierarchy.systemInsets;
  if (!insets) {
    return [];
  }
  const { width, height } = screen;
  const rects: ElementBounds[] = [
    { left: 0, top: 0, right: width, bottom: insets.top },
    { left: 0, top: height - insets.bottom, right: width, bottom: height },
    { left: 0, top: 0, right: insets.left, bottom: height },
    { left: width - insets.right, top: 0, right: width, bottom: height },
  ];
  return rects.filter((rect) => rect.right > rect.left && rect.bottom > rect.top);
}

/** The bounds of exactly one exposed element in the capture, or an actionable error. */
function resolveElementBounds(
  snapshot: Pick<HierarchySnapshot, "captureId" | "nodes">,
  elementId: string,
): ElementBounds {
  const resolution = new ElementResolver().resolve(
    { id: snapshot.captureId, nodes: snapshot.nodes },
    { elementId },
    { action: "inspect", requireBounds: true },
  );
  if (resolution.error) {
    throw new ActionableError(resolution.error);
  }
  if (resolution.candidates.length !== 1 || !resolution.chosen?.bounds) {
    throw new ActionableError(
      resolution.candidates.length === 0
        ? `compareScreenshot element '${elementId}' was not found with bounds`
        : `compareScreenshot element '${elementId}' is ambiguous (${resolution.candidates.length} matches)`,
    );
  }
  return resolution.chosen.bounds;
}

/** A full-screen PNG from the same screenshot path `snapshotOf` uses. */
async function captureScreenshotPng(
  device: BootedDevice,
  deps: DeviceVisualScreenDependencies,
): Promise<Buffer> {
  const service = deps.screenshotFactory?.(device) ?? new TakeScreenshot(device);
  const screenshot = await service.execute({ format: "png" });
  if (!screenshot.success || !screenshot.path) {
    throw new ActionableError(
      `compareScreenshot screenshot capture failed: ${screenshot.error ?? "no path"}`,
    );
  }
  return (deps.readFile ?? fs.readFile)(screenshot.path);
}

/** The PNG's pixel size, read from its header. */
function pngSize(png: Buffer, label: string): { width: number; height: number } {
  const size = readImageHeaderDimensions(png);
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new ActionableError(`compareScreenshot could not read the ${label} screenshot's size`);
  }
  return { width: size.width, height: size.height };
}

/** How one runner-backed Apple simulator platform captures a comparison screen. */
interface AppleRunnerVisualSource {
  label: string;
  connected: boolean;
  screenshot: (device: BootedDevice) => Promise<Buffer>;
  regionsNeedRunnerMessage: string;
  /** The message for a runner hierarchy failure that still allows a full-screen comparison. */
  fullScreenOnlyReason?: (error: unknown) => string | undefined;
}

/** A screenshot whose regions cannot be placed: its point size is its pixel size. */
async function fullScreenOnlyVisualScreen(
  device: BootedDevice,
  source: AppleRunnerVisualSource,
  reason: string,
): Promise<VisualScreen & { hierarchy: Partial<ViewHierarchyResult> }> {
  const png = await source.screenshot(device);
  const screenSize = pngSize(png, source.label);
  return {
    png,
    hierarchy: {},
    geometry: { platform: "ios", screenSize, rasterOrientation: "display" },
    systemBars: [],
    resolveElement: () => {
      throw new ActionableError(reason);
    },
    regionsUnavailable: reason,
  };
}

/**
 * An Apple TV (#16725) or Apple Watch (#19056) screen. Neither has system bars. With the
 * platform runner connected the hierarchy places element ids and point rectangles; without it
 * only the full screen compares.
 */
async function captureAppleRunnerVisualScreen(
  device: BootedDevice,
  deps: DeviceVisualScreenDependencies,
  source: AppleRunnerVisualSource,
): Promise<VisualScreen & { hierarchy: Partial<ViewHierarchyResult> }> {
  if (!source.connected) {
    return fullScreenOnlyVisualScreen(device, source, source.regionsNeedRunnerMessage);
  }
  const capture = deps.hierarchyCaptureFactory?.(device) ?? createDeviceHierarchyCapture(device);
  let snapshot: HierarchySnapshot;
  try {
    snapshot = await capture.capture({ freshness: "fresh" });
  } catch (error) {
    const reason = source.fullScreenOnlyReason?.(error);
    if (reason === undefined) {
      throw error;
    }
    return fullScreenOnlyVisualScreen(device, source, reason);
  }
  const { screenWidth, screenHeight } = snapshot.hierarchy;
  if (!screenWidth || !screenHeight) {
    throw new ActionableError(
      "compareScreenshot requires screen dimensions from a fresh hierarchy",
    );
  }
  const png = await source.screenshot(device);
  return {
    png,
    hierarchy: snapshot.hierarchy,
    // Runner bounds are points, like iOS; the scale comes from the screenshot's pixel size.
    geometry: {
      platform: "ios",
      screenSize: { width: screenWidth, height: screenHeight },
      rasterOrientation: "display",
    },
    systemBars: [],
    resolveElement: (elementId) => resolveElementBounds(snapshot, elementId),
  };
}

function tvosVisualSource(
  device: BootedDevice,
  deps: DeviceVisualScreenDependencies,
): AppleRunnerVisualSource {
  const connected = deps.tvosRunnerConnected ?? ((id) => tvosRunners.get(id) !== undefined);
  return {
    label: "tvOS",
    connected: connected(device.deviceId),
    screenshot: (target) => (deps.tvosScreenshot ?? captureTvosScreenshot)(target),
    regionsNeedRunnerMessage: TVOS_REGIONS_NEED_RUNNER_MESSAGE,
  };
}

/** The watch runner has no screenshot command, so a watch always captures through simctl. */
function watchVisualSource(
  device: BootedDevice,
  deps: DeviceVisualScreenDependencies,
): AppleRunnerVisualSource {
  const connected = deps.watchRunnerConnected ?? ((id) => watchRunners.get(id) !== undefined);
  return {
    label: "watchOS",
    connected: connected(device.deviceId),
    screenshot: (target) => (deps.watchScreenshot ?? captureWatchSimctlScreenshot)(target),
    regionsNeedRunnerMessage: WATCH_REGIONS_NEED_RUNNER_MESSAGE,
    // A backgrounded runner app has no hierarchy, but its screenshot still compares (#19056).
    fullScreenOnlyReason: (error) =>
      error instanceof WatchRunnerError && error.errorCode === "app_not_foreground"
        ? WATCH_REGIONS_NEED_FOREGROUND_APP_MESSAGE
        : undefined,
  };
}

/**
 * One fresh hierarchy plus screenshot of the device (#14083), the same capture `snapshotOf` uses,
 * so element ids and rectangles resolve against the screen the pixels came from.
 */
export async function captureDeviceVisualScreen(
  device: BootedDevice,
  deps: DeviceVisualScreenDependencies = {},
): Promise<VisualScreen & { hierarchy: Partial<ViewHierarchyResult> }> {
  if (device.platform === "tvos") {
    return captureAppleRunnerVisualScreen(device, deps, tvosVisualSource(device, deps));
  }
  if (device.platform === "watchos") {
    return captureAppleRunnerVisualScreen(device, deps, watchVisualSource(device, deps));
  }
  const platform = requireAndroidOrIosPlatform(device.platform, "Visual screenshot comparison");
  const capture = deps.hierarchyCaptureFactory?.(device) ?? createDeviceHierarchyCapture(device);
  const snapshot = await capture.capture({
    freshness: "fresh",
    ...(isSessionlessDeviceRead() ? { observerMode: true } : {}),
  });
  const { screenWidth, screenHeight } = snapshot.hierarchy;
  if (!screenWidth || !screenHeight) {
    throw new ActionableError(
      "compareScreenshot requires screen dimensions from a fresh hierarchy",
    );
  }
  const png = await captureScreenshotPng(device, deps);
  const screenSize = { width: screenWidth, height: screenHeight };
  return {
    png,
    hierarchy: snapshot.hierarchy,
    geometry: {
      platform,
      screenSize,
      rotation: snapshot.hierarchy.rotation,
      nativeScale: snapshot.hierarchy.nativeScale,
    },
    systemBars: systemBarRects(snapshot.hierarchy, screenSize),
    resolveElement: (elementId) => resolveElementBounds(snapshot, elementId),
  };
}

/** Reads the display settings a profile records; physical iOS reports none. */
export type DisplaySettingsReader = (device: BootedDevice) => Promise<DisplayConfigResult>;

export const defaultDisplaySettingsReader: DisplaySettingsReader = (device) =>
  new DisplayConfig(device).getConfig();

/** The device profile a baseline is recorded under: screenshot size, density, font scale, theme. */
export async function readVisualDeviceProfile(
  device: BootedDevice,
  screen: VisualScreen & { hierarchy: Pick<ViewHierarchyResult, "density" | "nativeScale"> },
  backend: Pick<ImageBackend, "metadata">,
  readSettings: DisplaySettingsReader = defaultDisplaySettingsReader,
): Promise<VisualDeviceProfile> {
  // Apple TV and Apple Watch have no display settings reader: the profile is the screenshot size.
  if (device.platform === "tvos" || device.platform === "watchos") {
    const { width, height } = await backend.metadata(screen.png);
    return {
      platform: device.platform,
      width,
      height,
      density: null,
      fontScale: null,
      theme: null,
    };
  }
  const [{ width, height }, settings] = await Promise.all([
    backend.metadata(screen.png),
    readSettings(device),
  ]);
  const fontScale = settings.current?.fontScale;
  const theme = settings.current?.theme;
  return {
    platform: requireAndroidOrIosPlatform(device.platform, "Visual screenshot comparison"),
    width,
    height,
    density: screen.hierarchy.density ?? screen.hierarchy.nativeScale ?? null,
    fontScale: fontScale === undefined ? null : fontScale === "default" ? 1 : fontScale,
    theme: theme ?? null,
  };
}

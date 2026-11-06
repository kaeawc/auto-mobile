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
import { readImageHeaderDimensions } from "../../utils/screenshot/imageHeaderDimensions";

export interface DeviceVisualScreenDependencies {
  hierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
  screenshotFactory?: (device: BootedDevice) => Pick<ScreenshotService, "execute">;
  readFile?: (filePath: string) => Promise<Buffer>;
  /** Apple TV screen capture; defaults to the runner's screenshot, else `simctl io screenshot`. */
  tvosScreenshot?: TvosScreenshotCapture;
  /** Whether a tvOS runner (and so a view hierarchy) is connected for the device. */
  tvosRunnerConnected?: (deviceId: string) => boolean;
}

/** Why an Apple TV comparison without a runner can compare only the full screen. */
export const TVOS_REGIONS_NEED_RUNNER_MESSAGE =
  "compareScreenshot target and mask regions on tvOS need the tvOS runner's view hierarchy, " +
  "and no runner is connected. Call startDevice to prepare the runner, or compare the full " +
  "screen without target or mask.";

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
function pngSize(png: Buffer): { width: number; height: number } {
  const size = readImageHeaderDimensions(png);
  if (!size || size.width <= 0 || size.height <= 0) {
    throw new ActionableError("compareScreenshot could not read the tvOS screenshot's size");
  }
  return { width: size.width, height: size.height };
}

/**
 * An Apple TV screen (#16725). Apple TV has no system bars. With the tvOS runner connected the
 * hierarchy places element ids and point rectangles; without it only the full screen compares.
 */
async function captureTvosVisualScreen(
  device: BootedDevice,
  deps: DeviceVisualScreenDependencies,
): Promise<VisualScreen & { hierarchy: Partial<ViewHierarchyResult> }> {
  const connected = (deps.tvosRunnerConnected ?? ((id) => tvosRunners.get(id) !== undefined))(
    device.deviceId,
  );
  const screenshot = deps.tvosScreenshot ?? captureTvosScreenshot;
  if (!connected) {
    const png = await screenshot(device);
    const screenSize = pngSize(png);
    return {
      png,
      hierarchy: {},
      geometry: { platform: "ios", screenSize, rasterOrientation: "display" },
      systemBars: [],
      resolveElement: () => {
        throw new ActionableError(TVOS_REGIONS_NEED_RUNNER_MESSAGE);
      },
      regionsUnavailable: TVOS_REGIONS_NEED_RUNNER_MESSAGE,
    };
  }
  const capture = deps.hierarchyCaptureFactory?.(device) ?? createDeviceHierarchyCapture(device);
  const snapshot = await capture.capture({ freshness: "fresh" });
  const { screenWidth, screenHeight } = snapshot.hierarchy;
  if (!screenWidth || !screenHeight) {
    throw new ActionableError(
      "compareScreenshot requires screen dimensions from a fresh hierarchy",
    );
  }
  const png = await screenshot(device);
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

/**
 * One fresh hierarchy plus screenshot of the device (#14083), the same capture `snapshotOf` uses,
 * so element ids and rectangles resolve against the screen the pixels came from.
 */
export async function captureDeviceVisualScreen(
  device: BootedDevice,
  deps: DeviceVisualScreenDependencies = {},
): Promise<VisualScreen & { hierarchy: Partial<ViewHierarchyResult> }> {
  if (device.platform === "tvos") {
    return captureTvosVisualScreen(device, deps);
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
  // Apple TV has no display settings reader: its profile is its screenshot size alone.
  if (device.platform === "tvos") {
    const { width, height } = await backend.metadata(screen.png);
    return { platform: "tvos", width, height, density: null, fontScale: null, theme: null };
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

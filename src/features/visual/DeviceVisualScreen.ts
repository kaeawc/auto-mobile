import { promises as fs } from "node:fs";
import type { BootedDevice } from "../../models";
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

export interface DeviceVisualScreenDependencies {
  hierarchyCaptureFactory?: (device: BootedDevice) => HierarchyCapture;
  screenshotFactory?: (device: BootedDevice) => Pick<ScreenshotService, "execute">;
  readFile?: (filePath: string) => Promise<Buffer>;
}

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

/**
 * One fresh hierarchy plus screenshot of the device (#14083), the same capture `snapshotOf` uses,
 * so element ids and rectangles resolve against the screen the pixels came from.
 */
export async function captureDeviceVisualScreen(
  device: BootedDevice,
  deps: DeviceVisualScreenDependencies = {},
): Promise<VisualScreen & { hierarchy: ViewHierarchyResult }> {
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
      platform: device.platform,
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
  const [{ width, height }, settings] = await Promise.all([
    backend.metadata(screen.png),
    readSettings(device),
  ]);
  const fontScale = settings.current?.fontScale;
  const theme = settings.current?.theme;
  return {
    platform: device.platform,
    width,
    height,
    density: screen.hierarchy.density ?? screen.hierarchy.nativeScale ?? null,
    fontScale: fontScale === undefined ? null : fontScale === "default" ? 1 : fontScale,
    theme: theme ?? null,
  };
}

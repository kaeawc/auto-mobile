/**
 * CtrlProxy iOSScreenshot - Delegate for screenshot operations.
 *
 * This delegate handles screenshot capture via the iOS CtrlProxy iOS WebSocket API.
 */

import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { DelegateContext, CtrlProxyScreenshotResult } from "./types";
import { sendCommand } from "../DeviceServiceUtils";
import type { BootedDevice } from "../../../models";
import type { XCTestHierarchy } from "./types";
import type { SimCtl } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { observedIosDisplay } from "../ObservationDisplay";
import { readImageHeaderDimensions } from "../../../utils/screenshot/imageHeaderDimensions";
import { logger } from "../../../utils/logger";
import type { DisplayPanel } from "../../../models/DisplayPanel";

function matchesPanelPixels(
  dimensions: { width: number; height: number } | null,
  panel: DisplayPanel,
): boolean {
  return (
    dimensions !== null &&
    ((dimensions.width === panel.sizePx.width && dimensions.height === panel.sizePx.height) ||
      (dimensions.width === panel.sizePx.height && dimensions.height === panel.sizePx.width))
  );
}

function unexpectedDimensionsMessage(
  panel: DisplayPanel,
  dimensions: { width: number; height: number } | null,
  hierarchy: XCTestHierarchy | null,
): string {
  const actual = dimensions ? `${dimensions.width}x${dimensions.height}` : "unknown";
  const points = hierarchy ? `${hierarchy.screenWidth}x${hierarchy.screenHeight}` : "unknown";
  const scale = hierarchy?.nativeScale ?? hierarchy?.screenScale ?? panel.scale ?? "unknown";
  return `[SCREENSHOT] iOS panel ${panel.key} returned unexpected PNG dimensions ${actual}; inventory ${panel.sizePx.width}x${panel.sizePx.height}, reported points ${points} at scale ${scale}; using runner capture`;
}

async function captureSelectedPanel(
  deviceId: string,
  panel: DisplayPanel,
  hierarchy: XCTestHierarchy | null,
  simctl: Pick<SimCtl, "screenshot">,
  runnerCapture: () => Promise<CtrlProxyScreenshotResult>,
  signal?: AbortSignal,
): Promise<CtrlProxyScreenshotResult> {
  try {
    const png = await simctl.screenshot(deviceId, panel.key, signal);
    const dimensions = readImageHeaderDimensions(png);
    if (matchesPanelPixels(dimensions, panel)) {
      return { success: true, data: png.toString("base64"), format: "png" };
    }
    logger.warn(unexpectedDimensionsMessage(panel, dimensions, hierarchy));
  } catch (error) {
    logger.warn(
      `[SCREENSHOT] iOS panel ${panel.key} capture failed; using runner capture: ${error}`,
    );
  }
  return runnerCapture();
}

/** Select a physical simulator panel, verifying its PNG before accepting it. */
export async function captureIosPanelScreenshot(
  device: BootedDevice,
  hierarchy: XCTestHierarchy | null,
  simctl: Pick<SimCtl, "screenshot">,
  runnerCapture: () => Promise<CtrlProxyScreenshotResult>,
  signal?: AbortSignal,
  activePanelKey?: string,
): Promise<CtrlProxyScreenshotResult> {
  const panels = device.displays?.panels ?? [];
  if (panels.length < 2) {
    return runnerCapture();
  }
  const display = observedIosDisplay(device, hierarchy ?? undefined);
  const panel = panels.find((candidate) => candidate.key === (activePanelKey ?? display.key));
  if (!panel) {
    logger.warn("[SCREENSHOT] Could not identify active iOS panel; using runner capture");
    return runnerCapture();
  }
  return captureSelectedPanel(device.deviceId, panel, hierarchy, simctl, runnerCapture, signal);
}

/**
 * Delegate class for handling screenshot operations.
 */
export class CtrlProxyScreenshot {
  private readonly context: DelegateContext;

  constructor(context: DelegateContext) {
    this.context = context;
  }

  /**
   * Request a screenshot from the CtrlProxy iOS.
   */
  async requestScreenshot(
    timeoutMs: number = 5000,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<CtrlProxyScreenshotResult> {
    return sendCommand<CtrlProxyScreenshotResult>(this.context, {
      idPrefix: "screenshot",
      responseType: "screenshot",
      messageType: "request_screenshot",
      timeoutMs,
      perf,
      abortSignal: signal,
      cancelScreenshotBackoff: false,
      notConnectedError: () => ({ success: false, error: "Not connected" }),
      timeoutError: (timeout) => ({
        success: false,
        error: `Screenshot timed out after ${timeout}ms`,
      }),
    });
  }
}

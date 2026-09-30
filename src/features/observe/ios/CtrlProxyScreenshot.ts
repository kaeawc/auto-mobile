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
  try {
    const png = await simctl.screenshot(device.deviceId, panel.key, signal);
    const dimensions = readImageHeaderDimensions(png);
    if (
      !dimensions ||
      !(
        (dimensions.width === panel.sizePx.width && dimensions.height === panel.sizePx.height) ||
        (dimensions.width === panel.sizePx.height && dimensions.height === panel.sizePx.width)
      )
    ) {
      logger.warn(
        `[SCREENSHOT] iOS panel ${panel.key} returned unexpected PNG dimensions; using runner capture`,
      );
      return runnerCapture();
    }
    return { success: true, data: png.toString("base64"), format: "png" };
  } catch (error) {
    logger.warn(
      `[SCREENSHOT] iOS panel ${panel.key} capture failed; using runner capture: ${error}`,
    );
    return runnerCapture();
  }
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

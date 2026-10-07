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
import { SimctlScreenshotError } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import type { SimCtl } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import { observedIosDisplay } from "../ObservationDisplay";
import {
  detectImageMimeType,
  readImageHeaderDimensions,
} from "../../../utils/screenshot/imageHeaderDimensions";
import { logger } from "../../../utils/logger";
import type { DisplayPanel } from "../../../models/DisplayPanel";
import { errorMessage } from "../../../utils/describeUnknownError";
import {
  createProductionDevicectlPanelScreenshotSource,
  type SimulatorPanelScreenshotSource,
} from "../../../utils/ios-cmdline-tools/DevicectlDisplayScreenshot";

let defaultDevicectlPanelSource: SimulatorPanelScreenshotSource | undefined;

function productionDevicectlPanelSource(): SimulatorPanelScreenshotSource {
  return (defaultDevicectlPanelSource ??= createProductionDevicectlPanelScreenshotSource());
}

export interface IosPanelScreenshotRequest {
  device: BootedDevice;
  hierarchy: XCTestHierarchy | null;
  simctl: Pick<SimCtl, "screenshot">;
  /** CoreDevice per-panel capture, tried first; undefined from it keeps simctl. */
  devicectl: SimulatorPanelScreenshotSource;
  runnerCapture: () => Promise<CtrlProxyScreenshotResult>;
  signal?: AbortSignal;
  activePanelKey?: string;
}

interface SelectedPanelCapture extends Omit<
  IosPanelScreenshotRequest,
  "device" | "activePanelKey"
> {
  deviceId: string;
  panel: DisplayPanel;
  panelCount: number;
}

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

/** Accept a CoreDevice capture only when it is a PNG of the selected panel's size. */
async function captureViaDevicectl(
  request: SelectedPanelCapture,
): Promise<CtrlProxyScreenshotResult | undefined> {
  const { deviceId, panel, panelCount, signal } = request;
  const png = await request.devicectl.capturePanel({ deviceId, panel, panelCount, signal });
  if (!png) {
    return undefined;
  }
  const dimensions = readImageHeaderDimensions(png);
  if (detectImageMimeType(png) === "image/png" && matchesPanelPixels(dimensions, panel)) {
    return { success: true, data: png.toString("base64"), format: "png" };
  }
  const actual = dimensions ? `${dimensions.width}x${dimensions.height}` : "unidentifiable";
  logger.warn(
    `[SCREENSHOT] iOS panel ${panel.key} devicectl capture returned ${actual} (${png.length} bytes); inventory ${panel.sizePx.width}x${panel.sizePx.height}; using simctl`,
  );
  return undefined;
}

async function captureSelectedPanel(
  request: SelectedPanelCapture,
): Promise<CtrlProxyScreenshotResult> {
  const viaDevicectl = await captureViaDevicectl(request);
  if (viaDevicectl) {
    return viaDevicectl;
  }
  const { deviceId, panel, hierarchy, simctl, runnerCapture, signal } = request;
  try {
    const png = await simctl.screenshot(deviceId, panel.key, signal);
    const dimensions = readImageHeaderDimensions(png);
    if (png.length === 0 || dimensions === null || detectImageMimeType(png) === null) {
      const reason = png.length === 0 ? "empty-output" : "non-image-output";
      const magic = png.subarray(0, 16).toString("hex");
      logger.warn(
        `[SCREENSHOT] iOS panel ${panel.key} capture unidentifiable (reason=${reason}): bytes=${png.length} magic=${magic} display=${panel.key} exit=0 stderr=n/a callerAborted=${signal?.aborted === true} device=${deviceId}; using runner capture`,
      );
      return runnerCapture();
    }
    if (matchesPanelPixels(dimensions, panel)) {
      return { success: true, data: png.toString("base64"), format: "png" };
    }
    logger.warn(unexpectedDimensionsMessage(panel, dimensions, hierarchy));
  } catch (error) {
    const diagnostics =
      error instanceof SimctlScreenshotError
        ? ` reason=${error.reason} exit=${error.exitCode ?? "n/a"} stderr="${error.stderrExcerpt}" bytes=${error.byteLength} display=${panel.key} timeoutAborted=${error.reason === "aborted-by-timeout"}`
        : "";
    logger.warn(
      `[SCREENSHOT] iOS panel ${panel.key} capture failed; using runner capture: ${errorMessage(error)} (caller signal aborted: ${signal?.aborted === true})${diagnostics}`,
    );
  }
  return runnerCapture();
}

/**
 * Select a physical simulator panel, verifying its PNG before accepting it.
 * Order: CoreDevice per-panel capture, then simctl, then the runner. A single-display
 * simulator goes straight to the runner and never touches devicectl or simctl.
 */
export async function captureIosPanelScreenshotWith(
  request: IosPanelScreenshotRequest,
): Promise<CtrlProxyScreenshotResult> {
  const { device, hierarchy, activePanelKey } = request;
  const panels = device.displays?.panels ?? [];
  if (panels.length < 2) {
    return request.runnerCapture();
  }
  const display = observedIosDisplay(device, hierarchy ?? undefined);
  const panel = panels.find((candidate) => candidate.key === (activePanelKey ?? display.key));
  if (!panel) {
    logger.warn("[SCREENSHOT] Could not identify active iOS panel; using runner capture");
    return request.runnerCapture();
  }
  return captureSelectedPanel({
    ...request,
    deviceId: device.deviceId,
    panel,
    panelCount: panels.length,
  });
}

/** Production entry point: the process-wide CoreDevice panel source. */
export async function captureIosPanelScreenshot(
  device: BootedDevice,
  hierarchy: XCTestHierarchy | null,
  simctl: Pick<SimCtl, "screenshot">,
  runnerCapture: () => Promise<CtrlProxyScreenshotResult>,
  signal?: AbortSignal,
  activePanelKey?: string,
): Promise<CtrlProxyScreenshotResult> {
  return captureIosPanelScreenshotWith({
    device,
    hierarchy,
    simctl,
    devicectl: productionDevicectlPanelSource(),
    runnerCapture,
    signal,
    activePanelKey,
  });
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
    observerMode = false,
  ): Promise<CtrlProxyScreenshotResult> {
    return sendCommand<CtrlProxyScreenshotResult>(this.context, {
      idPrefix: "screenshot",
      responseType: "screenshot",
      messageType: "request_screenshot",
      timeoutMs,
      perf,
      abortSignal: signal,
      cancelScreenshotBackoff: false,
      requireExistingConnection: observerMode,
      notConnectedError: () => ({ success: false, error: "Not connected" }),
      timeoutError: (timeout) => ({
        success: false,
        error: `Screenshot timed out after ${timeout}ms`,
      }),
    });
  }
}

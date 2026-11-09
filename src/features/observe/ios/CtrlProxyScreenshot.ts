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
import { activeLivePanel, observedIosDisplay } from "../ObservationDisplay";
import {
  detectImageMimeType,
  readImageHeaderDimensions,
} from "../../../utils/screenshot/imageHeaderDimensions";
import { logger } from "../../../utils/logger";
import type { DisplayPanel } from "../../../models/DisplayPanel";
import { errorMessage } from "../../../utils/describeUnknownError";
import type { SimulatorPanelScreenshotSource } from "../../../utils/ios-cmdline-tools/DevicectlDisplayScreenshot";
import { createProductionDevicectlPanelScreenshotSource } from "../../../utils/ios-cmdline-tools/DevicectlPanelScreenshotSource";
import type {
  DevicectlDisplayInfo,
  DevicectlDisplayInfoSource,
} from "../../../utils/ios-cmdline-tools/DevicectlDisplayInfo";
import { isIosDuoDeviceType } from "../../../utils/ios-cmdline-tools/iosDeviceType";

type DevicectlPanelSource = SimulatorPanelScreenshotSource & DevicectlDisplayInfoSource;

let defaultDevicectlPanelSource: DevicectlPanelSource | undefined;

function productionDevicectlPanelSource(): DevicectlPanelSource {
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
  /** Optional live panel evidence when neither the key nor hierarchy identifies a panel. */
  displayInfo?: DevicectlDisplayInfoSource;
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

/** One live `device info displays` read; an empty list when unavailable or failed. */
async function readLiveDisplays(
  request: IosPanelScreenshotRequest,
): Promise<DevicectlDisplayInfo[]> {
  if (!request.displayInfo) {
    return [];
  }
  try {
    const displays = await request.displayInfo.readDisplays({
      deviceId: request.device.deviceId,
      signal: request.signal,
    });
    request.signal?.throwIfAborted();
    return displays;
  } catch (error) {
    if (request.signal?.aborted) {
      throw error;
    }
    logger.warn(
      `[SCREENSHOT] Live iOS panel read failed; using runner capture: ${errorMessage(error)}`,
      error,
    );
    return [];
  }
}

async function readLiveScreenshotPanel(
  request: IosPanelScreenshotRequest,
  panels: readonly DisplayPanel[],
): Promise<DisplayPanel | undefined> {
  return activeLivePanel(await readLiveDisplays(request), panels);
}

/** Whether a screenshot must go through panel selection instead of straight to the runner. */
export function needsIosPanelSelection(device: Pick<BootedDevice, "displays" | "deviceType">) {
  return (device.displays?.panels.length ?? 0) >= 2 || isIosDuoDeviceType(device.deviceType);
}

/** Relative aspect-ratio slack; a Duo's cover and inner panels differ by about 2%. */
const RUNNER_ASPECT_TOLERANCE = 0.01;

function shortOverLong(width: number, height: number): number {
  return Math.min(width, height) / Math.max(width, height);
}

/** Screen geometry a runner fallback is checked against, in any consistent unit. */
interface RunnerReference {
  width: number;
  height: number;
  /** How the reference was obtained, for the rejection message. */
  label: string;
}

/**
 * The geometry a runner fallback must match: the observed hierarchy's screen points, or, with no
 * hierarchy (the sessionless observer path), the inventory size of the panel the caller already
 * identified as active. Undefined when neither is known.
 */
function runnerReference(
  hierarchy: XCTestHierarchy | null,
  expectedPanel: DisplayPanel | undefined,
): RunnerReference | undefined {
  if (hierarchy?.screenWidth && hierarchy.screenHeight) {
    const { screenWidth: width, screenHeight: height } = hierarchy;
    return { width, height, label: `the observed screen is ${width}x${height} points` };
  }
  if (expectedPanel) {
    const { width, height } = expectedPanel.sizePx;
    return {
      width,
      height,
      label: `active panel ${expectedPanel.key} is ${width}x${height} pixels`,
    };
  }
  return undefined;
}

const CAPTURE_UNVERIFIED_ERROR =
  "Runner screenshot could not be verified: no hierarchy or live display read identifies the active panel, and on a multi-panel device the runner may capture an unlit panel. Re-run observe to capture the hierarchy, or check the device posture with setPosture.";

/**
 * Reject a runner capture whose aspect ratio does not match the active screen: on a Duo the
 * runner captures the cover display, which is a black image while unfolded (#17583). With no
 * reference to check against, the capture is returned as a typed `capture_unverified` failure
 * instead of success (#17593).
 */
async function aspectCheckedRunnerCapture(
  runnerCapture: () => Promise<CtrlProxyScreenshotResult>,
  hierarchy: XCTestHierarchy | null,
  expectedPanel: DisplayPanel | undefined,
): Promise<CtrlProxyScreenshotResult> {
  const result = await runnerCapture();
  if (!result.success) {
    return result;
  }
  const reference = runnerReference(hierarchy, expectedPanel);
  if (!reference) {
    logger.warn(`[SCREENSHOT] ${CAPTURE_UNVERIFIED_ERROR}`);
    return { success: false, error: CAPTURE_UNVERIFIED_ERROR, reason: "capture_unverified" };
  }
  const dimensions = result.data
    ? readImageHeaderDimensions(Buffer.from(result.data, "base64"))
    : null;
  if (!dimensions) {
    return result;
  }
  const expected = shortOverLong(reference.width, reference.height);
  const actual = shortOverLong(dimensions.width, dimensions.height);
  if (Math.abs(actual - expected) / expected <= RUNNER_ASPECT_TOLERANCE) {
    return result;
  }
  const error = `Runner screenshot is ${dimensions.width}x${dimensions.height} pixels but ${reference.label}; the capture is likely of an unlit panel. Re-run observe, or check the device posture with setPosture.`;
  logger.warn(`[SCREENSHOT] ${error}`);
  return { success: false, error };
}

/**
 * A Duo whose client never received a panel inventory: one live CoreDevice read picks the
 * single `active: true` display and captures it by name, so the cover panel's black frame is
 * not returned while the device is unfolded (#17583).
 */
async function captureDuoWithoutInventory(
  request: IosPanelScreenshotRequest,
): Promise<CtrlProxyScreenshotResult> {
  const deviceId = request.device.deviceId;
  const displays = await readLiveDisplays(request);
  const active = displays.filter((display) => display.active === true);
  const sizePx = active.length === 1 ? (active[0].nativeSize ?? active[0].bounds?.size) : undefined;
  if (!sizePx) {
    logger.warn(
      `[SCREENSHOT] iOS Duo ${deviceId} has no display inventory and live displays name no single active panel (${active.length} active of ${displays.length}); using runner capture`,
    );
    return request.runnerCapture();
  }
  const panel: DisplayPanel = {
    key: active[0].name ?? String(active[0].displayId),
    role: "unknown",
    sizePx,
  };
  logger.info(
    `[SCREENSHOT] iOS Duo ${deviceId} has no display inventory; capturing live active display ${panel.key} (${sizePx.width}x${sizePx.height})`,
  );
  return captureSelectedPanel({ ...request, deviceId, panel, panelCount: displays.length });
}

/**
 * Select a physical simulator panel, verifying its PNG before accepting it.
 * Order: CoreDevice per-panel capture, then simctl, then the runner. A single-display
 * simulator goes straight to the runner and never touches devicectl or simctl; a Duo with
 * no inventory reads its live displays instead. Every runner fallback here is aspect-checked,
 * and one with nothing to check against is a typed `capture_unverified` failure.
 */
export async function captureIosPanelScreenshotWith(
  input: IosPanelScreenshotRequest,
): Promise<CtrlProxyScreenshotResult> {
  if (!needsIosPanelSelection(input.device)) {
    return input.runnerCapture();
  }
  const expectedPanel = input.device.displays?.panels.find(
    (candidate) => candidate.key === input.activePanelKey,
  );
  const request: IosPanelScreenshotRequest = {
    ...input,
    runnerCapture: () =>
      aspectCheckedRunnerCapture(input.runnerCapture, input.hierarchy, expectedPanel),
  };
  const { device, hierarchy, activePanelKey } = request;
  const panels = device.displays?.panels ?? [];
  if (panels.length < 2) {
    return captureDuoWithoutInventory(request);
  }
  const display = observedIosDisplay(device, hierarchy ?? undefined);
  const panel =
    panels.find((candidate) => candidate.key === (activePanelKey ?? display.key)) ??
    (await readLiveScreenshotPanel(request, panels));
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
  {
    runnerCapture,
    signal,
    activePanelKey,
  }: Pick<IosPanelScreenshotRequest, "signal" | "activePanelKey"> & {
    runnerCapture: () => Promise<CtrlProxyScreenshotResult>;
  },
): Promise<CtrlProxyScreenshotResult> {
  return captureIosPanelScreenshotWith({
    device,
    hierarchy,
    simctl,
    devicectl: productionDevicectlPanelSource(),
    displayInfo: productionDevicectlPanelSource(),
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

/** Watch simulator observation: a retained simctl screenshot, plus a connected runner's hierarchy. */
import { ObserveElementsBuilder } from "../features/observe/ObserveElementsBuilder";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../models";
import type { WatchRunnerClient } from "../features/watch/WatchRunnerClient";
import { watchRunners } from "../features/watch/WatchRunnerRegistry";
import { normalizeWatchHierarchy } from "../features/watch/WatchHierarchy";
import path from "path";
import type { DisplayRef } from "../models/DisplayPanel";
import { ActionableError, toActionableError } from "../models/ActionableError";
import {
  WATCH_HIERARCHY_UNAVAILABLE_MESSAGE,
  type WatchObservation,
} from "../models/WatchObservation";
import { writeRetainedScreenshot } from "../features/observe/ScreenshotRetention";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "../features/observe/ScreenshotPathProtection";
import {
  defaultScreenshotFileWriter,
  type ScreenshotFileWriter,
} from "../features/observe/screenshot/ScreenshotFileWriter";
import { TakeScreenshot } from "../features/observe/TakeScreenshot";
import { SimCtlClient } from "../utils/ios-cmdline-tools/SimCtlClient";
import {
  detectImageMimeType,
  readImageHeaderDimensions,
} from "../utils/screenshot/imageHeaderDimensions";
import { screenshotFileName } from "../utils/screenshot/screenshotFormats";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { createObserveResponse, type ObserveResponse } from "./observeResponse";
import type { ObserveArgs } from "./observeTools";

/** Captures a watch simulator's screen as PNG bytes. */
export interface WatchScreenshotSource {
  capture(device: BootedDevice, display: string, signal?: AbortSignal): Promise<Buffer>;
}

/** `simctl io <udid> screenshot --display=<display>`, as the iOS simulator observer captures. */
export const simctlWatchScreenshotSource: WatchScreenshotSource = {
  capture: (device, display, signal) =>
    new SimCtlClient(device).screenshot(device.deviceId, display, signal),
};

export interface WatchObserveDependencies {
  screenshots?: WatchScreenshotSource;
  runner?: WatchRunnerClient;
  idGenerator?: IdGenerator;
  timer?: Timer;
  fileWriter?: ScreenshotFileWriter;
  pathProtection?: ScreenshotPathProtection;
  /** The retained screenshot directory; defaults to the shared observe screenshot cache. */
  cacheDir?: () => string;
}

/** The simctl display key the iOS simulator observer uses for a single-screen simulator. */
const SIMCTL_DEFAULT_DISPLAY = "main";
/** The stable single-panel display key observations report without a panel inventory. */
const SINGLE_PANEL_DISPLAY_KEY = "0";

type OptionCheck = readonly [name: string, isSet: (args: ObserveArgs) => boolean];

/** Options that need a view hierarchy, an Android/iOS pipeline or an encoder the watch lacks. */
const WATCH_UNSUPPORTED_OPTIONS: readonly OptionCheck[] = [
  ["waitFor", (args) => args.waitFor !== undefined],
  ["settled", (args) => args.settled !== undefined],
  ["raw", (args) => args.raw === true],
  ["includeExtras", (args) => args.includeExtras === true],
  ["project", (args) => args.project !== undefined],
  ["scope", (args) => args.scope !== undefined],
  ["layer", (args) => args.layer !== undefined],
  ["skipBackStack", (args) => args.skipBackStack === true],
  ["crop", (args) => args.crop !== undefined],
  ["screenshotOptions", (args) => args.screenshotOptions !== undefined],
  ['screenshot: "none"', (args) => args.screenshot === "none"],
];

function watchDisplay(device: BootedDevice): { ref: DisplayRef; captureKey: string } {
  const panel = device.displays?.panels[0];
  return {
    ref: {
      key: panel?.key ?? SINGLE_PANEL_DISPLAY_KEY,
      role: panel?.role ?? "unknown",
      posture: "unknown",
      generation: 0,
    },
    captureKey: panel?.key ?? SIMCTL_DEFAULT_DISPLAY,
  };
}

/** Throws an ActionableError naming every observe option a watch cannot honour. */
export function assertWatchObserveOptions(
  args: ObserveArgs,
  displayKey: string,
  hierarchyAvailable = false,
): void {
  const refused = WATCH_UNSUPPORTED_OPTIONS.filter(
    ([name, isSet]) => isSet(args) && !(hierarchyAvailable && name === "project"),
  ).map(([name]) => name);
  if (args.display !== undefined && args.display !== "active" && args.display !== displayKey) {
    refused.push(`display: "${args.display}"`);
  }
  if (refused.length > 0) {
    throw new ActionableError(
      (hierarchyAvailable
        ? "observe with the watchOS runner "
        : "observe on watchOS returns only a screenshot (the view hierarchy is not available yet) ") +
        `and does not support: ${refused.join(", ")}. Remove these options and observe again.`,
    );
  }
}

async function captureWatchPng(
  device: BootedDevice,
  display: string,
  source: WatchScreenshotSource,
  signal: AbortSignal | undefined,
): Promise<{ png: Buffer; width: number; height: number }> {
  let png: Buffer;
  try {
    png = await source.capture(device, display, signal);
  } catch (error) {
    throw toActionableError(
      error,
      `Failed to capture a screenshot of watch simulator ${device.deviceId} with simctl`,
    );
  }
  const size = detectImageMimeType(png) === "image/png" ? readImageHeaderDimensions(png) : null;
  if (!size) {
    throw new ActionableError(
      `simctl returned no readable PNG for watch simulator ${device.deviceId}; observe again.`,
    );
  }
  return { png, ...size };
}

/** Capture and retain a watch screenshot, adding hierarchy when a runner is connected. */
export async function observeWatch(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  dependencies: WatchObserveDependencies = {},
): Promise<ObserveResponse<WatchObservation | ObserveResult>> {
  const display = watchDisplay(device);
  const runner = dependencies.runner ?? watchRunners.get(device.deviceId);
  assertWatchObserveOptions(args, display.ref.key, runner !== undefined);
  const viewHierarchy = runner
    ? normalizeWatchHierarchy(await runner.hierarchy(signal))
    : undefined;
  const timer = dependencies.timer ?? defaultTimer;
  const idGenerator = dependencies.idGenerator ?? defaultIdGenerator;
  const protection = dependencies.pathProtection ?? screenshotPathProtection;
  const directory = (dependencies.cacheDir ?? (() => TakeScreenshot.getCacheDir()))();
  protection.start(directory);

  const observationId = idGenerator.next();
  const { png, width, height } = await captureWatchPng(
    device,
    display.captureKey,
    dependencies.screenshots ?? simctlWatchScreenshotSource,
    signal,
  );
  // A cancelled call must not leave a retained screenshot nobody will read.
  signal?.throwIfAborted();
  const capturedAt = timer.now();
  const screenshotPath = path.join(
    directory,
    screenshotFileName(capturedAt, device.deviceId, idGenerator.next(), "png"),
  );
  try {
    await writeRetainedScreenshot(screenshotPath, png, {
      pathProtection: protection,
      writer: dependencies.fileWriter ?? defaultScreenshotFileWriter,
    });
  } catch (error) {
    throw toActionableError(error, `Failed to store the watch simulator screenshot`);
  }
  const capture: Omit<WatchObservation, "hierarchyUnavailable"> = {
    observationId,
    deviceId: device.deviceId,
    display: display.ref,
    updatedAt: capturedAt,
    screenSize: { width, height, units: "physical-pixels" },
    screenshotPath,
    screenshotFormat: "png",
    screenshotMimeType: "image/png",
    screenshotImageSize: { width, height },
    screenshotOrientation: "native",
    screenshotSource: "fresh",
    screenshotCaptureSource: "device",
    screenshotCapturedAt: new Date(capturedAt).toISOString(),
  };
  return createObserveResponse(
    watchObservationPayload(capture, viewHierarchy),
    args.includeScreenshotImage,
    { signal, protection },
  );
}

function watchObservationPayload(
  capture: Omit<WatchObservation, "hierarchyUnavailable">,
  viewHierarchy?: ViewHierarchyResult,
): WatchObservation | ObserveResult {
  if (!viewHierarchy) {
    return {
      ...capture,
      hierarchyUnavailable: { platform: "watchos", message: WATCH_HIERARCHY_UNAVAILABLE_MESSAGE },
    };
  }
  return {
    ...capture,
    viewHierarchy,
    elements: new ObserveElementsBuilder().build(viewHierarchy, "ios"),
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    screenSize: {
      width: viewHierarchy.screenWidth!,
      height: viewHierarchy.screenHeight!,
      units: "points",
    },
  };
}

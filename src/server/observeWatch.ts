/**
 * Screenshot-only `observe` for Apple Watch and Apple TV simulators (#14910). The screen is captured with
 * `xcrun simctl io <udid> screenshot` and stored in the same retained screenshot cache as every
 * other observe capture. No CtrlProxy, hierarchy, element matching or observation resource runs:
 * the result carries the screenshot, the screen size read from the PNG header, and a
 * hierarchy-unavailable note, with every hierarchy-derived field absent rather than empty.
 */
import path from "path";
import type { BootedDevice } from "../models";
import type { DisplayRef } from "../models/DisplayPanel";
import { ActionableError, toActionableError } from "../models/ActionableError";
import {
  WATCH_HIERARCHY_UNAVAILABLE_MESSAGE,
  TVOS_HIERARCHY_UNAVAILABLE_MESSAGE,
  type AppleScreenshotOnlyPlatform,
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

/** Captures an Apple simulator's screen as PNG bytes. */
export interface WatchScreenshotSource {
  capture(device: BootedDevice, display?: string, signal?: AbortSignal): Promise<Buffer>;
}

/** Capture with an explicit display when supplied; tvOS uses simctl's default display. */
export const simctlWatchScreenshotSource: WatchScreenshotSource = {
  capture: (device, display, signal) =>
    new SimCtlClient(device).screenshot(device.deviceId, display, signal),
};

export interface WatchObserveDependencies {
  screenshots?: WatchScreenshotSource;
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

const HIERARCHY_UNAVAILABLE_MESSAGES: Record<AppleScreenshotOnlyPlatform, string> = {
  watchos: WATCH_HIERARCHY_UNAVAILABLE_MESSAGE,
  tvos: TVOS_HIERARCHY_UNAVAILABLE_MESSAGE,
};

type OptionCheck = readonly [name: string, isSet: (args: ObserveArgs) => boolean];

/** Options that need a view hierarchy, an Android/iOS pipeline or an encoder this path lacks. */
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

function watchDisplay(device: BootedDevice): { ref: DisplayRef; captureKey: string | undefined } {
  const panel = device.displays?.panels[0];
  return {
    ref: {
      key: panel?.key ?? SINGLE_PANEL_DISPLAY_KEY,
      role: panel?.role ?? "unknown",
      posture: "unknown",
      generation: 0,
    },
    captureKey: device.platform === "tvos" ? undefined : (panel?.key ?? SIMCTL_DEFAULT_DISPLAY),
  };
}

/** Throws an ActionableError naming every observe option a screenshot-only platform cannot honour. */
export function assertWatchObserveOptions(
  args: ObserveArgs,
  displayKey: string,
  platform: AppleScreenshotOnlyPlatform = "watchos",
): void {
  const refused = WATCH_UNSUPPORTED_OPTIONS.filter(([, isSet]) => isSet(args)).map(
    ([name]) => name,
  );
  if (args.display !== undefined && args.display !== "active" && args.display !== displayKey) {
    refused.push(`display: "${args.display}"`);
  }
  if (refused.length > 0) {
    throw new ActionableError(
      `observe on ${platform === "tvos" ? "tvOS" : "watchOS"} returns only a screenshot (the view hierarchy is not available yet) ` +
        `and does not support: ${refused.join(", ")}. Remove these options and observe again.`,
    );
  }
}

async function captureWatchPng(
  device: BootedDevice,
  display: string | undefined,
  source: WatchScreenshotSource,
  signal: AbortSignal | undefined,
): Promise<{ png: Buffer; width: number; height: number }> {
  let png: Buffer;
  try {
    png = await source.capture(device, display, signal);
  } catch (error) {
    throw toActionableError(
      error,
      `Failed to capture a screenshot of ${device.platform === "tvos" ? "tvOS" : "watch"} simulator ${device.deviceId} with simctl`,
    );
  }
  const size = detectImageMimeType(png) === "image/png" ? readImageHeaderDimensions(png) : null;
  if (!size) {
    throw new ActionableError(
      `simctl returned no readable PNG for ${device.platform === "tvos" ? "tvOS" : "watch"} simulator ${device.deviceId}; observe again.`,
    );
  }
  return { png, ...size };
}

/** Screenshot-only observe for an Apple Watch or Apple TV: capture, retain, and describe what is missing. */
export async function observeWatch(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  dependencies: WatchObserveDependencies = {},
): Promise<ObserveResponse<WatchObservation>> {
  const platform = device.platform === "tvos" ? "tvos" : "watchos";
  const display = watchDisplay(device);
  assertWatchObserveOptions(args, display.ref.key, platform);
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
    throw toActionableError(
      error,
      `Failed to store the ${platform === "tvos" ? "tvOS" : "watch"} simulator screenshot`,
    );
  }
  const observation: WatchObservation = {
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
    hierarchyUnavailable: {
      platform,
      message: HIERARCHY_UNAVAILABLE_MESSAGES[platform],
    },
  };
  return createObserveResponse(observation, args.includeScreenshotImage, { signal, protection });
}

export type TvosScreenshotSource = WatchScreenshotSource;
export type TvosObserveDependencies = WatchObserveDependencies;
export const simctlTvosScreenshotSource = simctlWatchScreenshotSource;
export const observeTvos = observeWatch;
export const assertTvosObserveOptions = (args: ObserveArgs, displayKey: string): void =>
  assertWatchObserveOptions(args, displayKey, "tvos");

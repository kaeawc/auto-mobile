/** Apple simulator observation: a retained screenshot, plus a connected watchOS or tvOS runner's hierarchy. */
import { findFocusedElement } from "../features/observe/HierarchyFocus";
import { normalizeTvosHierarchy } from "../features/tvos/TvosHierarchy";
import { tvosRunners } from "../features/tvos/TvosRunnerRegistry";
import { ObserveElementsBuilder } from "../features/observe/ObserveElementsBuilder";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../models";
import type { WatchRunnerClient } from "../features/watch/WatchRunnerClient";
import { WatchRunnerError } from "../features/watch/WatchRunnerError";
import { watchRunners } from "../features/watch/WatchRunnerRegistry";
import { normalizeWatchHierarchy } from "../features/watch/WatchHierarchy";
import path from "path";
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
import { logger } from "../utils/logger";
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

/** Throws an ActionableError naming every observe option this Apple simulator path cannot honour. */
export function assertWatchObserveOptions(
  args: ObserveArgs,
  displayKey: string,
  platform: AppleScreenshotOnlyPlatform = "watchos",
  hierarchyAvailable = false,
): void {
  const hasRunnerHierarchy = hierarchyAvailable;
  const refused = WATCH_UNSUPPORTED_OPTIONS.filter(
    ([name, isSet]) => isSet(args) && !(hasRunnerHierarchy && name === "project"),
  ).map(([name]) => name);
  if (args.display !== undefined && args.display !== "active" && args.display !== displayKey) {
    refused.push(`display: "${args.display}"`);
  }
  if (refused.length > 0) {
    throw new ActionableError(
      (hasRunnerHierarchy
        ? `observe with the ${platform === "tvos" ? "tvOS" : "watchOS"} runner `
        : `observe on ${platform === "tvos" ? "tvOS" : "watchOS"} returns only a screenshot (the view hierarchy is not available yet) `) +
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

async function watchHierarchyForObserve(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  injectedRunner?: WatchRunnerClient,
): Promise<ViewHierarchyResult | undefined> {
  const platform = device.platform === "tvos" ? "tvos" : "watchos";
  if (platform === "tvos") {
    const runner = tvosRunners.get(device.deviceId);
    assertWatchObserveOptions(args, watchDisplay(device).ref.key, platform, runner !== undefined);
    return runner ? normalizeTvosHierarchy(await runner.hierarchy(signal)) : undefined;
  }
  const runner =
    platform === "watchos" ? (injectedRunner ?? watchRunners.get(device.deviceId)) : undefined;
  assertWatchObserveOptions(args, watchDisplay(device).ref.key, platform, runner !== undefined);
  try {
    return runner ? normalizeWatchHierarchy(await runner.hierarchy(signal)) : undefined;
  } catch (error) {
    if (error instanceof WatchRunnerError && error.errorCode === "app_not_foreground") {
      // A backgrounded fixture has no runner-visible hierarchy; its screenshot is still useful.
      logger.debug("Watch runner app is not foreground; returning screenshot-only observation.");
      return undefined;
    }
    throw error;
  }
}

/** Capture an Apple simulator screenshot, adding hierarchy for a connected watchOS or tvOS runner. */
export async function observeWatch(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  dependencies: WatchObserveDependencies = {},
): Promise<ObserveResponse<WatchObservation | ObserveResult>> {
  const platform = device.platform === "tvos" ? "tvos" : "watchos";
  const display = watchDisplay(device);
  const viewHierarchy = await watchHierarchyForObserve(device, args, signal, dependencies.runner);
  const timer = dependencies.timer ?? defaultTimer;
  const idGenerator = dependencies.idGenerator ?? defaultIdGenerator;
  const protection = dependencies.pathProtection ?? screenshotPathProtection;
  const directory = (dependencies.cacheDir ?? (() => TakeScreenshot.getCacheDir()))();
  protection.start(directory);

  const observationId = idGenerator.next();
  const { png, width, height } = await captureWatchPng(
    device,
    display.captureKey,
    dependencies.screenshots ?? defaultWatchScreenshotSource(device),
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
    watchObservationPayload(capture, platform, viewHierarchy),
    args.includeScreenshotImage,
    { signal, protection },
  );
}

function watchObservationPayload(
  capture: Omit<WatchObservation, "hierarchyUnavailable">,
  platform: AppleScreenshotOnlyPlatform,
  viewHierarchy?: ViewHierarchyResult,
): WatchObservation | ObserveResult {
  if (!viewHierarchy) {
    return {
      ...capture,
      hierarchyUnavailable: { platform, message: HIERARCHY_UNAVAILABLE_MESSAGES[platform] },
    };
  }
  return {
    ...capture,
    viewHierarchy,
    ...(platform === "tvos"
      ? { focusedElement: findFocusedElement(viewHierarchy) ?? undefined }
      : {}),
    elements: new ObserveElementsBuilder().build(viewHierarchy, "ios"),
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    screenSize: {
      width: viewHierarchy.screenWidth!,
      height: viewHierarchy.screenHeight!,
      units: "points",
    },
  };
}

function defaultWatchScreenshotSource(device: BootedDevice): WatchScreenshotSource {
  return device.platform === "tvos" && tvosRunners.get(device.deviceId)
    ? runnerTvosScreenshotSource
    : simctlWatchScreenshotSource;
}

const runnerTvosScreenshotSource: WatchScreenshotSource = {
  capture: async (device, _display, signal) => {
    const data = await tvosRunners
      .require(device.deviceId)
      .request({ type: "request_screenshot" }, signal);
    if (typeof data !== "string") {
      throw new ActionableError("Invalid tvOS screenshot; reconnect the runner.");
    }
    return Buffer.from(data, "base64");
  },
};

export type TvosScreenshotSource = WatchScreenshotSource;
export type TvosObserveDependencies = WatchObserveDependencies;
export const simctlTvosScreenshotSource = simctlWatchScreenshotSource;
export const observeTvos = observeWatch;
export const assertTvosObserveOptions = (args: ObserveArgs, displayKey: string): void =>
  assertWatchObserveOptions(args, displayKey, "tvos");

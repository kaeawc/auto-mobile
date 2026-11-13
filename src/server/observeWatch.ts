import { normalizeVisionosHierarchy } from "../features/visionos/VisionosHierarchy";
import {
  requireVisionosRunner,
  withVisionosHostRecovery,
} from "../features/visionos/VisionosRunnerLifecycle";
import {
  visionosRunners,
  type VisionosRunnerRegistry,
} from "../features/visionos/VisionosRunnerRegistry";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { holderOf } from "../daemon/deviceBinding";
import { isSessionlessDeviceRead } from "../features/toolSelection/toolSelectionContext";
/** Apple simulator observation: a retained screenshot and platform-specific runner hierarchy. */
import { findFocusedElement } from "../features/observe/HierarchyFocus";
import { normalizeTvosHierarchy } from "../features/tvos/TvosHierarchy";
import { tvosRunners } from "../features/tvos/TvosRunnerRegistry";
import { requireTvosRunner } from "../features/tvos/TvosRunnerRecovery";
import {
  getTvosRunnerLifecycle,
  type TvosRunnerLifecycle,
} from "../features/tvos/TvosRunnerLifecycle";
import { captureTvosRunnerScreenshot } from "../features/tvos/TvosScreenshot";
import { ObserveElementsBuilder } from "../features/observe/ObserveElementsBuilder";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../models";
import type { WatchRunnerClient } from "../features/watch/WatchRunnerClient";
import type { VisionosRunnerClient } from "../features/visionos/VisionosRunnerClient";
import { WatchRunnerError } from "../features/watch/WatchRunnerError";
import { watchRunners } from "../features/watch/WatchRunnerRegistry";
import { normalizeWatchHierarchy } from "../features/watch/WatchHierarchy";
import { getWatchRunnerLifecycle } from "../features/watch/WatchRunnerLifecycle";
import {
  LaunchctlWatchTargetAppProbe,
  type WatchTargetAppProbe,
} from "../features/watch/WatchTargetAppProbe";
import path from "path";
import { NON_IOS_APPLE_PLATFORM_LABELS } from "../models/Platform";
import type { DisplayRef } from "../models/DisplayPanel";
import { ActionableError, toActionableError } from "../models/ActionableError";
import {
  WATCH_HIERARCHY_UNAVAILABLE_MESSAGE,
  WATCH_APP_NOT_FOREGROUND_MESSAGE,
  watchAppNotRunningMessage,
  TVOS_HIERARCHY_UNAVAILABLE_MESSAGE,
  TVOS_RUNNER_UNAVAILABLE_MESSAGE,
  VISIONOS_HIERARCHY_UNAVAILABLE_MESSAGE,
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
import { errorMessage } from "../utils/describeUnknownError";
import {
  createObserveResponse,
  createObserveWaitResponse,
  type ObserveResponse,
} from "./observeResponse";
import {
  assertAppleRunnerWaitFor,
  pollAppleRunnerWaitFor,
  type AppleRunnerWaitOutcome,
} from "./appleRunnerWaitFor";
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
  /** Recovers a disconnected lifecycle-owned tvOS runner; defaults to the shared lifecycle. */
  tvosRunnerLifecycle?: Pick<TvosRunnerLifecycle, "restartOwned" | "ownsRunner">;
  /** Starts or reuses the visionOS window-app runner; defaults to the shared runner lifecycle. */
  visionosRunner?: (deviceId: string, signal?: AbortSignal) => Promise<VisionosRunnerClient>;
  /** The window app each connected visionOS runner was started for; defaults to the shared registry. */
  visionosRunnerTargets?: Pick<VisionosRunnerRegistry, "targetBundleId">;
  /** Whether this call reads a device another session holds; defaults to the pool's holder. */
  heldDeviceRead?: (deviceId: string) => boolean;
  idGenerator?: IdGenerator;
  timer?: Timer;
  fileWriter?: ScreenshotFileWriter;
  pathProtection?: ScreenshotPathProtection;
  /** The retained screenshot directory; defaults to the shared observe screenshot cache. */
  cacheDir?: () => string;
  /** watchOS: whether the runner's target app still has a process; defaults to launchctl. */
  watchTargetApp?: WatchTargetAppProbe;
}

const defaultWatchTargetAppProbe: WatchTargetAppProbe = new LaunchctlWatchTargetAppProbe({
  targetBundleId: (deviceId) => getWatchRunnerLifecycle().targetBundleId(deviceId),
  simctl: (device) => new SimCtlClient(device),
});

/** The simctl display key the iOS simulator observer uses for a single-screen simulator. */
const SIMCTL_DEFAULT_DISPLAY = "main";
/** The stable single-panel display key observations report without a panel inventory. */
const SINGLE_PANEL_DISPLAY_KEY = "0";

const HIERARCHY_UNAVAILABLE_MESSAGES: Record<AppleScreenshotOnlyPlatform, string> = {
  watchos: WATCH_HIERARCHY_UNAVAILABLE_MESSAGE,
  tvos: TVOS_HIERARCHY_UNAVAILABLE_MESSAGE,
  visionos: VISIONOS_HIERARCHY_UNAVAILABLE_MESSAGE,
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

/** Options a runner hierarchy can honour: the full projection and element waits (#17309). */
const RUNNER_HIERARCHY_OPTIONS: ReadonlySet<string> = new Set(["project", "waitFor"]);

function screenshotOnlyPlatform(device: BootedDevice): AppleScreenshotOnlyPlatform {
  return device.platform === "tvos" || device.platform === "visionos" ? device.platform : "watchos";
}

function watchDisplay(device: BootedDevice): { ref: DisplayRef; captureKey: string | undefined } {
  const panel = device.displays?.panels[0];
  return {
    ref: {
      key: panel?.key ?? SINGLE_PANEL_DISPLAY_KEY,
      role: panel?.role ?? "unknown",
      posture: "unknown",
      generation: 0,
    },
    captureKey:
      screenshotOnlyPlatform(device) === "watchos"
        ? (panel?.key ?? SIMCTL_DEFAULT_DISPLAY)
        : undefined,
  };
}

/** What to pass instead of each refused option, or nothing when the option has no alternative here. */
function refusedOptionAlternatives(
  refused: readonly string[],
  displayKey: string,
  hasRunnerHierarchy: boolean,
): string[] {
  return refused.flatMap((name) => {
    if (name === 'screenshot: "none"') {
      return ['use screenshot: "settled" or "async" (every observe here returns a screenshot)'];
    }
    if (name === "raw" && hasRunnerHierarchy) {
      return ['omit raw and use project: "full" for every element'];
    }
    if (name.startsWith("display: ")) {
      return [`use display: "active" or "${displayKey}"`];
    }
    return [];
  });
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
    ([name, isSet]) => isSet(args) && !(hasRunnerHierarchy && RUNNER_HIERARCHY_OPTIONS.has(name)),
  ).map(([name]) => name);
  if (args.display !== undefined && args.display !== "active" && args.display !== displayKey) {
    refused.push(`display: "${args.display}"`);
  }
  if (refused.length > 0) {
    const label = NON_IOS_APPLE_PLATFORM_LABELS[platform];
    const alternatives = refusedOptionAlternatives(refused, displayKey, hasRunnerHierarchy);
    throw new ActionableError(
      (hasRunnerHierarchy
        ? `observe with the ${label} runner does not support: `
        : `observe on ${label} returns only a screenshot (the view hierarchy is not available yet) and does not support: `) +
        `${refused.join(", ")}.` +
        (alternatives.length > 0 ? ` Instead, ${alternatives.join("; ")}.` : "") +
        " Remove the unsupported options and observe again.",
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
      `Failed to capture a screenshot of ${device.platform === "watchos" ? "watch" : NON_IOS_APPLE_PLATFORM_LABELS[screenshotOnlyPlatform(device)]} simulator ${device.deviceId} with simctl`,
    );
  }
  const size = detectImageMimeType(png) === "image/png" ? readImageHeaderDimensions(png) : null;
  if (!size) {
    throw new ActionableError(
      `simctl returned no readable PNG for ${device.platform === "watchos" ? "watch" : NON_IOS_APPLE_PLATFORM_LABELS[screenshotOnlyPlatform(device)]} simulator ${device.deviceId}; observe again.`,
    );
  }
  return { png, ...size };
}

/** A runner hierarchy, or the reason this read carries only a screenshot. */
type HierarchyOutcome = {
  hierarchy?: ViewHierarchyResult;
  unavailableReason?: string;
  appNotForeground?: true;
  /** watchOS: the runner's target app, when it has no process (it exited or crashed). */
  appNotRunning?: string;
  /** visionOS: the window app the runner that returned `hierarchy` was started for. */
  hierarchyBundleId?: string;
};

async function visionosHierarchyForObserve(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  runner: {
    start: NonNullable<WatchObserveDependencies["visionosRunner"]>;
    /** A connect-only held read never restarts another session's runner. */
    recoverHostLoss: boolean;
    targets: Pick<VisionosRunnerRegistry, "targetBundleId">;
  },
): Promise<HierarchyOutcome> {
  const displayKey = watchDisplay(device).ref.key;
  // Refuse options neither path supports before paying for runner startup.
  assertWatchObserveOptions(args, displayKey, "visionos", true);
  let hierarchy;
  let client: VisionosRunnerClient | undefined;
  try {
    const read = async () => {
      client = await runner.start(device.deviceId, signal);
      return client.hierarchy(signal);
    };
    hierarchy = runner.recoverHostLoss
      ? await withVisionosHostRecovery(device.deviceId, signal, read)
      : await read();
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    const reason = errorMessage(error);
    logger.warn(
      `[VisionosRunner] observe on ${device.deviceId} could not retrieve the runner hierarchy: ${reason}`,
      error,
    );
    // Without a runner the hierarchy-only options (project) cannot be honoured either.
    assertWatchObserveOptions(args, displayKey, "visionos", false);
    return { unavailableReason: reason };
  }
  // The runner that answered, not the latest launchApp target: launching another app does not
  // restart a connected runner, so the two differ until the next runner (re)start.
  const hierarchyBundleId = client && runner.targets.targetBundleId(device.deviceId, client);
  return {
    hierarchy: normalizeVisionosHierarchy(hierarchy),
    ...(hierarchyBundleId ? { hierarchyBundleId } : {}),
  };
}

/** A sessionless deviceId read of a device some session holds (#10830): connect-only. */
function isReadOfHeldDevice(deviceId: string): boolean {
  if (!isSessionlessDeviceRead()) {
    return false;
  }
  const pool = defaultDaemonContext.devicePool();
  return pool ? !!holderOf(pool.getDevice(deviceId)) : false;
}

/** Reuses an already-connected runner; never starts xcodebuild, which would foreground an app. */
async function connectedVisionosRunner(deviceId: string): Promise<VisionosRunnerClient> {
  const runner = visionosRunners.get(deviceId);
  if (!runner?.isUsable()) {
    throw new ActionableError(
      `Device ${deviceId} is held by another session and has no connected visionOS runner; a deviceId read only connects to a running runner.`,
    );
  }
  return runner;
}

async function watchHierarchyForObserve(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  dependencies: WatchObserveDependencies,
): Promise<HierarchyOutcome> {
  if (screenshotOnlyPlatform(device) === "visionos") {
    const heldRead = (dependencies.heldDeviceRead ?? isReadOfHeldDevice)(device.deviceId);
    return visionosHierarchyForObserve(device, args, signal, {
      start:
        dependencies.visionosRunner ?? (heldRead ? connectedVisionosRunner : requireVisionosRunner),
      recoverHostLoss: !heldRead,
      targets: dependencies.visionosRunnerTargets ?? visionosRunners,
    });
  }
  if (screenshotOnlyPlatform(device) === "tvos") {
    return tvosHierarchyForObserve(device, args, signal, dependencies.tvosRunnerLifecycle);
  }
  return appleRunnerHierarchy(device, args, signal, dependencies.runner);
}

/**
 * Recovers a disconnected registered tvOS runner before reading its hierarchy. A failed recovery
 * or hierarchy read degrades observe to its screenshot with the reason (#17310).
 */
async function tvosHierarchyForObserve(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  injectedLifecycle?: Pick<TvosRunnerLifecycle, "restartOwned" | "ownsRunner">,
): Promise<HierarchyOutcome> {
  const displayKey = watchDisplay(device).ref.key;
  const lifecycle = injectedLifecycle ?? getTvosRunnerLifecycle();
  // An exited xcodebuild unregisters its client while the lifecycle keeps the ownership needed to
  // restart it; only a device that never owned or registered a runner stays screenshot-only.
  const hasRunner =
    tvosRunners.get(device.deviceId) !== undefined || lifecycle.ownsRunner(device.deviceId);
  assertWatchObserveOptions(args, displayKey, "tvos", hasRunner);
  if (!hasRunner) {
    return {};
  }
  try {
    const usableRunner = await requireTvosRunner(device.deviceId, signal, lifecycle);
    return { hierarchy: normalizeTvosHierarchy(await usableRunner.hierarchy(signal)) };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    const reason = errorMessage(error);
    logger.warn(
      `[TvosRunner] observe on ${device.deviceId} could not retrieve the runner hierarchy: ${reason}`,
      error,
    );
    // Without a hierarchy the hierarchy-only options (project, waitFor) cannot be honoured.
    assertWatchObserveOptions(args, displayKey, "tvos", false);
    return { unavailableReason: reason };
  }
}

async function appleRunnerHierarchy(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  injectedRunner?: WatchRunnerClient,
): Promise<HierarchyOutcome> {
  const platform = screenshotOnlyPlatform(device);
  const runner = injectedRunner ?? watchRunners.get(device.deviceId);
  assertWatchObserveOptions(args, watchDisplay(device).ref.key, platform, runner !== undefined);
  try {
    return runner ? { hierarchy: normalizeWatchHierarchy(await runner.hierarchy(signal)) } : {};
  } catch (error) {
    if (error instanceof WatchRunnerError && error.errorCode === "app_not_foreground") {
      // A backgrounded fixture has no runner-visible hierarchy; its screenshot is still useful.
      logger.debug("Watch runner app is not foreground; returning screenshot-only observation.");
      return { appNotForeground: true };
    }
    throw error;
  }
}

/** Capture an Apple simulator screenshot, adding the platform runner hierarchy. */
export async function observeWatch(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  dependencies: WatchObserveDependencies = {},
): Promise<ObserveResponse<WatchObservation | ObserveResult> & { isError?: true }> {
  const platform = screenshotOnlyPlatform(device);
  const display = watchDisplay(device);
  const timer = dependencies.timer ?? defaultTimer;
  const { waitOutcome, ...observed } = await observedHierarchy(device, args, signal, {
    ...dependencies,
    timer,
  });
  const hierarchyOutcome = await withWatchAppNotRunning(device, observed, signal, dependencies);
  const idGenerator = dependencies.idGenerator ?? defaultIdGenerator;
  const protection = dependencies.pathProtection ?? screenshotPathProtection;
  const directory = (dependencies.cacheDir ?? (() => TakeScreenshot.getCacheDir()))();
  protection.start(directory);

  const observationId = idGenerator.next();
  const { png, width, height } = await captureWatchPng(
    device,
    display.captureKey,
    dependencies.screenshots ??
      defaultWatchScreenshotSource(device, hierarchyOutcome.unavailableReason === undefined),
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
      `Failed to store the ${platform === "watchos" ? "watch" : NON_IOS_APPLE_PLATFORM_LABELS[platform]} simulator screenshot`,
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
  const payload = watchObservationPayload(capture, platform, hierarchyOutcome);
  return waitOutcome
    ? createObserveWaitResponse(payload, waitOutcome, args.includeScreenshotImage, {
        signal,
        protection,
      })
    : createObserveResponse(payload, args.includeScreenshotImage, { signal, protection });
}

/** True for a watch read with no target-app content: backgrounded, or an empty tree (#18052). */
function lacksTargetAppContent(outcome: HierarchyOutcome): boolean {
  if (outcome.appNotForeground) {
    return true;
  }
  if (!outcome.hierarchy) {
    return false;
  }
  const elements = new ObserveElementsBuilder().build(outcome.hierarchy, "ios");
  return (
    !elements ||
    (elements.clickable.length === 0 &&
      elements.scrollable.length === 0 &&
      elements.text.length === 0)
  );
}

/**
 * After a crash the runner reports the app as not foreground, or an empty tree. One process list
 * read tells an exited app apart, so observe can say it is not running (#18052).
 */
async function withWatchAppNotRunning(
  device: BootedDevice,
  outcome: HierarchyOutcome,
  signal: AbortSignal | undefined,
  dependencies: WatchObserveDependencies,
): Promise<HierarchyOutcome> {
  if (screenshotOnlyPlatform(device) !== "watchos" || !lacksTargetAppContent(outcome)) {
    return outcome;
  }
  const probe = dependencies.watchTargetApp ?? defaultWatchTargetAppProbe;
  const bundleId = await probe.notRunningTarget(device, signal);
  if (!bundleId) {
    return outcome;
  }
  // The tree, if any, is not the app's: report a screenshot-only read that names the exit.
  return { appNotRunning: bundleId };
}

/**
 * The runner hierarchy for this observe; with `waitFor`, the hierarchy of the poll that matched
 * (or the last one before the timeout) plus the wait metadata (#17309).
 */
async function observedHierarchy(
  device: BootedDevice,
  args: ObserveArgs,
  signal: AbortSignal | undefined,
  dependencies: WatchObserveDependencies & { timer: Timer },
): Promise<HierarchyOutcome & { waitOutcome?: AppleRunnerWaitOutcome }> {
  const first = await watchHierarchyForObserve(device, args, signal, dependencies);
  if (args.waitFor === undefined) {
    return first;
  }
  // assertWatchObserveOptions admitted waitFor, so a runner is connected.
  assertAppleRunnerWaitFor(args.waitFor, screenshotOnlyPlatform(device));
  let pending: HierarchyOutcome | undefined = first;
  let lastRead = first;
  const { hierarchy, outcome } = await pollAppleRunnerWaitFor(
    args.waitFor,
    async () => {
      lastRead = pending ?? (await watchHierarchyForObserve(device, args, signal, dependencies));
      pending = undefined;
      return lastRead.hierarchy;
    },
    { timer: dependencies.timer, signal },
  );
  return { ...lastRead, hierarchy, waitOutcome: outcome };
}

/** Why this read carries only a screenshot; `appNotRunning` is set only for watchOS (#18052). */
function hierarchyUnavailableNote(
  platform: AppleScreenshotOnlyPlatform,
  { unavailableReason, appNotForeground, appNotRunning }: HierarchyOutcome,
): WatchObservation["hierarchyUnavailable"] {
  if (platform === "watchos" && appNotRunning) {
    return {
      platform,
      message: watchAppNotRunningMessage(appNotRunning),
      appNotRunning: { bundleId: appNotRunning },
    };
  }
  const message =
    platform === "watchos" && appNotForeground
      ? WATCH_APP_NOT_FOREGROUND_MESSAGE
      : platform === "tvos" && unavailableReason
        ? TVOS_RUNNER_UNAVAILABLE_MESSAGE
        : HIERARCHY_UNAVAILABLE_MESSAGES[platform];
  return {
    platform,
    message: unavailableReason ? `${message} Runner unavailable: ${unavailableReason}` : message,
  };
}

function watchObservationPayload(
  capture: Omit<WatchObservation, "hierarchyUnavailable">,
  platform: AppleScreenshotOnlyPlatform,
  outcome: HierarchyOutcome,
): WatchObservation | ObserveResult {
  const { hierarchy: viewHierarchy, hierarchyBundleId } = outcome;
  if (!viewHierarchy) {
    return { ...capture, hierarchyUnavailable: hierarchyUnavailableNote(platform, outcome) };
  }
  return {
    ...capture,
    viewHierarchy,
    ...(hierarchyBundleId !== undefined ? { hierarchyBundleId } : {}),
    ...(platform === "tvos" || platform === "visionos"
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

/**
 * Re-reads the registry after hierarchy recovery to use the replacement tvOS runner's screenshot.
 * Uses simctl once the runner failed this observe so it cannot stall the screenshot-only fallback.
 */
export function defaultWatchScreenshotSource(
  device: BootedDevice,
  runnerAnswered = true,
): WatchScreenshotSource {
  return device.platform === "tvos" &&
    runnerAnswered &&
    tvosRunners.get(device.deviceId)?.isUsable() === true
    ? runnerTvosScreenshotSource
    : simctlWatchScreenshotSource;
}

const runnerTvosScreenshotSource: WatchScreenshotSource = {
  capture: (device, _display, signal) => captureTvosRunnerScreenshot(device, signal),
};

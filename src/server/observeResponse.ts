/**
 * Screenshot-capture and observe-response helpers for the `observe` tool (moved out of
 * observeTools.ts, #11828). The handler registration stays in observeTools.ts.
 */
import { publishScreenshotPaths } from "../features/observe/ScreenshotRetention";
import { iosAgentHidesPrototypeForCapture } from "../features/prototype/ios/iosCapturePrototypeHider";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "../features/observe/ScreenshotPathProtection";
import { errorMessage } from "../utils/describeUnknownError";
import { type ObserveScreenshotOptions } from "../features/observe/screenshot/screenshotOptions";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY } from "../features/observe/android/ctrlProxyProtocol";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../daemon/wire/constants";
import { assertAllDisplayObserveSupported } from "../features/observe/DisplaySelection";
import { type DeviceObservationAccess } from "./deviceObservationAccess";
import { ActionableError } from "../models/ActionableError";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import {
  snapshotReferences,
  type SnapshotReferenceStore,
} from "../features/observe/SnapshotReferenceStore";
import type { ObserveScreen } from "../features/observe/interfaces/ObserveScreen";
import { createStructuredToolResponse, StructuredToolResponse } from "../utils/toolUtils";
import {
  type AndroidOrIosPlatform,
  type Platform,
  BootedDevice,
  ObserveResult,
  ObserveToolPayload,
  requireAndroidOrIosPlatform,
} from "../models";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import {
  hasOwnPrototype,
  scopeHierarchyForSelector,
  scopeObserveResultToLayer,
} from "../features/observe/hierarchyLayer";
import type { HierarchyLayer } from "../models/HierarchyLayer";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { logger } from "../utils/logger";
import { type ScreenshotMode } from "../features/observe/automaticScreenshotPolicy";
import { inlineScreenshotImage } from "../features/observe/screenshot/inlineScreenshotImage";
import {
  createObserveCrop,
  type ObserveCropDependencies,
} from "../features/observe/screenshot/observeCrop";
import {
  applyObserveScopeExperiments,
  buildObserveScopeConfig,
} from "../features/observe/output/ObserveScopeExperiments";
import { type WaitForObservationOutcome } from "../features/observe/wait/WaitEvaluation";
import type { ObserveArgs } from "./observeTools";
import type { WatchObserveDependencies } from "./observeWatch";
import {
  defaultAudioInputDiagnostic,
  type AudioInputDiagnosticResolver,
} from "../utils/audio/audioInputDiagnostic";
import { assertActiveWindowWaitForSupportedOnPlatform } from "../features/observe/wait/WaitForSchemas";

export interface ObserveToolDependencies {
  snapshotReferences?: Pick<SnapshotReferenceStore, "capture">;
  crop?: ObserveCropDependencies;
  pathProtection?: ScreenshotPathProtection;
  timer?: Timer;
  createScreen?: (
    device: BootedDevice,
    display?: string,
  ) => Pick<
    RealObserveScreen,
    "execute" | "executeDeviceRead" | "appendRawViewHierarchy" | "getMostRecentCachedObserveResult"
  > &
    Pick<ObserveScreen, "captureScreenshot">;
  deviceReadAccess?: DeviceObservationAccess;
  /** Whether the device can hide its own prototype for a capture (#9305); defaults to CtrlProxy's. */
  hidesPrototypeForScreenshot?: (device: BootedDevice) => Promise<boolean>;
  /** Device-level audio input condition (#13627); defaults to the host probe and AVD inventory. */
  audioInputDiagnostic?: AudioInputDiagnosticResolver;
  /** Screenshot-only observe on an Apple Watch simulator (#14910); tests pass a fake capture. */
  watch?: WatchObserveDependencies;
}

/**
 * The served observe result with the device's environment conditions. A copy, so a cached
 * observation reused by later action tools never carries them; unchanged when there are none.
 */
export async function withDeviceDiagnostics(
  result: ObserveResult,
  device: BootedDevice,
  resolve: AudioInputDiagnosticResolver = defaultAudioInputDiagnostic,
): Promise<ObserveResult> {
  const diagnostic = await resolve(device);
  return diagnostic ? { ...result, diagnostics: [diagnostic] } : result;
}

/**
 * An Android CtrlProxy or a connected iOS prototype agent advertising `screenshot_hide_prototype_v1`
 * (#9305). The iOS agent hides itself around the host's simulator screenshot.
 */
async function ctrlProxyHidesPrototypeForScreenshot(device: BootedDevice): Promise<boolean> {
  if (device.platform === "ios") {
    return iosAgentHidesPrototypeForCapture(device.deviceId);
  }
  if (device.platform !== "android") {
    return false;
  }
  try {
    return await AndroidCtrlProxyClient.getInstance(device).supportsCommand(
      SCREENSHOT_HIDE_PROTOTYPE_CAPABILITY,
    );
  } catch (error) {
    // Unknown capability keeps today's capture, which observe reports as including the prototype.
    logger.debug(`[OBSERVE] Prototype-hiding capability unavailable: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * The screenshot options observe captures with: the caller's encoding, plus `hidePrototypes` for a
 * `layer: "app"` capture on a device that hides its prototype device-side in the one request (#9305).
 * Device reads never use CtrlProxy for the capture, so they keep the prototype.
 */
export async function observeScreenshotOptions(
  args: ObserveArgs,
  device: BootedDevice,
  deviceRead: boolean,
  screenshotMode: ScreenshotMode | undefined,
  dependencies: ObserveToolDependencies,
): Promise<ObserveScreenshotOptions | undefined> {
  if (args.layer !== "app" || deviceRead || screenshotMode === "none") {
    return args.screenshotOptions;
  }
  const hides = await (
    dependencies.hidesPrototypeForScreenshot ?? ctrlProxyHidesPrototypeForScreenshot
  )(device);
  return hides ? { ...args.screenshotOptions, hidePrototypes: true } : args.screenshotOptions;
}

export function screenForObserve(
  device: BootedDevice,
  args: ObserveArgs,
  dependencies: ObserveToolDependencies,
): ObserveScreen & Pick<RealObserveScreen, "appendRawViewHierarchy" | "executeDeviceRead"> {
  if (dependencies.createScreen) {
    return dependencies.createScreen(device, args.display);
  }
  return new RealObserveScreen(device, undefined, {
    display: args.display,
    deviceReadOnly: getToolSelectionContext()?.explicitObserveDeviceRead === true,
    onAvailabilityLost:
      device.platform === "android"
        ? (reason) => {
            if (args.sessionUuid) {
              defaultDaemonContext
                .sessionManager()
                ?.invalidateAutomationReadiness(args.sessionUuid, reason);
            }
          }
        : undefined,
  });
}

// Register tools (this will be called when this file is imported)
async function withCapturedScreenshotImage<T extends ObserveResponsePayload>(
  result: T,
  screenshotPath: string | undefined,
  options: { signal?: AbortSignal; protection?: ScreenshotPathProtection } = {},
): Promise<ObserveResponse<T>> {
  const delivery = await inlineScreenshotImage(screenshotPath, result, options.signal);
  await publishScreenshotPaths(result, options.protection);
  const response = createStructuredToolResponse({
    ...result,
    screenshotImage: delivery.screenshotImage,
  });
  return {
    ...response,
    content: delivery.image ? [...response.content, delivery.image] : response.content,
  };
}

/** The screenshot fields observe's response publishes; a watch observation carries only these. */
type ObserveResponsePayload = Pick<
  ObserveToolPayload,
  | "screenshotPath"
  | "screenshotExpiresAt"
  | "displays"
  | "crop"
  | "screenshotFormat"
  | "screenshotMimeType"
  | "screenshotImage"
>;

export type ObserveResponse<T = ObserveToolPayload> = Omit<StructuredToolResponse<T>, "content"> & {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
};

export async function createObserveResponse<T extends ObserveResponsePayload>(
  result: T,
  includeScreenshotImage: boolean | undefined,
  options: { signal?: AbortSignal; protection?: ScreenshotPathProtection } = {},
): Promise<ObserveResponse<T>> {
  const { signal, protection = screenshotPathProtection } = options;
  await publishScreenshotPaths(result, protection);
  const response = includeScreenshotImage
    ? await withCapturedScreenshotImage(result, result.screenshotPath, { signal, protection })
    : createStructuredToolResponse(result);
  await publishScreenshotPaths(result, protection, false);
  return response;
}

function requestedScreenshotMode(args: ObserveArgs): ScreenshotMode | undefined {
  if (args.crop && args.screenshot && args.screenshot !== "settled") {
    throw new ActionableError(
      "observe crop requires screenshot: 'settled' (or omit screenshot); async and none cannot provide a completed crop. No capture was started.",
    );
  }
  if (args.crop && args.display === "all") {
    throw new ActionableError(
      "observe crop requires one display; select a panel key, role, or active instead of all.",
    );
  }
  if (args.includeScreenshotImage && args.screenshot && args.screenshot !== "settled") {
    throw new ActionableError(
      "includeScreenshotImage requires screenshot: 'settled' (or omit screenshot). No capture was started.",
    );
  }
  return args.crop || args.includeScreenshotImage ? "settled" : args.screenshot;
}

export function attachSnapshotReference(
  deviceId: string,
  result: ObserveResult,
  references: Pick<SnapshotReferenceStore, "capture"> = snapshotReferences,
): void {
  const capture = references.capture(deviceId, result);
  if (capture.status === "captured") {
    result.snapshotReference = capture.reference;
    delete result.snapshotReferenceUnavailable;
  } else {
    result.snapshotReference = undefined;
    result.snapshotReferenceUnavailable = capture.missing;
  }
}

export function prepareObserveOptions(devicePlatform: Platform, args: ObserveArgs) {
  const platform = requireAndroidOrIosPlatform(devicePlatform, "observe");
  const deviceRead = getToolSelectionContext()?.explicitObserveDeviceRead === true;
  if (args.display === "all") {
    assertAllDisplayObserveSupported(platform, args);
  }
  if (deviceRead) {
    if (args.waitFor !== undefined) {
      throw new ActionableError(
        "waitFor is not available on deviceId reads; use a session observe (pass sessionUuid).",
      );
    }
    if (args.raw === true) {
      // collectRaw uses the owner's client and invalidates its shared cache;
      // project: "full" preserves the full filtered tree without that write.
      throw new ActionableError(
        'raw is not available on deviceId reads; use project: "full" for the full filtered hierarchy.',
      );
    }
    if (args.skipBackStack === true) {
      throw new ActionableError(
        "skipBackStack is not available on deviceId reads; use a session observe (pass sessionUuid) with waitFor.",
      );
    }
  }
  assertActiveWindowWaitForSupportedOnPlatform(platform, args.waitFor);
  const screenshot = requestedScreenshotMode(args);
  return {
    platform,
    deviceRead,
    aggregate: args.display === "all",
    timeoutMs: aggregateObserveTimeoutMs(args),
    screenshotMode: deviceRead ? (screenshot ?? "settled") : screenshot,
    encoding: args.screenshotOptions,
  };
}

/** Leave a short serialization window before the enclosing observe request expires. */
function aggregateObserveTimeoutMs(args: ObserveArgs): number | undefined {
  if (args.display !== "all") {
    return undefined;
  }
  const deadline = (args as Record<string, unknown>)[INTERNAL_MCP_REQUEST_DEADLINE_PARAM];
  return typeof deadline === "number" && Number.isFinite(deadline)
    ? Math.max(0, deadline - defaultTimer.now() - 100)
    : undefined;
}

export function createObserveWaitResponse(
  result: ObserveToolPayload,
  waitOutcome: WaitForObservationOutcome,
  includeScreenshotImage?: boolean,
  options: { signal?: AbortSignal; protection?: ScreenshotPathProtection } = {},
): Promise<ObserveResponse> | ObserveResponse {
  const waitMetadata: Omit<WaitForObservationOutcome, "observation"> = {
    awaitedElement: waitOutcome.awaitedElement,
    awaitDuration: waitOutcome.awaitDuration,
    awaitTimeout: waitOutcome.awaitTimeout,
    matched: waitOutcome.matched,
    settled: waitOutcome.settled,
    timedOut: waitOutcome.timedOut,
    polls: waitOutcome.polls,
    waitMs: waitOutcome.waitMs,
    matchedElement: waitOutcome.matchedElement,
    candidates: waitOutcome.candidates,
    ...(waitOutcome.containerFailure ? { containerFailure: waitOutcome.containerFailure } : {}),
  };
  return createObserveResponse(
    { ...result, ...waitMetadata, timeoutReason: waitOutcome.timeoutReason },
    includeScreenshotImage,
    options,
  );
}

export async function attachObserveCrop(
  args: ObserveArgs,
  result: ObserveResult,
  device: BootedDevice,
  dependencies?: ObserveCropDependencies,
): Promise<void> {
  if (!args.crop) {
    return;
  }
  // Full projections expose the scoped hierarchy itself, so resolve over that same
  // tree before raw append can replace it. The skeleton projection also applies
  // FOCUS/REGION, but only as a row filter over the unscoped tree, so skeleton
  // crops still resolve against the unscoped observation.
  const selectorObservation =
    args.project === "full" || (args.raw && args.project !== "skeleton")
      ? applyObserveScopeExperiments(
          result,
          buildObserveScopeConfig({ focus: true, overview: true, region: true }, args.scope),
        )
      : result;
  result.crop = await createObserveCrop(
    args.crop,
    { ...result, deviceId: device.deviceId },
    requireAndroidOrIosPlatform(device.platform, "Observe crop"),
    dependencies,
    selectorObservation,
  );
}

/**
 * The observation `observe` serves for `layer` (issue #9305). A plain observe
 * that asks for the prototype while none is showing is an actionable error; a
 * waitFor observe returns the (empty) scoped capture so its timeout reports the miss.
 */
export function layerScopedObserveResult(
  result: ObserveResult,
  layer: HierarchyLayer | undefined,
  platform: AndroidOrIosPlatform,
  requirePrototype: boolean,
): ObserveResult {
  if (layer === undefined) {
    return result;
  }
  if (requirePrototype && result.viewHierarchy) {
    scopeHierarchyForSelector(result.viewHierarchy, layer);
  }
  const { screenshotIncludesPrototype: capturedWithoutPrototype, ...scoped } =
    scopeObserveResultToLayer(result, layer, platform);
  // A capture taken with the prototype hidden device-side is marked false by the capture itself;
  // any other `layer: "app"` screenshot still shows the prototype, and observe says so.
  return layer === "app" && carriesScreenshot(result) && hasOwnPrototype(result.viewHierarchy)
    ? { ...scoped, screenshotIncludesPrototype: capturedWithoutPrototype !== false }
    : scoped;
}

/**
 * Whether the observation carries a screenshot or crop, so `observe` can say whether a
 * `layer: "app"` image shows the prototype instead of implying an app-only image (issue #9305).
 */
function carriesScreenshot(result: ObserveResult): boolean {
  return (
    result.screenshotCaptureAttempted === true ||
    result.screenshotPath !== undefined ||
    result.crop !== undefined
  );
}

export function recordObservationBackStack(result: ObserveResult, sessionUuid?: string): void {
  if (result.backStack && result.activeWindow?.appId) {
    const navGraph = sessionUuid
      ? NavigationGraphManager.getInstanceForSession(sessionUuid)
      : NavigationGraphManager.getInstance();
    // Only record if we have a current app and screen
    if (navGraph.getCurrentAppId() === result.activeWindow.appId && navGraph.getCurrentScreen()) {
      navGraph.recordBackStack(result.backStack).catch((error) => {
        logger.warn(`Failed to record observation back stack: ${errorMessage(error)}`, error);
      });
    }
  }
}

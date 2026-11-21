import type { ObserveResult } from "./ObserveResult";

/** Why an Apple Watch or Apple TV simulator observation carries no view hierarchy (#14910). */
export const WATCH_HIERARCHY_UNAVAILABLE_MESSAGE =
  "The view hierarchy is not available on watchOS yet: this observation carries only a " +
  "screenshot. viewHierarchy, skeleton, elements and the other element fields are absent, " +
  "not empty, so their absence does not mean the screen is empty. Read the screenshot instead.";

/** The watch runner is connected, but its target app is not in the foreground. */
export const WATCH_APP_NOT_FOREGROUND_MESSAGE =
  "The watch runner is connected, but the target app is not in the foreground (for example, " +
  "after a home press): this observation carries only a screenshot. Absent hierarchy fields " +
  "do not mean the screen is empty. Call launchApp to bring the app back, or post a notification " +
  "and retry observe: system alerts and notification looks are readable. Read the screenshot meanwhile.";

/** The runner's target app has no process: it exited or crashed (#18052). */
export function watchAppNotRunningMessage(bundleId: string): string {
  return (
    `The target app ${bundleId} is not running on the watch: it exited or crashed. ` +
    "This observation carries only a screenshot of what is on screen now, usually the watch face. " +
    "Absent hierarchy fields do not mean the app's screen is empty. Read getLogs for the crash and " +
    "call launchApp to start the app again."
  );
}

export type AppleScreenshotOnlyPlatform = "watchos" | "tvos" | "visionos";

export const TVOS_HIERARCHY_UNAVAILABLE_MESSAGE =
  "No tvOS runner is connected: this observation carries only a screenshot. " +
  "Call startDevice to prepare the runner for hierarchy and focus navigation " +
  '(provisionDevice with readiness "automation" starts it too). ' +
  "Absent hierarchy fields do not mean the screen is empty; read the screenshot instead.";

/** A tvOS runner is registered but did not return a hierarchy (stuck, disconnected or failed). */
export const TVOS_RUNNER_UNAVAILABLE_MESSAGE =
  "The tvOS runner did not return a view hierarchy: this observation carries only a screenshot. " +
  "Call startDevice to restart the runner for hierarchy and focus navigation. " +
  "Absent hierarchy fields do not mean the screen is empty; read the screenshot instead.";

export const VISIONOS_HIERARCHY_UNAVAILABLE_MESSAGE =
  "The visionOS window-app runner is unavailable: this observation carries only a screenshot. " +
  "The view hierarchy needs the runner. " +
  "Absent hierarchy fields do not mean the screen is empty; read the screenshot instead.";

export interface WatchHierarchyUnavailable<
  P extends AppleScreenshotOnlyPlatform = AppleScreenshotOnlyPlatform,
> {
  platform: P;
  message: string;
  /** watchOS: the runner's target app, present only when it has no process (#18052). */
  appNotRunning?: { bundleId: string };
}

/** Screenshot metadata shared by Apple simulator observations that have no hierarchy. */
export type ScreenshotOnlyObservation = Pick<
  ObserveResult,
  | "observationId"
  | "deviceId"
  | "display"
  | "updatedAt"
  | "screenSize"
  | "screenshotPath"
  | "screenshotExpiresAt"
  | "screenshotFormat"
  | "screenshotMimeType"
  | "screenshotImageSize"
  | "screenshotOrientation"
  | "screenshotSource"
  | "screenshotCaptureSource"
  | "screenshotFallback"
  | "screenshotFallbackReason"
  | "screenshotStageDurationsMs"
  | "screenshotCapturedAt"
  | "screenshotImage"
>;

export type WatchObservation<P extends AppleScreenshotOnlyPlatform = AppleScreenshotOnlyPlatform> =
  ScreenshotOnlyObservation & { hierarchyUnavailable: WatchHierarchyUnavailable<P> };

export type CarPlayObservation = ScreenshotOnlyObservation & {
  hierarchyUnavailable: { platform: "ios"; message: string };
};

/** A screenshot-only watchOS, tvOS or visionOS observation. */
export function isWatchObservation(value: unknown): value is WatchObservation {
  const platform = hierarchyUnavailablePlatform(value);
  return platform === "watchos" || platform === "tvos" || platform === "visionos";
}

/** These observations bypass the renderer's hierarchy projection and diffing. */
export function isScreenshotOnlyAppleObservation(value: unknown): boolean {
  return isWatchObservation(value) || hierarchyUnavailablePlatform(value) === "ios";
}

function hierarchyUnavailablePlatform(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("hierarchyUnavailable" in value)) {
    return undefined;
  }
  const note: unknown = value.hierarchyUnavailable;
  return typeof note === "object" && note !== null && "platform" in note
    ? note.platform
    : undefined;
}

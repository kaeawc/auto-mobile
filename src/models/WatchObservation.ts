import type { ObserveResult } from "./ObserveResult";

/** Why an Apple Watch or Apple TV simulator observation carries no view hierarchy (#14910). */
export const WATCH_HIERARCHY_UNAVAILABLE_MESSAGE =
  "The view hierarchy is not available on watchOS yet: this observation carries only a " +
  "screenshot. viewHierarchy, skeleton, elements and the other element fields are absent, " +
  "not empty, so their absence does not mean the screen is empty. Read the screenshot instead.";

export type AppleScreenshotOnlyPlatform = "watchos" | "tvos";

export const TVOS_HIERARCHY_UNAVAILABLE_MESSAGE =
  "No tvOS runner is connected: this observation carries only a screenshot. " +
  "Call startDevice to prepare the runner for hierarchy and focus navigation. " +
  "Absent hierarchy fields do not mean the screen is empty; read the screenshot instead.";

export interface WatchHierarchyUnavailable<
  P extends AppleScreenshotOnlyPlatform = AppleScreenshotOnlyPlatform,
> {
  platform: P;
  message: string;
}

/**
 * The `observe` result for an Apple Watch or Apple TV simulator: a simctl screenshot with its screen size and
 * an explicit hierarchy-unavailable note. Every hierarchy-derived field is absent by type.
 */
export type WatchObservation<P extends AppleScreenshotOnlyPlatform = AppleScreenshotOnlyPlatform> =
  Pick<
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
    | "screenshotCapturedAt"
    | "screenshotImage"
  > & { hierarchyUnavailable: WatchHierarchyUnavailable<P> };

/** A screenshot-only Apple simulator observation, which the observe renderer must not project or diff. */
export function isWatchObservation(value: unknown): value is WatchObservation {
  if (!value || typeof value !== "object" || !("hierarchyUnavailable" in value)) {
    return false;
  }
  const note: unknown = value.hierarchyUnavailable;
  return (
    typeof note === "object" &&
    note !== null &&
    "platform" in note &&
    (note.platform === "watchos" || note.platform === "tvos")
  );
}

export type TvosObservation = WatchObservation<"tvos">;
export type TvosHierarchyUnavailable = WatchHierarchyUnavailable<"tvos">;

export function isTvosObservation(value: unknown): value is TvosObservation {
  return isWatchObservation(value) && value.hierarchyUnavailable.platform === "tvos";
}

import type { ObserveResult } from "./ObserveResult";

/** Why an Apple Watch simulator observation carries no view hierarchy (#14910). */
export const WATCH_HIERARCHY_UNAVAILABLE_MESSAGE =
  "The view hierarchy is not available on watchOS yet: this observation carries only a " +
  "screenshot. viewHierarchy, skeleton, elements and the other element fields are absent, " +
  "not empty, so their absence does not mean the screen is empty. Read the screenshot instead.";

export interface WatchHierarchyUnavailable {
  platform: "watchos";
  message: string;
}

/**
 * The `observe` result for an Apple Watch simulator: a simctl screenshot with its screen size and
 * an explicit hierarchy-unavailable note. Every hierarchy-derived field is absent by type.
 */
export type WatchObservation = Pick<
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
> & { hierarchyUnavailable: WatchHierarchyUnavailable };

/** A screenshot-only watch observation, which the observe renderer must not project or diff. */
export function isWatchObservation(value: unknown): value is WatchObservation {
  if (!value || typeof value !== "object" || !("hierarchyUnavailable" in value)) {
    return false;
  }
  const note: unknown = value.hierarchyUnavailable;
  return (
    typeof note === "object" && note !== null && "platform" in note && note.platform === "watchos"
  );
}

import type { ElementSearchCriteria } from "../../../vision/VisionTypes";
import type { SwipeOnResolvedOptions } from "./types";

/** Debug-context search criteria for a legacy swipe that targeted an element or container. */
export function legacyDebugSearchCriteria(normalizedOptions: SwipeOnResolvedOptions) {
  return {
    text: normalizedOptions.lookFor?.text,
    resourceId: normalizedOptions.lookFor?.elementId || normalizedOptions.container?.elementId,
    container: normalizedOptions.container,
  };
}

/** Vision-fallback search criteria for a failed legacy swipe, or null when vision is off. */
export function legacyVisionSearchCriteria(
  visionEnabled: boolean,
  normalizedOptions: SwipeOnResolvedOptions,
): ElementSearchCriteria | null {
  if (!visionEnabled) {
    return null;
  }
  if (normalizedOptions.lookFor) {
    return {
      text: normalizedOptions.lookFor.text,
      resourceId: normalizedOptions.lookFor.elementId,
      description: "Target element to scroll to",
    };
  }
  if (normalizedOptions.container) {
    return {
      text: normalizedOptions.container.text,
      resourceId: normalizedOptions.container.elementId,
      description: "Container element for swiping",
    };
  }
  return null;
}

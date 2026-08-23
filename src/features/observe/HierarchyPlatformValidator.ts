import type { ObserveResult, ViewHierarchyResult } from "../../models";
import { logger } from "../../utils/logger";

export interface HierarchyPlatformValidation {
  valid: boolean;
  error?: string;
}

export interface HierarchyPlatformValidator {
  validate(
    platform: "android" | "ios",
    viewHierarchy: ViewHierarchyResult,
  ): HierarchyPlatformValidation;
}

function isFromIos(viewHierarchy: ViewHierarchyResult): boolean {
  if (viewHierarchy.screenScale !== undefined) {
    return true;
  }

  const h = viewHierarchy.hierarchy as Record<string, unknown>;
  if (h.type === "XCUIElementTypeApplication") {
    return true;
  }
  if (h.elementType === "application") {
    return true;
  }
  if (typeof h.bundleId === "string" && !viewHierarchy.hierarchy.node) {
    return true;
  }

  return false;
}

function isFromAndroid(viewHierarchy: ViewHierarchyResult): boolean {
  if (viewHierarchy.density !== undefined) {
    return true;
  }
  if (viewHierarchy.sdkInt !== undefined) {
    return true;
  }
  if (viewHierarchy.foregroundActivity !== undefined) {
    return true;
  }
  if (viewHierarchy.hierarchy.node?.$?.class?.startsWith("android.")) {
    return true;
  }

  return false;
}

export class RealHierarchyPlatformValidator implements HierarchyPlatformValidator {
  validate(
    platform: "android" | "ios",
    viewHierarchy: ViewHierarchyResult,
  ): HierarchyPlatformValidation {
    const ios = isFromIos(viewHierarchy);
    const android = isFromAndroid(viewHierarchy);

    if (platform === "android" && ios && !android) {
      return {
        valid: false,
        error:
          "Platform mismatch detected: received iOS hierarchy for Android device. " +
          "This may indicate a stale connection. Try calling observe again.",
      };
    }

    if (platform === "ios" && android && !ios) {
      return {
        valid: false,
        error:
          "Platform mismatch detected: received Android hierarchy for iOS device. " +
          "This may indicate a stale connection. Try calling observe again.",
      };
    }

    return { valid: true };
  }
}

/**
 * Clears every field on an observe result that is derived from the view
 * hierarchy. Used when the hierarchy is rejected as cross-platform so that no
 * consumer — the tool response, the observe cache, the LATEST_OBSERVATION
 * resource, or the navigation graph recorder — can act on stale data from the
 * other platform.
 *
 * Screen metrics (screenSize/systemInsets/rotation/wakefulness) are reset to the
 * base-result defaults because collectAllData() copies them from the hierarchy
 * (e.g. the iOS logical screen size) before this scrubber runs; leaving them
 * would mislead clients that scale tap coordinates against screenSize.
 *
 * Genuinely device-derived fields (backStack, accessibilityState) come from
 * direct device queries rather than the rejected hierarchy and are left intact.
 *
 * Note: if you add a new hierarchy-derived field to ObserveResult, clear it here.
 */
export function discardHierarchyDerivedData(result: ObserveResult): void {
  result.viewHierarchy = undefined;
  result.elements = undefined;
  result.selectedElements = undefined;
  result.focusedElement = undefined;
  result.accessibilityFocusedElement = undefined;
  result.intentChooserDetected = undefined;
  result.notificationPermissionDetected = undefined;
  result.predictions = undefined;
  result.activeWindow = undefined;
  result.screenIdentity = undefined;

  // Screen metrics copied from the rejected hierarchy — reset to base defaults.
  result.screenSize = { width: 0, height: 0 };
  result.systemInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  result.insets = { available: false, source: "unavailable", units: "unknown" };
  result.layoutWarnings = undefined;
  result.rotation = undefined;
  result.wakefulness = undefined;
}

/**
 * Rejects a cross-platform hierarchy in place. When the observation carries a
 * hierarchy from the other platform it is discarded along with every
 * hierarchy-derived field, and the validation error is attached.
 *
 * Returns true when the hierarchy was valid (left untouched), false when it was
 * rejected and the result scrubbed.
 */
export function enforceHierarchyPlatform(
  result: ObserveResult,
  platform: "android" | "ios",
  deviceId: string,
  validator: HierarchyPlatformValidator,
): boolean {
  if (!result.viewHierarchy?.hierarchy) {
    return true;
  }

  const validation = validator.validate(platform, result.viewHierarchy);
  if (validation.valid) {
    return true;
  }

  logger.error(
    `[observe] Platform mismatch: device ${deviceId} is ${platform} but received hierarchy from other platform. ` +
      `Discarding stale data to prevent cross-platform contamination.`,
  );
  discardHierarchyDerivedData(result);
  result.error = validation.error;
  return false;
}

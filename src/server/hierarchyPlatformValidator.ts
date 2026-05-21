import type { ViewHierarchyResult } from "../models";

export interface HierarchyPlatformValidation {
  valid: boolean;
  error?: string;
}

export interface HierarchyPlatformValidator {
  validate(platform: "android" | "ios", viewHierarchy: ViewHierarchyResult): HierarchyPlatformValidation;
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
  validate(platform: "android" | "ios", viewHierarchy: ViewHierarchyResult): HierarchyPlatformValidation {
    const ios = isFromIos(viewHierarchy);
    const android = isFromAndroid(viewHierarchy);

    if (platform === "android" && ios && !android) {
      return {
        valid: false,
        error: "Platform mismatch detected: received iOS hierarchy for Android device. " +
          "This may indicate a stale connection. Try calling observe again.",
      };
    }

    if (platform === "ios" && android && !ios) {
      return {
        valid: false,
        error: "Platform mismatch detected: received Android hierarchy for iOS device. " +
          "This may indicate a stale connection. Try calling observe again.",
      };
    }

    return { valid: true };
  }
}

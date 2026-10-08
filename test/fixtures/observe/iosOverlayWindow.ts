import capture from "../observe-output/ios-overlay-window/ios-floating-overlay-over-settings.raw.json";
import type { XCTestHierarchy } from "../../../src/features/observe/ios/types";

/**
 * Captured XCUITest hierarchy of Settings with an in-app overlay UIWindow above it; see the README
 * beside the capture. Returns a fresh parse so callers may derive variants freely.
 */
export function iosFloatingOverlayOverSettings(): XCTestHierarchy {
  return JSON.parse(capture.rawViewHierarchy.xcuitest) as XCTestHierarchy;
}

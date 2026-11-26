import visibleCapture from "../observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json";
import minimizedCapture from "../observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json";
import seDockedCapture from "../observe-output/ios-keyboard-states/ios-keyboard-docked-iphone-se.raw.json";
import seOneHandedCapture from "../observe-output/ios-keyboard-states/ios-keyboard-one-handed-iphone-se.raw.json";
import landscapeCapture from "../observe-output/ios-keyboard-states/ios-keyboard-docked-landscape-iphone-17-pro.raw.json";
import type { ViewHierarchyResult } from "../../../src/models";
import { viewHierarchyResultSchema } from "../../../src/server/toolOutputSchemas";

function assertCapturedHierarchy(value: unknown): asserts value is ViewHierarchyResult {
  // Validate the wire shape once; preserve the complete, unmodified parsed capture.
  viewHierarchyResultSchema.required({ hierarchy: true }).parse(value);
}

const visibleHierarchy: unknown = visibleCapture.viewHierarchy;
const minimizedHierarchy: unknown = minimizedCapture.viewHierarchy;
assertCapturedHierarchy(visibleHierarchy);
assertCapturedHierarchy(minimizedHierarchy);

// Shared read-only fixtures. Clone only when deriving a variant that changes a node.
export const iosKeyboardVisibleHierarchy: ViewHierarchyResult = visibleHierarchy;
export const iosKeyboardMinimizedHierarchy: ViewHierarchyResult = minimizedHierarchy;

// Issue #19362: iOS 27.2 captures with no safe-area insets (no embedded SDK).
const seDockedHierarchy: unknown = seDockedCapture.viewHierarchy;
const seOneHandedHierarchy: unknown = seOneHandedCapture.viewHierarchy;
const landscapeHierarchy: unknown = landscapeCapture.viewHierarchy;
assertCapturedHierarchy(seDockedHierarchy);
assertCapturedHierarchy(seOneHandedHierarchy);
assertCapturedHierarchy(landscapeHierarchy);
export const iosKeyboardDockedSeHierarchy: ViewHierarchyResult = seDockedHierarchy;
export const iosKeyboardOneHandedSeHierarchy: ViewHierarchyResult = seOneHandedHierarchy;
export const iosKeyboardDockedLandscapeHierarchy: ViewHierarchyResult = landscapeHierarchy;

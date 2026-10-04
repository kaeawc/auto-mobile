import visibleCapture from "../observe-output/ios-keyboard-states/ios-keyboard-visible.raw.json";
import minimizedCapture from "../observe-output/ios-keyboard-states/ios-keyboard-minimized.raw.json";
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

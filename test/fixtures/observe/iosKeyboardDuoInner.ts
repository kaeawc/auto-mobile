import capture from "../observe-output/ios-keyboard-duo-inner/ios-keyboard-visible.raw.json";
import type { ViewHierarchyResult } from "../../../src/models";
import { viewHierarchyResultSchema } from "../../../src/server/toolOutputSchemas";

const hierarchy: unknown = capture.viewHierarchy;
viewHierarchyResultSchema.required({ hierarchy: true }).parse(hierarchy);

/** Shared read-only capture of the Duo inner display with the docked keyboard (#18248). */
export const duoInnerKeyboardCapture: { viewHierarchy: ViewHierarchyResult } = {
  viewHierarchy: hierarchy as ViewHierarchyResult,
};

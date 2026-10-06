import capture from "../../fixtures/observe/android-test-tag.json";
import type { ViewHierarchyResult } from "../../../src/models";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";

// Existing capture: two buttons carrying the same test tag at different bounds.
export const testTagHierarchy: ViewHierarchyResult = capture.viewHierarchy;
export const testTagRows = new SearchableHierarchy()
  .project(testTagHierarchy)
  .flatMap((node) => (node.element?.["test-tag"] ? [node.element] : []));

const [firstNode, secondNode] = capture.viewHierarchy.hierarchy.node;

/** The capture after the first row left the screen: only the second row remains. */
export const testTagHierarchyWithoutFirstRow: ViewHierarchyResult = {
  hierarchy: { node: [secondNode!] },
};

/** The capture after the first row scrolled to the second row's bounds. */
export const testTagHierarchyWithFirstRowMoved: ViewHierarchyResult = {
  hierarchy: { node: [{ ...firstNode!, bounds: secondNode!.bounds }] },
};

import capture from "../../fixtures/observe/android-test-tag.json";
import type { ViewHierarchyResult } from "../../../src/models";
import { viewHierarchyFromFixture } from "../../helpers/observeFixture";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";

// Existing capture: two buttons carrying the same test tag at different bounds.
export const testTagHierarchy: ViewHierarchyResult = viewHierarchyFromFixture(
  capture.viewHierarchy,
  "test-tag capture",
);
export const testTagRows = new SearchableHierarchy()
  .project(testTagHierarchy)
  .flatMap((node) => (node.element?.["test-tag"] ? [node.element] : []));

const [firstNode, secondNode] = capture.viewHierarchy.hierarchy.node;

/** The capture after the first row left the screen: only the second row remains. */
export const testTagHierarchyWithoutFirstRow: ViewHierarchyResult = {
  hierarchy: { node: { node: [secondNode!] } },
};

/** The capture after the first row scrolled to the second row's bounds. */
export const testTagHierarchyWithFirstRowMoved: ViewHierarchyResult = {
  hierarchy: { node: { node: [{ ...firstNode!, bounds: secondNode!.bounds }] } },
};

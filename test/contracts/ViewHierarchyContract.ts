import { describe, expect, test } from "bun:test";
import type { ViewHierarchy } from "../../src/features/observe/interfaces/ViewHierarchy";

const node = (text: string, top: number, extra: Record<string, unknown> = {}) => ({
  text,
  bounds: { left: 0, top, right: 100, bottom: top + 50 },
  ...extra,
});

/**
 * Shared contract for the pure analysis half of every {@link ViewHierarchy}: finding the
 * input-focused and TalkBack-focused elements of a hierarchy and trimming offscreen nodes.
 * Run against the real ViewHierarchy and FakeViewHierarchy so the fake keeps answering from
 * the hierarchy it is handed instead of a canned value (issue #11868). Reads that need a
 * device (getViewHierarchy, recomposition tracking) are outside the contract.
 */
export const runViewHierarchyContract = (
  description: string,
  make: () => { hierarchy: ViewHierarchy },
): void => {
  describe(`ViewHierarchy contract: ${description}`, function () {
    test("finds the first focused node, depth first, and marks it focused", function () {
      const { hierarchy } = make();
      const tree = {
        hierarchy: {
          node: [
            node("Title", 0, { focused: "false" }),
            { ...node("Group", 60), node: [node("Field", 120, { focused: "true" })] },
            node("Later", 200, { focused: "true" }),
          ],
        },
      };

      const focused = hierarchy.findFocusedElement(tree);

      expect(focused?.text).toBe("Field");
      expect(focused?.focused).toBe(true);
    });

    test("finds no focused element when nothing is focused or the hierarchy is empty", function () {
      const { hierarchy } = make();
      const unfocused = { hierarchy: { node: [node("A", 0, { focused: "false" })] } };

      expect(hierarchy.findFocusedElement(unfocused)).toBeNull();
      expect(hierarchy.findFocusedElement({})).toBeNull();
      expect(hierarchy.findFocusedElement(null)).toBeNull();
    });

    test("prefers the top-level accessibility-focused element over a traversed one", function () {
      const { hierarchy } = make();
      const tree = {
        "accessibility-focused-element": node("Cursor", 300),
        hierarchy: { node: [node("Traversed", 0, { "accessibility-focused": "true" })] },
      };

      const focused = hierarchy.findAccessibilityFocusedElement(tree);

      expect(focused?.text).toBe("Cursor");
      expect(focused?.["accessibility-focused"]).toBe(true);
    });

    test("falls back to traversing for the accessibility-focused node", function () {
      const { hierarchy } = make();
      const tree = {
        hierarchy: {
          node: [node("A", 0), node("Traversed", 60, { "accessibility-focused": "true" })],
        },
      };

      expect(hierarchy.findAccessibilityFocusedElement(tree)?.text).toBe("Traversed");
      expect(
        hierarchy.findAccessibilityFocusedElement({ hierarchy: { node: [node("A", 0)] } }),
      ).toBeNull();
      expect(hierarchy.findAccessibilityFocusedElement(null)).toBeNull();
    });

    test("drops nodes far below the screen and keeps visible ones", function () {
      const { hierarchy } = make();
      const tree = { hierarchy: { node: [node("Visible", 100), node("Far below", 5000)] } };

      const filtered = hierarchy.filterOffscreenNodes(tree, 1080, 1920);

      const texts = JSON.stringify(filtered);
      expect(texts).toContain("Visible");
      expect(texts).not.toContain("Far below");
    });

    test("returns the hierarchy untouched when the screen size is unusable or it is empty", function () {
      const { hierarchy } = make();
      const tree = { hierarchy: { node: [node("Far below", 5000)] } };

      expect(hierarchy.filterOffscreenNodes(tree, 0, 0)).toBe(tree);
      expect(hierarchy.filterOffscreenNodes(null, 1080, 1920)).toBeNull();
    });
  });
};

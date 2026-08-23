import { describe, expect, test } from "bun:test";
import { AutoTargetSelector } from "../../../../src/features/action/swipeon/AutoTargetSelector";
import type { Element, ElementBounds } from "../../../../src/models";

// Direct unit tests for the AutoTargetSelector primitives. The SwipeOn autoTarget
// suite already covers three selectAutoTargetScrollable rows end-to-end; these
// exercise the geometry, container-description and warning-merge branches directly.
describe("AutoTargetSelector", () => {
  const selector = new AutoTargetSelector();

  const elementWithBounds = (bounds: ElementBounds): Element => ({ bounds }) as Element;

  describe("selectAutoTargetScrollable", () => {
    test("returns null when there are no scrollables", () => {
      expect(selector.selectAutoTargetScrollable([], null, "up")).toBeNull();
    });

    test("returns the single scrollable when it matches the requested axis", () => {
      const tall = elementWithBounds({ left: 0, top: 0, right: 100, bottom: 500 });
      expect(selector.selectAutoTargetScrollable([tall], null, "up")).toBe(tall);
    });

    test("returns null when the single scrollable is on the wrong axis", () => {
      const wide = elementWithBounds({ left: 0, top: 0, right: 500, bottom: 100 });
      expect(selector.selectAutoTargetScrollable([wide], null, "up")).toBeNull();
    });

    test("excludes the full-screen scroller and picks the largest remaining", () => {
      const screenBounds: ElementBounds = { left: 0, top: 0, right: 1000, bottom: 2000 };
      const fullScreen = elementWithBounds({ ...screenBounds });
      const small = elementWithBounds({ left: 0, top: 100, right: 400, bottom: 600 });
      const large = elementWithBounds({ left: 0, top: 100, right: 900, bottom: 1500 });

      const result = selector.selectAutoTargetScrollable(
        [fullScreen, small, large],
        screenBounds,
        "up",
      );
      expect(result).toBe(large);
    });

    test("falls back to the full-screen scrollers when all match screen bounds", () => {
      const screenBounds: ElementBounds = { left: 0, top: 0, right: 1000, bottom: 2000 };
      const a = elementWithBounds({ ...screenBounds });
      const b = elementWithBounds({ ...screenBounds });

      const result = selector.selectAutoTargetScrollable([a, b], screenBounds, "up");
      expect(result).toBe(a);
    });

    test("picks the largest scrollable when no screen bounds are known", () => {
      const small = elementWithBounds({ left: 0, top: 0, right: 100, bottom: 100 });
      const large = elementWithBounds({ left: 0, top: 0, right: 800, bottom: 800 });

      expect(selector.selectAutoTargetScrollable([small, large], null, "down")).toBe(large);
    });
  });

  describe("pickLargestScrollable", () => {
    test("returns null for an empty list", () => {
      expect(selector.pickLargestScrollable([])).toBeNull();
    });

    test("returns the element with the greatest area", () => {
      const small = elementWithBounds({ left: 0, top: 0, right: 10, bottom: 10 });
      const big = elementWithBounds({ left: 0, top: 0, right: 100, bottom: 100 });
      expect(selector.pickLargestScrollable([small, big])).toBe(big);
    });
  });

  describe("matchesDirection", () => {
    test("treats a tall element as vertically scrollable", () => {
      const tall = elementWithBounds({ left: 0, top: 0, right: 100, bottom: 500 });
      expect(selector.matchesDirection(tall, "up")).toBe(true);
      expect(selector.matchesDirection(tall, "left")).toBe(false);
    });

    test("treats a wide element as horizontally scrollable", () => {
      const wide = elementWithBounds({ left: 0, top: 0, right: 500, bottom: 100 });
      expect(selector.matchesDirection(wide, "left")).toBe(true);
      expect(selector.matchesDirection(wide, "down")).toBe(false);
    });
  });

  describe("describeContainer", () => {
    test("describes an undefined container as unknown", () => {
      expect(selector.describeContainer(undefined)).toBe("unknown");
    });

    test("prefers elementId over text", () => {
      expect(selector.describeContainer({ elementId: "com.app:id/list", text: "List" })).toBe(
        'elementId="com.app:id/list"',
      );
    });

    test("falls back to text when only text is present", () => {
      expect(selector.describeContainer({ text: "My List" })).toBe('text="My List"');
    });

    test("describes an empty container as unknown", () => {
      expect(selector.describeContainer({})).toBe("unknown");
    });
  });

  describe("mergeWarnings", () => {
    test("returns undefined when there are no warnings", () => {
      expect(selector.mergeWarnings(undefined, undefined)).toBeUndefined();
    });

    test("joins distinct warnings and drops duplicates", () => {
      expect(selector.mergeWarnings("a", undefined, "b", "a")).toBe("a b");
    });
  });
});

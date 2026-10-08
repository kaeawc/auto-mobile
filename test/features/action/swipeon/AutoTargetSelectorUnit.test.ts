import { beforeAll, describe, expect, test } from "bun:test";
import { AutoTargetSelector } from "../../../../src/features/action/swipeon/AutoTargetSelector";
import { readFileSync } from "node:fs";
import { DefaultScrollableElementsQuery } from "../../../../src/features/utility/InteractiveElementQueries";
import type { ViewHierarchyResult } from "../../../../src/models";
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
      const wide: Element = {
        bounds: { left: 0, top: 0, right: 500, bottom: 100 },
        orientation: "horizontal",
      };
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

    test("filters sibling scrollables by capability before comparing area", () => {
      const horizontal: Element = {
        bounds: { left: 0, top: 0, right: 1000, bottom: 100 },
        class: "android.widget.HorizontalScrollView",
      };
      const vertical: Element = {
        bounds: { left: 0, top: 100, right: 100, bottom: 600 },
        class: "android.widget.ScrollView",
      };
      expect(selector.selectAutoTargetScrollable([horizontal, vertical], null, "up")).toBe(
        vertical,
      );
      expect(selector.selectAutoTargetScrollable([vertical, horizontal], null, "down")).toBe(
        vertical,
      );
      expect(selector.selectAutoTargetScrollable([vertical, horizontal], null, "left")).toBe(
        horizontal,
      );
    });

    test("selects the innermost centre-containing candidate over a larger off-centre one", () => {
      const screen = { left: 0, top: 0, right: 1000, bottom: 2000 };
      const outer: Element = { bounds: screen, class: "android.widget.ScrollView" };
      const middle: Element = {
        bounds: { left: 300, top: 200, right: 700, bottom: 1800 },
        class: "android.widget.ScrollView",
      };
      const inner: Element = {
        bounds: { left: 450, top: 800, right: 550, bottom: 1200 },
        class: "android.widget.ScrollView",
      };
      const offCentre: Element = {
        bounds: { left: 0, top: 0, right: 450, bottom: 2000 },
        class: "android.widget.ScrollView",
      };
      expect(
        selector.selectAutoTargetScrollable([outer, offCentre, middle, inner], screen, "up"),
      ).toBe(inner);
    });

    test("skips the screen-sized candidate even when only it contains the centre", () => {
      const screen = { left: 0, top: 0, right: 1000, bottom: 2000 };
      const outer = elementWithBounds(screen);
      const small = elementWithBounds({ left: 0, top: 0, right: 100, bottom: 500 });
      const large = elementWithBounds({ left: 0, top: 0, right: 300, bottom: 900 });
      expect(selector.selectAutoTargetScrollable([outer, small, large], screen, "up")).toBe(large);
    });

    test("keeps a screen-sized axis match when smaller candidates match only the other axis", () => {
      const screen = { left: 0, top: 0, right: 1000, bottom: 2000 };
      const pager: Element = { bounds: screen, class: "androidx.viewpager2.widget.ViewPager2" };
      const list: Element = {
        bounds: { left: 0, top: 200, right: 900, bottom: 1800 },
        class: "android.widget.ScrollView",
      };
      expect(selector.selectAutoTargetScrollable([pager, list], screen, "right")).toBe(pager);
      expect(selector.selectAutoTargetScrollable([pager, list], screen, "down")).toBe(list);
    });

    test("uses aspect ratio only after centre selection cannot decide", () => {
      const screen = { left: 0, top: 0, right: 1000, bottom: 2000 };
      const tall = elementWithBounds({ left: 0, top: 0, right: 100, bottom: 500 });
      const wide = elementWithBounds({ left: 0, top: 0, right: 800, bottom: 200 });
      expect(selector.selectAutoTargetScrollable([wide, tall], screen, "up")).toBe(tall);
      expect(selector.selectAutoTargetScrollable([tall, wide], screen, "left")).toBe(wide);
      // A centred wide list must win before shape preference is considered.
      wide.bounds = { left: 0, top: 900, right: 1000, bottom: 1100 };
      expect(selector.selectAutoTargetScrollable([tall, wide], screen, "up")).toBe(wide);
    });

    test("keeps the innermost centred wide candidate ahead of a tall outer list", () => {
      const screen = { left: 0, top: 0, right: 1000, bottom: 2000 };
      const outer = elementWithBounds({ left: 100, top: 100, right: 900, bottom: 1900 });
      const inner = elementWithBounds({ left: 100, top: 900, right: 900, bottom: 1100 });
      expect(selector.selectAutoTargetScrollable([outer, inner], screen, "up")).toBe(inner);
    });

    test("keeps known-axis candidates in the largest fallback regardless of shape", () => {
      const known: Element = {
        bounds: { left: 0, top: 0, right: 1000, bottom: 200 },
        orientation: "vertical",
      };
      const tall = elementWithBounds({ left: 0, top: 0, right: 100, bottom: 500 });
      expect(selector.selectAutoTargetScrollable([tall, known], null, "up")).toBe(known);
    });

    test("picks the largest when no unknown-axis shape fits the direction", () => {
      const small = elementWithBounds({ left: 0, top: 0, right: 500, bottom: 100 });
      const large = elementWithBounds({ left: 0, top: 0, right: 800, bottom: 200 });
      expect(selector.selectAutoTargetScrollable([small, large], null, "up")).toBe(large);
    });

    test("returns null when every candidate has the wrong capability", () => {
      const bounds = { left: 0, top: 0, right: 100, bottom: 1000 };
      expect(
        selector.selectAutoTargetScrollable(
          [
            { bounds, class: "android.widget.HorizontalScrollView" },
            { bounds, class: "androidx.viewpager.widget.ViewPager" },
          ],
          bounds,
          "up",
        ),
      ).toBeNull();
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
    test.each(["HorizontalScrollView", "ViewPager", "ViewPager2", "LazyRow"])(
      "%s is horizontal even when its bounds are tall",
      (className) => {
        const element: Element = {
          bounds: { left: 0, top: 0, right: 100, bottom: 500 },
          class: `example.${className}`,
        };
        expect(selector.matchesDirection(element, "up")).toBe(false);
        expect(selector.matchesDirection(element, "down")).toBe(false);
        expect(selector.matchesDirection(element, "left")).toBe(true);
        expect(selector.matchesDirection(element, "right")).toBe(true);
      },
    );

    test.each(["ScrollView", "NestedScrollView", "ListView", "ExpandableListView", "LazyColumn"])(
      "%s is vertical even when its bounds are wide",
      (className) => {
        const element: Element = {
          bounds: { left: 0, top: 0, right: 500, bottom: 100 },
          className: `example.${className}`,
        };
        expect(selector.matchesDirection(element, "up")).toBe(true);
        expect(selector.matchesDirection(element, "down")).toBe(true);
        expect(selector.matchesDirection(element, "left")).toBe(false);
        expect(selector.matchesDirection(element, "right")).toBe(false);
      },
    );

    test("uses exposed RecyclerView orientation before aspect ratio", () => {
      const element: Element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 500 },
        class: "androidx.recyclerview.widget.RecyclerView",
        orientation: "horizontal",
      };
      expect(selector.matchesDirection(element, "up")).toBe(false);
      expect(selector.matchesDirection(element, "left")).toBe(true);
      element.orientation = "vertical";
      element.bounds = { left: 0, top: 0, right: 500, bottom: 100 };
      expect(selector.matchesDirection(element, "down")).toBe(true);
      expect(selector.matchesDirection(element, "right")).toBe(false);
    });

    test("explicit orientation overrides the default ViewPager2 axis", () => {
      const element: Element = {
        bounds: { left: 0, top: 0, right: 500, bottom: 100 },
        class: "androidx.viewpager2.widget.ViewPager2",
        orientation: "vertical",
      };
      expect(selector.matchesDirection(element, "up")).toBe(true);
      expect(selector.matchesDirection(element, "left")).toBe(false);
    });

    test("axis-neutral scroll actions match either direction for a generic node", () => {
      const element: Element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 500 },
        class: "android.view.View",
        actions: ["scroll_forward", "scroll_backward"],
      };
      expect(selector.matchesDirection(element, "up")).toBe(true);
      expect(selector.matchesDirection(element, "left")).toBe(true);
    });

    test("does not reject horizontal swipes on an unknown-axis tall element", () => {
      const tall = elementWithBounds({ left: 0, top: 0, right: 100, bottom: 500 });
      expect(selector.matchesDirection(tall, "up")).toBe(true);
      expect(selector.matchesDirection(tall, "left")).toBe(true);
    });

    test("does not reject vertical swipes on an unknown-axis wide element", () => {
      const wide = elementWithBounds({ left: 0, top: 0, right: 500, bottom: 100 });
      expect(selector.matchesDirection(wide, "left")).toBe(true);
      expect(selector.matchesDirection(wide, "down")).toBe(true);
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

// Real batch-15 captures: only unrelated node subtrees were removed. The
// portrait swipe result already contains a production-parsed Element, not a hierarchy.
describe("AutoTargetSelector batch-15 captures", () => {
  const selector = new AutoTargetSelector();
  const captures = new Map<string, { scrollables: Element[]; screen: ElementBounds }>();
  let portrait: Element;

  beforeAll(() => {
    const query = new DefaultScrollableElementsQuery();
    for (const name of ["foldable", "landscape"]) {
      const hierarchy: ViewHierarchyResult = JSON.parse(
        readFileSync(
          new URL(`../../../fixtures/swipeon-auto-target/${name}.json`, import.meta.url),
          "utf8",
        ),
      );
      captures.set(name, {
        scrollables: query.findScrollableElements(hierarchy),
        screen: { left: 0, top: 0, right: hierarchy.screenWidth!, bottom: hierarchy.screenHeight! },
      });
    }
    portrait = JSON.parse(
      readFileSync(
        new URL("../../../fixtures/swipeon-auto-target/portrait-element.json", import.meta.url),
        "utf8",
      ),
    );
  });

  for (const [name, bounds] of [
    ["foldable", { left: 0, top: 497, right: 2076, bottom: 1801 }],
    ["landscape", { left: 136, top: 442, right: 2400, bottom: 744 }],
  ] as const) {
    test.each(["up", "down"] as const)(
      `${name} wide Compose list is selected for %s`,
      (direction) => {
        const capture = captures.get(name)!;
        expect(
          capture.scrollables.some((element) => element["resource-id"] === "tap_screen_content"),
        ).toBe(true);
        const selected = selector.selectAutoTargetScrollable(
          capture.scrollables,
          capture.screen,
          direction,
        );
        expect(selected?.bounds).toEqual(bounds);
        expect(selector.matchesDirection(capture.scrollables[0], direction)).toBe(true);
      },
    );
  }

  test.each(["up", "down"] as const)(
    "portrait captured list is still selected for %s",
    (direction) => {
      expect(portrait.bounds).toEqual({ left: 0, top: 652, right: 1080, bottom: 2064 });
      expect(selector.selectAutoTargetScrollable([portrait], null, direction)).toBe(portrait);
    },
  );
});

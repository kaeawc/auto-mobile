import { describe, expect, test } from "bun:test";
import { AutoTargetSelector } from "../../../../src/features/action/swipeon/AutoTargetSelector";
import { resolveScrollableSwipeTarget } from "../../../../src/features/action/swipeon/scrollableAncestor";
import type { Platform } from "../../../../src/models/Platform";
import type { SwipeDirection } from "../../../../src/models/SwipeOnOptions";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../../src/models/ViewHierarchyResult";
import { FakeElementParser } from "../../../fakes/FakeElementParser";

const horizontalDirections = ["left", "right"] as const;
const listKinds = [
  { class: "UICollectionView", role: "list" },
  { class: "UICollectionView" },
  { class: "UITableView" },
  { class: "SwiftUI.List", role: "list" },
];

function fixture(ancestor: ViewHierarchyNode, outer?: ViewHierarchyNode) {
  const parser = new FakeElementParser();
  const selector = new AutoTargetSelector();
  const row: ViewHierarchyNode = {
    class: "SwiftUI.Row",
    text: "Inbox message",
    scrollable: "false",
    bounds: { left: 0, top: 100, right: 400, bottom: 160 },
  };
  const parent = {
    ...ancestor,
    bounds: { left: 0, top: 0, right: 400, bottom: 800 },
    node: [row],
  } satisfies ViewHierarchyNode;
  const hierarchy: ViewHierarchyResult = {
    hierarchy: {
      node: outer ? { ...outer, bounds: parent.bounds, node: [parent] } : parent,
    },
  };
  const element = parser.parseNodeBounds(row);
  if (!element) {
    throw new Error("Fixture row must have valid bounds");
  }
  return {
    element,
    parent,
    resolve(direction: SwipeDirection, platform?: Platform) {
      return resolveScrollableSwipeTarget({
        hierarchy,
        element,
        direction,
        platform,
        parser,
        scrollsInDirection: (candidate, dir) => selector.scrollsInDirection(candidate, dir),
      });
    },
  };
}

describe("resolveScrollableSwipeTarget", () => {
  for (const kind of listKinds) {
    const label = `${kind.class} (role ${kind.role ?? "absent"})`;
    for (const direction of horizontalDirections) {
      test(`iOS ${direction} keeps the row under ${label}`, () => {
        const { element, resolve } = fixture({ ...kind, scrollable: "true" });
        expect(resolve(direction, "ios")).toBe(element);
      });

      test(`Android ${direction} still escalates to ${label}`, () => {
        const { parent, resolve } = fixture({ ...kind, scrollable: "true" });
        expect(resolve(direction, "android").bounds).toEqual(parent.bounds);
        expect(resolve(direction, "android").class).toBe(kind.class);
      });
    }

    for (const direction of ["up", "down"] as const) {
      test(`iOS ${direction} still escalates to ${label}`, () => {
        const { parent, resolve } = fixture({ ...kind, scrollable: "true" });
        expect(resolve(direction, "ios").bounds).toEqual(parent.bounds);
        expect(resolve(direction, "ios").class).toBe(kind.class);
      });
    }
  }

  for (const [platform, className] of [
    ["ios", "ScrollView"],
    ["ios", "UIScrollView"],
    ["android", "androidx.viewpager.widget.ViewPager"],
    ["android", "androidx.viewpager2.widget.ViewPager2"],
  ] as const) {
    for (const direction of horizontalDirections) {
      test(`${platform} ${direction} still escalates a page to ${className}`, () => {
        const { parent, resolve } = fixture({
          $: { class: className, orientation: "horizontal", scrollable: "true" },
        });
        expect(resolve(direction, platform).class).toBe(className);
        expect(resolve(direction, platform).bounds).toEqual(parent.bounds);
      });
    }
  }

  for (const direction of horizontalDirections) {
    test(`iOS ${direction} continues past a list to an outer pager`, () => {
      const { resolve } = fixture(
        { class: "UICollectionView", role: "list", scrollable: "true" },
        { $: { class: "UIScrollView", orientation: "horizontal", scrollable: "true" } },
      );
      expect(resolve(direction, "ios").class).toBe("UIScrollView");
    });
  }

  for (const direction of horizontalDirections) {
    test(`iOS ${direction} escalates a named cell to a horizontal UICollectionView carousel`, () => {
      const { parent, resolve } = fixture({
        $: { class: "UICollectionView", orientation: "horizontal", scrollable: "true" },
        role: "list",
      });
      const target = resolve(direction, "ios");
      expect(target.class).toBe("UICollectionView");
      expect(target.bounds).toEqual(parent.bounds);
    });

    test(`iOS ${direction} escalates a page to a horizontal paging collection view`, () => {
      const { parent, resolve } = fixture({
        $: { class: "UICollectionView", orientation: "horizontal", scrollable: "true" },
      });
      const target = resolve(direction, "ios");
      expect(target.class).toBe("UICollectionView");
      expect(target.bounds).toEqual(parent.bounds);
    });

    test(`iOS ${direction} keeps the row under a vertical-orientation list`, () => {
      const { element, resolve } = fixture({
        $: { class: "UITableView", orientation: "vertical", scrollable: "true" },
      });
      expect(resolve(direction, "ios")).toBe(element);
    });

    test(`iOS ${direction} escalates past a vertical list to an outer horizontal carousel`, () => {
      const { resolve } = fixture(
        { class: "UICollectionView", role: "list", scrollable: "true" },
        { $: { class: "UICollectionView", orientation: "horizontal", scrollable: "true" } },
      );
      const target = resolve(direction, "ios");
      expect(target.class).toBe("UICollectionView");
      expect(target.orientation).toBe("horizontal");
    });
  }

  test("an omitted platform preserves the previous escalation behavior", () => {
    const { resolve } = fixture({ class: "UICollectionView", role: "list", scrollable: "true" });
    expect(resolve("left").class).toBe("UICollectionView");
  });
});

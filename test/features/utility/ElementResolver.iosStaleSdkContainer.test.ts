import { describe, expect, test } from "bun:test";
import shiftedCapture from "../../fixtures/ios/nested-selection/cart-a-item-42-focused-keyboard-shift.json";
import { isSdkInjectedNode } from "../../../src/features/observe/android/StableNodeIdentity";
import type { ViewHierarchyResult } from "../../../src/models";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";

/**
 * Issue #10266: a real iOS simulator capture of the Playground nested-selection screen
 * taken right after a focus tap on `cart_A > item_42 > quantity`. The keyboard moved the
 * content up 126 pt; XCUITest reports the carts at their new position, but the merged
 * in-app SDK snapshot still holds the old layout, so each cart id appears again as an
 * SDK-only `HostingScrollView` at the old position, outside the XCUITest cart.
 */
const hierarchy = (): ViewHierarchyResult =>
  structuredClone(
    (shiftedCapture as { viewHierarchy: unknown }).viewHierarchy,
  ) as ViewHierarchyResult;

describe("iOS container duplicated by a stale SDK snapshot (#10266)", () => {
  test("the capture holds a second, SDK-only cart_A outside the XCUITest cart_A", () => {
    const nodes = new SearchableHierarchy().project(hierarchy());
    const carts = nodes.filter((node) => node.nativeId === "cart_A");
    expect(carts.map((node) => [node.bounds?.top, isSdkInjectedNode(node.source)])).toEqual([
      [185, false],
      [311, true],
    ]);
  });

  test("a cart_A > item_42 scope resolves within the XCUITest cart", () => {
    const result = new ResolverElementSelector().selectByResourceId(hierarchy(), "quantity", {
      container: { elementId: "item_42", container: { elementId: "cart_A" } },
      strategy: "unique",
      intentAction: "focus-input",
    });
    expect(result.error).toBeUndefined();
    expect(result.element?.["resource-id"]).toBe("quantity");
    expect(result.element?.bounds).toEqual({ left: 12, top: 261, right: 296, bottom: 296 });
  });

  test("two XCUITest containers sharing an id are still ambiguous", () => {
    expect(() =>
      new ResolverElementSelector().selectByResourceId(hierarchy(), "quantity", {
        container: { elementId: "item_42" },
        strategy: "unique",
        intentAction: "focus-input",
      }),
    ).toThrow("Container level 1 ambiguous: item_42");
  });
});

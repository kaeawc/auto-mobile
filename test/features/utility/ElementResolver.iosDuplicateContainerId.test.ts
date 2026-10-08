import { describe, expect, test } from "bun:test";
import capture from "../../fixtures/ios/nested-selection/scroll-cart-duplicate-container-id.json";
import type { ViewHierarchyResult } from "../../../src/models";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";

/**
 * Issue #10266: a real iOS 26 simulator capture of the Playground nested-selection screen,
 * where each cart is a SwiftUI ScrollView with `.accessibilityElement(children: .contain)` and
 * an identifier. The capture holds every cart id twice: the XCUITest `UIScrollView` with the
 * `item_40`...`item_47` rows, and the SDK walker's `HostingScrollView` nested inside it, with
 * the same id and no rows. Scoping to the empty inner node found no targets.
 */
const hierarchy = () => structuredClone(capture.viewHierarchy) as unknown as ViewHierarchyResult;

function select(
  elementId: string,
  container: { elementId: string; container?: { elementId: string } },
  options: { strategy?: "unique"; intentAction?: "tap" | "focus-input" } = {},
) {
  return new ResolverElementSelector().selectByResourceId(hierarchy(), elementId, {
    container,
    strategy: options.strategy,
    intentAction: options.intentAction ?? "tap",
  });
}

describe("iOS container captured twice with one id (#10266)", () => {
  test("the capture nests an empty same-id node inside each cart", () => {
    const nodes = new SearchableHierarchy().project(hierarchy());
    for (const cart of ["cart_A", "cart_B"]) {
      const [outer, inner, ...rest] = nodes.filter((node) => node.nativeId === cart);
      expect(rest).toHaveLength(0);
      expect(inner.parentIndex).toBe(outer.index);
      expect(inner.bounds).toEqual(outer.bounds);
      const rowsUnder = (scope: typeof outer) =>
        nodes.filter(
          (node) => node.parentIndex === scope.index && node.nativeId?.startsWith("item_"),
        ).length;
      expect(rowsUnder(outer)).toBe(8);
      expect(rowsUnder(inner)).toBe(0);
    }
  });

  test("tapOn remove within item_42 within cart_A selects that row's button", () => {
    const result = select(
      "remove",
      { elementId: "item_42", container: { elementId: "cart_A" } },
      { strategy: "unique" },
    );
    expect(result.error).toBeUndefined();
    expect(result.element?.["resource-id"]).toBe("remove");
    expect(result.element?.bounds).toEqual({ left: 304, top: 343, right: 389, bottom: 378 });
  });

  test("a focus within item_42 within cart_B selects that row's quantity field", () => {
    const result = select(
      "quantity",
      { elementId: "item_42", container: { elementId: "cart_B" } },
      { strategy: "unique", intentAction: "focus-input" },
    );
    expect(result.error).toBeUndefined();
    expect(result.element?.["resource-id"]).toBe("quantity");
    expect(result.element?.bounds).toEqual({ left: 12, top: 589, right: 296, bottom: 624 });
  });

  test("a single-level cart scope reaches the cart's rows", () => {
    const result = select("remove", { elementId: "cart_B" });
    expect(result.element?.bounds).toEqual({ left: 304, top: 513, right: 389, bottom: 547 });
  });
});

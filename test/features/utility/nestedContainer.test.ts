import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import type { ElementQuery } from "../../../src/models/ElementQuery";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models/ViewHierarchyResult";

const bounds = { left: 10, top: 10, right: 50, bottom: 50 };
const node = (
  id: string,
  children: ViewHierarchyNode[] = [],
  extra: Record<string, unknown> = {},
): ViewHierarchyNode => ({
  $: { "resource-id": id, bounds, ...extra },
  node: children,
});
const hierarchy = (...nodes: ViewHierarchyNode[]): ViewHierarchyResult => ({
  hierarchy: { node: node("root", nodes) },
  screenWidth: 100,
  screenHeight: 100,
});
const query: ElementQuery = {
  elementId: "remove",
  container: { elementId: "item_42", container: { elementId: "cart_A" } },
  selectionStrategy: "unique",
};
const finder = new DefaultElementFinder();

describe("nested container query", () => {
  test("native identity and SDK mirrors do not inflate cardinality", () => {
    const target = node("remove", [], { "unique-id": "native-42" });
    const duplicate = structuredClone(target);
    const mirror = node("remove", [], { extras: { "sdk.source": "sdkWalker" } });
    const h = hierarchy(node("cart_A", [node("item_42", [node("", [target, duplicate, mirror])])]));
    expect(finder.resolveQuery(h, query).node).toBe(target);
  });

  test("actions count eligible scoped matches and retain the legacy smallest-first preference", () => {
    const hidden = node("remove", [], { visible: false });
    const small = node("remove", [], { bounds: { left: 10, top: 10, right: 20, bottom: 20 } });
    const row = node("item_42", [hidden, small]);
    const h = hierarchy(node("cart_A", [row]));
    expect(finder.resolveQuery(h, query, { actionable: true }).node).toBe(small);
    row.node!.push(node("remove"));
    expect(
      finder.resolveQuery(h, { ...query, selectionStrategy: "first" }, { actionable: true }).node,
    ).toBe(small);
    expect(finder.resolveQuery(h, query, { actionable: true }).diagnostic?.code).toBe(
      "target_ambiguous",
    );
  });

  test("resolves strict ancestry across wrappers and ignores container hit eligibility", () => {
    const target = node("remove");
    const h = hierarchy(
      node("cart_A", [
        node("", [
          node("item_42", [node("", [target])], {
            clickable: false,
            bounds: { left: -500, top: -500, right: 70, bottom: 70 },
          }),
          node("item_73", [node("remove")]),
        ]),
      ]),
      node("cart_B", [node("item_42", [node("remove")])]),
    );
    const result = finder.resolveQuery(h, query, { actionable: true });
    expect(result.node).toBe(target);
    expect(result.levels.map((level) => level.matchCount)).toEqual([1, 1, 1]);
    expect(
      new DefaultElementSelector(finder).selectByResourceId(h, "remove", {
        container: query.container,
        strategy: "unique",
      }).element?.["resource-id"],
    ).toBe("remove");
  });

  test.each([
    [hierarchy(node("cart_B")), "container_not_found", 0],
    [hierarchy(node("cart_A")), "container_not_found", 1],
    [hierarchy(node("cart_A", [node("item_42")])), "target_not_found", 2],
    [
      hierarchy(node("cart_A", [node("item_42", [node("remove")])]), node("cart_A")),
      "container_ambiguous",
      0,
    ],
    [
      hierarchy(node("cart_A", [node("item_42", [node("remove")]), node("item_42")])),
      "container_ambiguous",
      1,
    ],
    [
      hierarchy(node("cart_A", [node("item_42", [node("remove"), node("remove")])])),
      "target_ambiguous",
      2,
    ],
  ] as const)("distinguishes failure %#", (h, code, level) => {
    expect(finder.resolveQuery(h, query).diagnostic).toMatchObject({ code, level });
  });

  test("a scope cannot match itself", () => {
    expect(
      finder.resolveQuery(hierarchy(node("row")), {
        elementId: "row",
        container: { elementId: "row" },
        selectionStrategy: "unique",
      }).diagnostic?.code,
    ).toBe("target_not_found");
  });

  test("per-level indices override uniqueness only within that scope", () => {
    const intended = node("remove", [], { text: "intended" });
    const h = hierarchy(
      node("cart_A", [
        node("item_42", [node("remove")]),
        node("item_42", [node("remove"), intended]),
      ]),
      node("cart_B", [node("remove")]),
    );
    const indexed = { ...query, index: 1, container: { ...query.container!, index: 1 } };
    expect(finder.resolveQuery(h, indexed).node).toBe(intended);
    expect(finder.resolveQuery(h, { ...indexed, index: 2 }).diagnostic?.code).toBe(
      "index_out_of_range",
    );
    expect(
      finder.resolveQuery(h, { ...indexed, container: { ...indexed.container, index: 2 } })
        .diagnostic,
    ).toMatchObject({ code: "index_out_of_range", level: 1 });
  });

  test("exact identifiers outrank the Compose bare alias at every level", () => {
    const intended = node("pkg:id/remove");
    const h = hierarchy(
      node("pkg:id/row", [node("remove"), intended]),
      node("row", [node("remove")]),
    );
    expect(
      finder.resolveQuery(h, {
        elementId: "pkg:id/remove",
        container: { elementId: "pkg:id/row" },
        selectionStrategy: "unique",
      }).node,
    ).toBe(intended);
  });

  test("text uses normalized case-insensitive exact precedence at every level", () => {
    const intended = node("remove", [], { "ios-accessibility-label": "Remove" });
    const h = hierarchy(
      node("other", [node("remove")], { text: "Row extended" }),
      node("row", [intended, node("other", [], { text: "Remove all" })], { text: "ROW" }),
    );
    expect(
      finder.resolveQuery(h, {
        text: "remove",
        container: { text: "row" },
        selectionStrategy: "unique",
      }).node,
    ).toBe(intended);
  });

  test.each([
    { enabled: false },
    { visible: false },
    { hittable: false },
    {
      bounds: { left: 200, top: 200, right: 220, bottom: 220 },
    },
  ])("observes ineligible nodes but refuses actions %#", (extra) => {
    const h = hierarchy(node("cart_A", [node("item_42", [node("remove", [], extra)])]));
    expect(finder.resolveQuery(h, query).node).not.toBeNull();
    expect(finder.resolveQuery(h, query, { actionable: true }).diagnostic?.code).toBe(
      "target_not_actionable",
    );
  });

  test("distinct windows remain ambiguous and an ancestor chain cannot cross windows", () => {
    const h = hierarchy(node("cart_A"));
    h.windows = [
      { id: 2, hierarchy: node("", [node("cart_B", [node("item_42", [node("remove")])])]) },
    ];
    expect(finder.resolveQuery(h, query).diagnostic).toMatchObject({
      code: "container_not_found",
      level: 1,
    });
    h.windows.push({ id: 3, hierarchy: node("", [node("cart_A")]) });
    expect(finder.resolveQuery(h, query).diagnostic?.code).toBe("container_ambiguous");
  });

  test("wrapper insertion and unrelated sibling ordering preserve the logical target", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8 }), fc.boolean(), (wrappers, reverse) => {
        const intended = node("remove");
        let row = node("item_42", [intended]);
        for (let i = 0; i < wrappers; i++) {
          row = node("", [row]);
        }
        const carts = [
          node("cart_A", [row, node("item_73", [node("remove")])]),
          node("cart_B", [node("item_42", [node("remove")])]),
        ];
        if (reverse) {
          carts.reverse();
        }
        expect(finder.resolveQuery(hierarchy(...carts), query).node).toBe(intended);
      }),
      { seed: 1234567, numRuns: 50 },
    );
  });
});

import { describe, expect, test } from "bun:test";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import type { ElementBounds } from "../../../src/models";
import type { ViewHierarchyResult } from "../../../src/models/ViewHierarchyResult";

type NodeSpec = {
  bounds: ElementBounds;
  text?: string;
  resourceId?: string;
};

const createViewHierarchy = (nodes: NodeSpec[]): ViewHierarchyResult => {
  return {
    hierarchy: {
      node: {
        $: {
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          class: "android.widget.FrameLayout",
        },
        node: nodes.map((node) => ({
          $: {
            bounds: node.bounds,
            class: "android.widget.TextView",
            ...(node.text ? { text: node.text } : {}),
            ...(node.resourceId ? { "resource-id": node.resourceId } : {}),
          },
        })),
      },
    },
    screenWidth: 100,
    screenHeight: 100,
  } as ViewHierarchyResult;
};

describe("DefaultElementSelector", () => {
  test("first strategy returns smallest exact match", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 30, bottom: 30 }, text: "Match" },
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Match" },
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "first" });

    expect(match.element?.bounds).toEqual({ left: 0, top: 0, right: 10, bottom: 10 });
    expect(match.indexInMatches).toBe(0);
    expect(match.totalMatches).toBe(2);
    expect(match.strategy).toBe("first");
  });

  test("prefers an actionable match in the topmost dialog window over an identically named title", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = {
      hierarchy: {
        node: {
          $: {
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            class: "XCUIElementTypeWindow",
          },
          node: [
            {
              $: {
                bounds: { left: 10, top: 10, right: 90, bottom: 30 },
                class: "XCUIElementTypeStaticText",
                text: "Sign Out",
              },
            },
          ],
        },
      },
      windows: [
        {
          isActive: true,
          isFocused: true,
          hierarchy: {
            node: {
              $: {
                bounds: { left: 0, top: 0, right: 100, bottom: 100 },
                class: "XCUIElementTypeAlert",
              },
              node: [
                {
                  $: {
                    bounds: { left: 10, top: 60, right: 90, bottom: 90 },
                    class: "XCUIElementTypeButton",
                    text: "Sign Out",
                    actions: ["click"],
                  },
                },
              ],
            },
          },
        },
      ],
      screenWidth: 100,
      screenHeight: 100,
    } as unknown as ViewHierarchyResult;

    const match = selector.selectByText(viewHierarchy, "Sign Out");

    expect(match.element?.class).toBe("XCUIElementTypeButton");
    expect(match.element?.actions).toEqual(["click"]);
    expect(match.indexInMatches).toBe(0);
    expect(match.totalMatches).toBe(2);

    expect(selector.selectByText(viewHierarchy, "Sign Out", { index: 0 }).element?.class).toBe(
      "XCUIElementTypeStaticText",
    );
    expect(
      selector.selectByText(viewHierarchy, "Sign Out", { strategy: "random" }).element?.class,
    ).toBe("XCUIElementTypeStaticText");
  });

  test("first strategy skips off-screen matches before selecting", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: -20, top: 0, right: -10, bottom: 10 }, text: "Match" },
      { bounds: { left: 10, top: 0, right: 40, bottom: 30 }, text: "Match" },
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "first" });

    expect(match.element?.bounds).toEqual({ left: 10, top: 0, right: 40, bottom: 30 });
    expect(match.indexInMatches).toBe(1);
    expect(match.totalMatches).toBe(2);
  });

  test("returns null when every match is off-screen", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: -300, top: 0, right: -200, bottom: 30 }, text: "Match" },
      { bounds: { left: 120, top: 0, right: 160, bottom: 30 }, text: "Match" },
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "first" });

    expect(match.element).toBeNull();
    expect(match.indexInMatches).toBe(-1);
    expect(match.totalMatches).toBe(2);
  });

  test("random strategy returns different matches across calls", () => {
    const randomValues = [0, 0.99];
    const random = () => randomValues.shift() ?? 0;
    const selector = new DefaultElementSelector(new DefaultElementFinder(), random);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Match" },
      { bounds: { left: 0, top: 0, right: 20, bottom: 20 }, text: "Match" },
    ]);

    const first = selector.selectByText(viewHierarchy, "Match", { strategy: "random" });
    const second = selector.selectByText(viewHierarchy, "Match", { strategy: "random" });

    expect(first.element?.bounds).not.toEqual(second.element?.bounds);
    expect(first.indexInMatches).toBe(0);
    expect(second.indexInMatches).toBe(1);
    expect(first.totalMatches).toBe(2);
    expect(second.totalMatches).toBe(2);
  });

  test("random strategy prefers exact matches over fuzzy", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0.9);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Match" },
      { bounds: { left: 0, top: 0, right: 20, bottom: 20 }, text: "Match 2" },
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "random" });

    expect(match.element?.text).toBe("Match");
    expect(match.totalMatches).toBe(1);
  });

  test("returns null when no matches are found", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Other" },
    ]);

    const match = selector.selectByText(viewHierarchy, "Match", { strategy: "first" });

    expect(match.element).toBeNull();
    expect(match.indexInMatches).toBe(-1);
    expect(match.totalMatches).toBe(0);
  });

  test("random strategy returns single match for resource ID", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0.5);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, resourceId: "test:id/button" },
    ]);

    const match = selector.selectByResourceId(viewHierarchy, "test:id/button", {
      strategy: "random",
    });

    expect(match.element?.["resource-id"]).toBe("test:id/button");
    expect(match.totalMatches).toBe(1);
  });
});

describe("selectClickableSiblingOfText — nested label rows", () => {
  const node = (attrs: Record<string, any>, children?: any[]): any => ({
    $: attrs,
    ...(children ? { node: children } : {}),
  });

  // A list row that nests its label under a leading container (e.g. an avatar): the NAME
  // is a descendant of that container, while the row's action button is a SIBLING of the
  // container (a "cousin" of the name text), NOT a direct sibling of the text. Both rows
  // share the removeButton resource-id.
  const row = (name: string, top: number) =>
    node(
      {
        bounds: { left: 0, top, right: 100, bottom: top + 20 },
        class: "android.view.ViewGroup",
        "resource-id": "app:id/row",
        clickable: "true",
      },
      [
        node(
          {
            bounds: { left: 5, top: top + 2, right: 80, bottom: top + 18 },
            class: "android.view.ViewGroup",
            "resource-id": "app:id/avatar",
          },
          [
            node({
              bounds: { left: 10, top: top + 2, right: 80, bottom: top + 10 },
              class: "android.widget.TextView",
              "resource-id": "app:id/nameLabel",
              text: name,
            }),
          ],
        ),
        node({
          bounds: { left: 85, top: top + 2, right: 98, bottom: top + 18 },
          class: "android.widget.ImageButton",
          "resource-id": "app:id/removeButton",
          clickable: "true",
        }),
      ],
    );

  const rowWithClickableContent = (name: string, top: number) =>
    node(
      {
        bounds: { left: 0, top, right: 100, bottom: top + 20 },
        class: "android.view.ViewGroup",
        "resource-id": "app:id/row",
        clickable: "true",
      },
      [
        node(
          {
            bounds: { left: 5, top: top + 2, right: 80, bottom: top + 18 },
            class: "android.view.ViewGroup",
            "resource-id": "app:id/content",
            clickable: "true",
          },
          [
            node({
              bounds: { left: 10, top: top + 2, right: 80, bottom: top + 10 },
              class: "android.widget.TextView",
              "resource-id": "app:id/nameLabel",
              text: name,
            }),
          ],
        ),
        node({
          bounds: { left: 85, top: top + 2, right: 98, bottom: top + 18 },
          class: "android.widget.ImageButton",
          "resource-id": "app:id/removeButton",
          clickable: "true",
        }),
      ],
    );

  const rowsHierarchy = {
    hierarchy: {
      node: node(
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          class: "android.widget.FrameLayout",
        },
        [
          node(
            {
              bounds: { left: 0, top: 0, right: 100, bottom: 60 },
              class: "androidx.recyclerview.widget.RecyclerView",
              "resource-id": "app:id/list",
            },
            [row("Alice Adams", 0), row("Bob Brown", 20)],
          ),
        ],
      ),
    },
    screenWidth: 100,
    screenHeight: 100,
  } as unknown as ViewHierarchyResult;

  test("finds the remove button in the SAME row as the named row", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);

    const alice = selector.selectClickableSiblingOfText(rowsHierarchy, "Alice Adams", {
      strategy: "first",
    });
    const bob = selector.selectClickableSiblingOfText(rowsHierarchy, "Bob Brown", {
      strategy: "first",
    });

    // Both resolve (before the fix, the nested name returned no clickable sibling)...
    expect(alice.element?.["resource-id"]).toBe("app:id/removeButton");
    expect(bob.element?.["resource-id"]).toBe("app:id/removeButton");
    // ...and each targets ITS OWN row's button (the shared id no longer collapses to row 1).
    expect(alice.element?.bounds.top).toBeLessThan(bob.element!.bounds.top);
  });

  test("a matched row with no control resolves to null, not a sibling row's control", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    // Alice's row has NO remove button; Bob's row does. Searching Alice must NOT bubble up to
    // the list and return Bob's control (a silent wrong tap) — it must be a clean null.
    const aliceNoButton = {
      hierarchy: {
        node: node(
          {
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            class: "android.widget.FrameLayout",
          },
          [
            node(
              {
                bounds: { left: 0, top: 0, right: 100, bottom: 60 },
                class: "androidx.recyclerview.widget.RecyclerView",
                "resource-id": "app:id/list",
              },
              [
                node(
                  {
                    bounds: { left: 0, top: 0, right: 100, bottom: 20 },
                    class: "android.view.ViewGroup",
                    "resource-id": "app:id/row",
                    clickable: "true",
                  },
                  [
                    node(
                      {
                        bounds: { left: 5, top: 2, right: 80, bottom: 18 },
                        class: "android.view.ViewGroup",
                        "resource-id": "app:id/avatar",
                      },
                      [
                        node({
                          bounds: { left: 10, top: 2, right: 80, bottom: 10 },
                          class: "android.widget.TextView",
                          "resource-id": "app:id/nameLabel",
                          text: "Alice Adams",
                        }),
                      ],
                    ),
                  ],
                ),
                row("Bob Brown", 20),
              ],
            ),
          ],
        ),
      },
      screenWidth: 100,
      screenHeight: 100,
    } as unknown as ViewHierarchyResult;

    const alice = selector.selectClickableSiblingOfText(aliceNoButton, "Alice Adams", {
      strategy: "first",
    });
    expect(alice.element).toBeNull();
  });

  test("finds the row action when the nested label container is clickable", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const clickableContentRows = {
      hierarchy: {
        node: node(
          {
            bounds: { left: 0, top: 0, right: 100, bottom: 100 },
            class: "android.widget.FrameLayout",
          },
          [
            node(
              {
                bounds: { left: 0, top: 0, right: 100, bottom: 60 },
                class: "androidx.recyclerview.widget.RecyclerView",
                "resource-id": "app:id/list",
              },
              [rowWithClickableContent("Alice Adams", 0), rowWithClickableContent("Bob Brown", 20)],
            ),
          ],
        ),
      },
      screenWidth: 100,
      screenHeight: 100,
    } as unknown as ViewHierarchyResult;

    const bob = selector.selectClickableSiblingOfText(clickableContentRows, "Bob Brown", {
      strategy: "first",
    });
    expect(bob.element?.["resource-id"]).toBe("app:id/removeButton");
    expect(bob.element?.bounds.top).toBe(22);
  });

  test("still finds a clickable DIRECT sibling of the text (regression)", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const flatRow = {
      hierarchy: {
        node: node(
          { bounds: { left: 0, top: 0, right: 100, bottom: 20 }, class: "android.view.ViewGroup" },
          [
            node({
              bounds: { left: 0, top: 0, right: 50, bottom: 10 },
              class: "android.widget.TextView",
              text: "Accept Terms",
            }),
            node({
              bounds: { left: 50, top: 0, right: 60, bottom: 10 },
              class: "android.widget.CheckBox",
              "resource-id": "app:id/cb",
              clickable: "true",
            }),
          ],
        ),
      },
      screenWidth: 100,
      screenHeight: 100,
    } as unknown as ViewHierarchyResult;

    const match = selector.selectClickableSiblingOfText(flatRow, "Accept Terms", {
      strategy: "first",
    });
    expect(match.element?.["resource-id"]).toBe("app:id/cb");
  });
});

describe("selectByResourceId — index", () => {
  const node = (attrs: Record<string, any>, children?: any[]): any => ({
    $: attrs,
    ...(children ? { node: children } : {}),
  });

  // Two controls sharing one resource-id (a repeated per-row action), stacked
  // top-to-bottom. `index` picks the Nth on-screen match in hierarchy order.
  const repeated = {
    hierarchy: {
      node: node(
        {
          bounds: { left: 0, top: 0, right: 100, bottom: 100 },
          class: "android.widget.FrameLayout",
        },
        [
          node({
            bounds: { left: 0, top: 0, right: 100, bottom: 20 },
            class: "android.widget.ImageButton",
            "resource-id": "app:id/remove",
            clickable: "true",
          }),
          node({
            bounds: { left: 0, top: 20, right: 20, bottom: 30 },
            class: "android.widget.ImageButton",
            "resource-id": "app:id/remove",
            clickable: "true",
          }),
        ],
      ),
    },
    screenWidth: 100,
    screenHeight: 100,
  } as unknown as ViewHierarchyResult;

  test("index selects the Nth match and is out-of-range safe", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);

    expect(
      selector.selectByResourceId(repeated, "app:id/remove", { index: 0 }).element?.bounds.top,
    ).toBe(0);
    expect(
      selector.selectByResourceId(repeated, "app:id/remove", { index: 1 }).element?.bounds.top,
    ).toBe(20);
    // Out of range → no match, rather than silently grabbing another element.
    expect(selector.selectByResourceId(repeated, "app:id/remove", { index: 2 }).element).toBeNull();
    // No index → strategy default (first/smallest exact match) still applies.
    expect(
      selector.selectByResourceId(repeated, "app:id/remove", { strategy: "first" }).element?.bounds
        .top,
    ).toBe(20);
  });

  // (Deleted a duplicate "index uses hierarchy order…" test: its two assertions
  // were byte-identical to the index rows in "index selects the Nth match and is
  // out-of-range safe" above — no unique coverage. The selectByText variant below
  // is retained because it exercises a different selector method.)
});

describe("selectByText — index", () => {
  test("index uses hierarchy order even when area sorting would pick a later smaller match", () => {
    const selector = new DefaultElementSelector(new DefaultElementFinder(), () => 0);
    const viewHierarchy = createViewHierarchy([
      { bounds: { left: 0, top: 0, right: 100, bottom: 20 }, text: "Match" },
      { bounds: { left: 0, top: 20, right: 20, bottom: 30 }, text: "Match" },
    ]);

    expect(selector.selectByText(viewHierarchy, "Match", { index: 0 }).element?.bounds.top).toBe(0);
    expect(selector.selectByText(viewHierarchy, "Match", { index: 1 }).element?.bounds.top).toBe(
      20,
    );
    // No index → strategy default (first/smallest exact match) still applies.
    expect(
      selector.selectByText(viewHierarchy, "Match", { strategy: "first" }).element?.bounds.top,
    ).toBe(20);
  });
});

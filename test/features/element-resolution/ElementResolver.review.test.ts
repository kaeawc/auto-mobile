import { DefaultObserveElementCollector } from "../../../src/features/observe/ObserveElementCollector";
import { projectSkeleton } from "../../../src/features/observe/output/SkeletonProjection";
import { expect, test } from "bun:test";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { resolverSelectorSchema } from "../../../src/server/elementSelectorSchemas";

const bounds = { left: 0, top: 0, right: 100, bottom: 100 };
const node = (id: string, extra = {}) => ({ "resource-id": id, bounds, ...extra });
const snapshot = (nodes: unknown[]) => ({
  id: "review",
  nodes: new SearchableHierarchy().project({ hierarchy: { node: nodes } } as any),
});
const tap = { action: "tap" as const };
const resolver = new ElementResolver(() => 0);
const row = (id: string, label = "Email") =>
  node(id, {
    clickable: true,
    node: [node(`${id}-label`, { text: label }), node("remove", { clickable: true })],
  });
const list = (id: string) =>
  node(id, { class: "androidx.recyclerview.widget.RecyclerView", node: [row(`${id}-row`)] });

test("toggle-only controls accept tap actions", () => {
  const result = resolver.resolve(
    snapshot([node("switch", { checkable: true, class: "android.widget.Switch" })]),
    { elementId: "switch" },
    tap,
  );
  expect(result.chosen?.nativeId).toBe("switch");
});

test("sibling text uses the actual child label rather than its hoisted collection row", () => {
  const result = resolver.resolve(
    snapshot([list("list")]),
    { elementId: "remove", sibling: { text: "Email" } },
    tap,
  );
  expect(result.error).toBeUndefined();
  expect(result.chosen?.nativeId).toBe("remove");
});

test("sibling anchors honor nested containers", () => {
  const capture = snapshot([list("list1"), list("list2")]);
  const result = resolver.resolve(
    capture,
    { elementId: "remove", sibling: { text: "Email", container: { elementId: "list2" } } },
    tap,
  );
  expect(result.chosen?.parentIndex).toBe(
    capture.nodes.find((n) => n.nativeId === "list2-row")?.index,
  );
});

test("text container keeps its matched section instead of promoting to a clickable card", () => {
  const capture = snapshot([
    node("card", {
      clickable: true,
      node: [
        node("first", { text: "First", node: [node("save", { clickable: true })] }),
        node("second", { text: "Second", node: [node("save", { clickable: true })] }),
      ],
    }),
  ]);
  const result = resolver.resolve(
    capture,
    { elementId: "save", container: { text: "Second" } },
    tap,
  );
  expect(result.scope?.nativeId).toBe("second");
  expect(result.chosen?.parentIndex).toBe(
    capture.nodes.find((entry) => entry.nativeId === "second")?.index,
  );
});

test("implicit text mode finds an input when only a partial match can perform input", () => {
  const capture = snapshot([
    node("button", { text: "Email", clickable: true }),
    node("field", { text: "Email address", editable: true, class: "android.widget.EditText" }),
  ]);
  const result = resolver.resolve(capture, { text: "Email" }, { action: "input" });
  expect(result.matchMode).toBe("contains");
  expect(result.chosen?.nativeId).toBe("field");
  expect(
    resolver.resolve(capture, { text: "Email", match: "exact" }, { action: "input" }).chosen,
  ).toBeNull();
});

test("bare node key wins before a namespace suffix peer", () => {
  const capture = snapshot([
    node("app:id/save", { clickable: true, bounds: { left: 0, top: 0, right: 10, bottom: 10 } }),
    { "view-id": "save", clickable: true, bounds: { left: 0, top: 0, right: 100, bottom: 100 } },
  ]);
  const result = resolver.resolve(capture, { elementId: "save" }, tap);
  expect(result.matches.map((entry) => entry.kind)).toEqual(["node-key-exact"]);
  expect(result.chosen?.nodeKey).toBe("save");
});

test.each(["testTag", "className"] as const)("%s rejects unsupported match modes", (field) => {
  for (const match of ["contains", "regex"] as const) {
    expect(resolverSelectorSchema.safeParse({ [field]: "save", match }).success).toBe(false);
  }
  expect(resolverSelectorSchema.safeParse({ [field]: "save", match: "exact" }).success).toBe(true);
});

test("sibling anchors honor their random strategy within outer container", () => {
  const capture = snapshot([
    list("outside"),
    node("inside", { node: [row("first"), row("last")] }),
  ]);
  const result = new ElementResolver(() => 0).resolve(
    capture,
    {
      elementId: "remove",
      container: { elementId: "inside" },
      sibling: { text: "Email", selectionStrategy: "random" },
    },
    tap,
  );
  expect(result.chosen).not.toBeNull();
  expect(capture.nodes.find((n) => n.nativeId === "first")).toBeDefined();
  expect(result.chosen?.parentIndex).toBe(capture.nodes.find((n) => n.nativeId === "first")?.index);
});

test("sibling anchors honor recursively nested sibling selectors", () => {
  const capture = snapshot([
    node("first", {
      node: [
        node("label1", { text: "Email" }),
        node("marker1", { text: "Other" }),
        node("remove", { clickable: true }),
      ],
    }),
    node("second", {
      node: [
        node("label2", { text: "Email" }),
        node("marker2", { text: "Chosen" }),
        node("remove", { clickable: true }),
      ],
    }),
  ]);
  const result = resolver.resolve(
    capture,
    { elementId: "remove", sibling: { text: "Email", sibling: { text: "Chosen" } } },
    tap,
  );
  expect(result.chosen?.parentIndex).toBe(
    capture.nodes.find((n) => n.nativeId === "second")?.index,
  );
});

test("random selects eligible action targets but preserves ranked match indexes", () => {
  const capture = snapshot([
    node("tap", { text: "Value", clickable: true }),
    node("input", { text: "Value", editable: true, class: "android.widget.EditText" }),
  ]);
  const result = resolver.resolve(
    capture,
    { text: "Value", selectionStrategy: "random" },
    { action: "input" },
  );
  expect(result.chosen?.nativeId).toBe("input");
  expect(result.indexInMatches).toBe(1);
  expect(
    resolver.resolve(capture, { text: "Value", index: 0 }, { action: "input" }).chosen,
  ).toBeNull();
});

test("focus prefers a partial editable input over an exact inert label", () => {
  const capture = snapshot([
    node("label", { text: "Email" }),
    node("input", { text: "Email address", editable: true, class: "android.widget.EditText" }),
  ]);
  expect(resolver.resolve(capture, { text: "Email" }, { action: "input" }).chosen?.nativeId).toBe(
    "input",
  );
});

test.each(["drag", "highlight"] as const)(
  "%s keeps a bounded text child instead of its clickable row",
  (action) => {
    const capture = snapshot([
      node("row", {
        clickable: true,
        node: [node("label", { text: "Move", bounds: { left: 5, top: 5, right: 20, bottom: 20 } })],
      }),
    ]);
    expect(resolver.resolve(capture, { text: "Move" }, { action }).chosen?.nativeId).toBe("label");
  },
);

test.each(["app:id/s.*", "["])("element ID regex is rejected honestly: %s", (elementId) => {
  expect(resolverSelectorSchema.safeParse({ elementId, match: "regex" }).success).toBe(false);
  const result = resolver.resolve(
    snapshot([node("app:id/save", { clickable: true })]),
    { elementId, match: "regex" },
    tap,
  );
  expect(result.error).toContain("regular expressions");
  expect(result.chosen).toBeNull();
});

test("sibling promotion cannot collapse anchors into the outer container", () => {
  const capture = snapshot([
    node("outer", {
      clickable: true,
      node: [
        node("first", {
          node: [node("first-label", { text: "Email" }), node("remove", { clickable: true })],
        }),
        node("second", {
          node: [node("second-label", { text: "Email" }), node("remove", { clickable: true })],
        }),
      ],
    }),
  ]);
  const result = resolver.resolve(
    capture,
    {
      elementId: "remove",
      container: { elementId: "outer" },
      sibling: { text: "Email", index: 1 },
    },
    tap,
  );
  expect(result.chosen?.parentIndex).toBe(
    capture.nodes.find((n) => n.nativeId === "second")?.index,
  );
});

test("positional candidates exclude offscreen controls while keeping visible action differences", () => {
  const capture = snapshot([
    node("offscreen", {
      text: "Value",
      clickable: true,
      bounds: { left: 0, top: 150, right: 100, bottom: 200 },
    }),
    node("visible-tap", { text: "Value", clickable: true }),
    node("visible-input", { text: "Value", editable: true, class: "android.widget.EditText" }),
  ]);
  const intent = { action: "input" as const, viewport: { width: 100, height: 100 } };
  const first = resolver.resolve(capture, { text: "Value", index: 0 }, intent);
  expect(first.candidates.map((n) => n.nativeId)).toEqual(["visible-tap", "visible-input"]);
  expect(first.chosen).toBeNull();
  const second = resolver.resolve(capture, { text: "Value", index: 1 }, intent);
  expect(second.chosen?.nativeId).toBe("visible-input");
  expect(second.indexInMatches).toBe(1);
  const random = resolver.resolve(capture, { text: "Value", selectionStrategy: "random" }, intent);
  expect(random.chosen?.nativeId).toBe("visible-input");
  expect(random.indexInMatches).toBe(1);
});

test("sibling traversal crosses multi-label wrappers but not collection rows", () => {
  const capture = snapshot([
    node("list", {
      class: "RecyclerView",
      node: [
        node("row", {
          node: [
            node("content", {
              node: [node("label", { text: "Email" }), node("subtitle", { text: "Personal" })],
            }),
            node("remove", { clickable: true }),
          ],
        }),
      ],
    }),
  ]);
  expect(
    resolver.resolve(capture, { elementId: "remove", sibling: { text: "Email" } }, tap).chosen
      ?.nativeId,
  ).toBe("remove");
});

test("unlabelled toggles inherit the displayed owning row label", () => {
  const capture = snapshot([
    node("row", {
      clickable: true,
      node: [node("label", { text: "Airplane mode" }), node("switch", { checkable: true })],
    }),
  ]);
  expect(resolver.resolve(capture, { text: "Airplane mode", index: 1 }, tap).chosen?.nativeId).toBe(
    "switch",
  );
});

test("unbounded wrappers do not steal a toggle's displayed row label", () => {
  const capture = snapshot([
    node("row", {
      text: "Airplane mode",
      clickable: true,
      node: [
        node("wrapper", {
          text: "Hidden wrapper",
          bounds: undefined,
          node: [node("switch", { checkable: true })],
        }),
      ],
    }),
  ]);
  expect(resolver.resolve(capture, { text: "Airplane mode", index: 1 }, tap).chosen?.nativeId).toBe(
    "switch",
  );
});

test("iOS table cells are sibling rows rather than collection boundaries", () => {
  const capture = snapshot([
    node("table", {
      class: "UITableView",
      node: [
        node("cell", {
          class: "UITableViewCell",
          node: [node("label", { text: "Email" }), node("remove", { clickable: true })],
        }),
      ],
    }),
  ]);
  expect(
    resolver.resolve(capture, { elementId: "remove", sibling: { text: "Email" } }, tap).chosen
      ?.nativeId,
  ).toBe("remove");
});

test("observation keeps legacy main-first order until live actions use the resolver", () => {
  const main = node("open", { text: "Open", clickable: true });
  const dialog = node("open", {
    text: "Open",
    clickable: true,
    bounds: { left: 10, top: 10, right: 50, bottom: 50 },
  });
  const hierarchy = {
    hierarchy: { node: [main] },
    windows: [{ windowLayer: 10, hierarchy: { node: [dialog] } }],
  } as any;
  const observed = projectSkeleton(
    new DefaultObserveElementCollector().collect(hierarchy, "android")!,
  ).skeleton;
  expect(observed.map((row) => row.bounds)).toEqual([
    [0, 0, 100, 100],
    [10, 10, 50, 50],
  ]);
  expect(observed.map((row) => row.index)).toEqual([0, 1]);
});

test("sibling traversal includes the explicit container but cannot cross its boundary", () => {
  const capture = snapshot([
    node("outer", { node: [row("inside"), node("elsewhere", { clickable: true })] }),
  ]);
  expect(
    resolver.resolve(
      capture,
      { elementId: "remove", container: { elementId: "inside" }, sibling: { text: "Email" } },
      tap,
    ).chosen?.nativeId,
  ).toBe("remove");
  expect(
    resolver.resolve(
      capture,
      { elementId: "elsewhere", container: { elementId: "inside" }, sibling: { text: "Email" } },
      tap,
    ).chosen,
  ).toBeNull();
});

test("sibling traversal never crosses collection boundaries to another row", () => {
  const capture = snapshot([
    node("list", {
      className: "UICollectionView",
      node: [
        node("first", { node: [node("label", { text: "Email" })] }),
        node("second", { node: [node("remove", { clickable: true })] }),
      ],
    }),
  ]);
  expect(
    resolver.resolve(capture, { elementId: "remove", sibling: { text: "Email" } }, tap).chosen,
  ).toBeNull();
});

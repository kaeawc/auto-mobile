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

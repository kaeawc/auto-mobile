import { expect, test } from "bun:test";
import { ElementResolver } from "../../../src/features/utility/ElementResolver";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
const snapshot = (nodes: object[]) => ({
  id: "capture",
  nodes: new SearchableHierarchy().project({
    hierarchy: {
      node: nodes.map((node) => ({ bounds: { left: 0, top: 0, right: 20, bottom: 20 }, ...node })),
    },
  }),
});
test("description selectors exclude visible text-only matches", () => {
  const result = new ElementResolver().resolve(
    snapshot([{ text: "Save" }, { "content-desc": "Save" }, { "ios-accessibility-label": "Save" }]),
    { contentDescription: "Save" },
    { action: "inspect" },
  );
  expect(result.candidates).toHaveLength(2);
});
test("regex preserves syntax while normalizing curly quotes", () => {
  const result = new ElementResolver().resolve(
    snapshot([{ text: "Don’t panic" }]),
    { text: "^Don't.*$", match: "regex" },
    { action: "inspect" },
  );
  expect(result.chosen).not.toBeNull();
  expect(result.matches[0].kind).toBe("regex");
});
test("empty tap selectors enumerate only eligible action nodes", () => {
  const result = new ElementResolver().resolve(
    snapshot([{ text: "label" }, { text: "button", clickable: true }]),
    { index: 0 },
    { action: "tap" },
  );
  expect(result.candidates).toHaveLength(1);
  expect(result.chosen?.label).toBe("button");
});
test("accessibility focus accepts bounded native nodes without keyboard focus", () => {
  expect(
    new ElementResolver().resolve(
      snapshot([{ "resource-id": "app:id/item" }]),
      { elementId: "item" },
      { action: "accessibility-focus", requireResourceId: true },
    ).chosen,
  ).not.toBeNull();
});

test("promoted long-press targets retain their original candidate index", () => {
  const capture = snapshot([
    {
      "long-clickable": true,
      children: [{ text: "Hold", bounds: { left: 1, top: 1, right: 10, bottom: 10 } }],
    },
  ]);
  const result = new ElementResolver().resolve(
    capture,
    { text: "Hold", index: 0 },
    { action: "long-press" },
  );
  expect(result.chosen).not.toBeNull();
  expect(result.indexInMatches).toBe(0);
});

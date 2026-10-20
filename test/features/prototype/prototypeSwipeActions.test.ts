import { expect, test } from "bun:test";
import {
  prototypeSwipeActionFields,
  prototypeSwipeActionsUnsupportedMessage,
} from "../../../src/features/prototype/prototypeSwipeActions";
import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const emit = { type: "emit", name: "go" };
const swipe = { end: [{ label: "Delete", onTap: [emit] }] };
const wrap = (root: object) => ({ id: "s", window: { placement: { type: "fullscreen" } }, root });
const item = { type: "listItem", headline: "Order", swipeActions: swipe };

test("discovery lists row and listItem swipeActions in templates and components, not payloads", () => {
  const spec = {
    root: {
      type: "column",
      repeat: { as: "o", items: [{ id: 1 }] },
      children: [item],
      onTap: [{ ...emit, payload: { type: "row", swipeActions: swipe } }],
    },
    components: { r: { root: { type: "row", children: [], swipeActions: swipe } } },
  };
  expect(prototypeSwipeActionFields(spec)).toEqual([
    "root.children[0].swipeActions",
    "components.r.root.swipeActions",
  ]);
  expect(prototypeSwipeActionFields(null)).toEqual([]);
});

test("a swipe needs an action side and is refused inside a horizontal pager or carousel", () => {
  expect(validatePrototypeSpec(wrap({ type: "column", children: [item] })).success).toBe(true);
  const empty = validatePrototypeSpec(
    wrap({ type: "column", children: [{ ...item, swipeActions: {} }] }),
  );
  expect(empty.success ? "" : empty.error.path).toBe("root.children[0].swipeActions");
  for (const container of [
    { type: "pager", id: "p", children: [{ type: "column", children: [item] }] },
    {
      type: "pager",
      id: "p",
      axis: "horizontal",
      children: [{ type: "column", children: [item] }],
    },
    { type: "carousel", itemWidth: 100, children: [{ type: "column", children: [item] }] },
  ]) {
    const result = validatePrototypeSpec(wrap(container));
    expect(result.success ? "" : result.error.path).toBe(
      "root.children[0].children[0].swipeActions",
    );
  }
  expect(
    validatePrototypeSpec(
      wrap({
        type: "pager",
        id: "p",
        axis: "vertical",
        children: [{ type: "column", children: [item] }],
      }),
    ).success,
  ).toBe(true);
});

test("swipe action labels and actions bind repeat placeholders like onTap", () => {
  const bound = bindNodeFields(
    {
      type: "listItem",
      headline: "{o.id}",
      swipeActions: {
        start: [{ label: "Pin {o.id}", onTap: [{ type: "toggle", key: "pinned_{o.id}" }] }],
        end: [{ label: "Delete {o.id}", onTap: [{ type: "emit", name: "delete_{o.id}" }] }],
      },
    },
    "root",
    { binding: { alias: "o", index: false }, values: { id: 7 }, index: 0 },
  );
  expect(bound.swipeActions).toEqual({
    start: [{ label: "Pin 7", onTap: [{ type: "toggle", key: "pinned_7" }] }],
    end: [{ label: "Delete 7", onTap: [{ type: "emit", name: "delete_7" }] }],
  });
});

test("the refusal names the capability and the platform's update step", () => {
  expect(prototypeSwipeActionsUnsupportedMessage(["root.swipeActions"], "android")).toContain(
    "prototype_swipe_actions_v1",
  );
  expect(prototypeSwipeActionsUnsupportedMessage(["a", "b"], "ios")).toContain("(and 1 more)");
});

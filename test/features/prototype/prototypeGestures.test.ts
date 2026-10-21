import { expect, test } from "bun:test";
import { prototypeGestureFields } from "../../../src/features/prototype/prototypeGestures";
import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const emit = { type: "emit", name: "gesture" };
test("gesture discovery visits root, repeat templates and component definitions without payloads", () => {
  const spec = {
    root: {
      type: "column",
      repeat: { items: [{ id: 7 }], as: "item" },
      onDoubleTap: [emit],
      children: [
        { type: "text", text: "x", onLongPress: [emit] },
        {
          type: "scroll",
          child: { type: "card", children: [], onLongPress: [emit] },
        },
      ],
      onTap: [{ ...emit, payload: { type: "text", onLongPress: [emit] } }],
    },
    components: { tile: { root: { type: "row", children: [], onDoubleTap: [emit] } } },
  };
  expect(prototypeGestureFields(spec)).toEqual([
    "root.onDoubleTap",
    "root.children[0].onLongPress",
    "root.children[1].child.onLongPress",
    "components.tile.root.onDoubleTap",
  ]);
  expect(prototypeGestureFields(null)).toEqual([]);
  expect(prototypeGestureFields({ root: { type: "button", onLongPress: [emit] } })).toEqual([]);
});

test.each(["onLongPress", "onDoubleTap"])(
  "%s binds repeat and component actions like onTap",
  (field) => {
    const actions = [
      { type: "setState", key: "picked_{item.id}", value: "{item.value}" },
      { type: "toggle", key: "liked_{item.id}" },
      { type: "emit", name: "pick_{item.id}" },
    ];
    const binding = { alias: "item", index: true };
    const bound = bindNodeFields({ type: "text", onTap: actions, [field]: actions }, "root", {
      binding,
      values: { id: 7, value: true },
      index: 0,
    });
    expect(bound[field]).toEqual(bound.onTap);
    expect(bound[field]).toEqual([
      { type: "setState", key: "picked_7", value: true },
      { type: "toggle", key: "liked_7" },
      { type: "emit", name: "pick_7" },
    ]);
    expect(
      bindNodeFields({ type: "text", [field]: [{ type: "toggle", key: "{props.key}" }] }, "root", {
        binding: { alias: "props", index: false },
        values: { key: "liked" },
      })[field],
    ).toEqual([{ type: "toggle", key: "liked" }]);
  },
);

test.each(["onLongPress", "onDoubleTap"])(
  "%s receives the existing state-binding checks",
  (field) => {
    expect(
      validatePrototypeSpec({
        id: "state",
        window: { placement: { type: "fullscreen" } },
        root: { type: "text", text: "x", [field]: [{ type: "toggle", key: "missing" }] },
      }),
    ).toMatchObject({ success: false, error: { path: `root.${field}[0].key` } });
  },
);

test("onTap-only specs retain their decoded shape and need no gesture capability", () => {
  const spec = {
    id: "plain",
    window: { placement: { type: "fullscreen" } },
    root: { type: "text", text: "x", onTap: [emit] },
  };
  expect(validatePrototypeSpec(spec)).toMatchObject({ success: true, data: spec });
  expect(prototypeGestureFields(spec)).toEqual([]);
});

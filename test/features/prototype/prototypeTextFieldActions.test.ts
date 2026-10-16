import { expect, test } from "bun:test";
import {
  prototypeTextFieldActionFields,
  prototypeTextFieldActionsUnsupportedMessage,
  prototypeTextFieldOptionFields,
} from "../../../src/features/prototype/prototypeTextFieldOptions";
import { bindNodeFields } from "../../../src/features/prototype/prototypeTemplate";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const emit = { type: "emit", name: "go" };
const trailing = { icon: "close", label: "Clear", onTap: [emit] };
const spec = (field: object, state: object = { q: "x" }) => ({
  id: "t",
  window: { placement: { type: "fullscreen" } },
  state,
  root: { type: "textField", stateKey: "q", ...field },
});

test("action discovery is separate from option discovery and covers templates and components", () => {
  const tree = {
    root: {
      type: "column",
      children: [
        { type: "textField", stateKey: "q", label: "Q", trailingIcon: trailing },
        { type: "textField", stateKey: "q", imeAction: "go", onSubmit: [emit] },
        { type: "searchBar", stateKey: "q", onSubmit: [emit], child: { type: "spacer" } },
      ],
    },
    components: { f: { root: { type: "textField", stateKey: "q", onSubmit: [emit] } } },
  };
  expect(prototypeTextFieldActionFields(tree)).toEqual([
    "root.children[0].trailingIcon",
    "root.children[1].imeAction",
    "root.children[1].onSubmit",
    "components.f.root.onSubmit",
  ]);
  expect(prototypeTextFieldOptionFields(tree)).toEqual(["root.children[0].label"]);
});

test("trailing icon, IME action and submit actions validate; multiline refuses the IME fields", () => {
  expect(
    validatePrototypeSpec(spec({ trailingIcon: trailing, imeAction: "search", onSubmit: [emit] }))
      .success,
  ).toBe(true);
  for (const [field, path] of [
    [{ multiline: true, imeAction: "done" }, "root.imeAction"],
    [{ multiline: true, onSubmit: [emit] }, "root.onSubmit"],
    [{ imeAction: "previous" }, "root.imeAction"],
    [{ trailingIcon: { icon: "close" } }, "root.trailingIcon.label"],
    [{ onSubmit: [] }, "root.onSubmit"],
  ] as const) {
    const result = validatePrototypeSpec(spec(field));
    expect(result.success ? "" : result.error.path).toBe(path);
  }
});

test("trailing icon and submit actions bind repeat placeholders like onTap", () => {
  const bound = bindNodeFields(
    {
      type: "textField",
      stateKey: "q_{item.id}",
      trailingIcon: {
        icon: "close",
        label: "Clear {item.id}",
        onTap: [{ type: "setState", key: "q_{item.id}", value: "" }],
      },
      onSubmit: [{ type: "emit", name: "submit_{item.id}" }],
    },
    "root",
    { binding: { alias: "item", index: false }, values: { id: 7 }, index: 0 },
  );
  expect(bound.trailingIcon).toEqual({
    icon: "close",
    label: "Clear 7",
    onTap: [{ type: "setState", key: "q_7", value: "" }],
  });
  expect(bound.onSubmit).toEqual([{ type: "emit", name: "submit_7" }]);
});

test("the refusal names the capability, the first path and the platform's update step", () => {
  const message = prototypeTextFieldActionsUnsupportedMessage(
    ["root.imeAction", "root.onSubmit"],
    "ios",
  );
  expect(message).toContain("prototype_text_field_actions_v1");
  expect(message).toContain("root.imeAction (and 1 more)");
  expect(message).toContain("launchApp prototype: true");
});

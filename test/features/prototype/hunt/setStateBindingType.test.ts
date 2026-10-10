import { describe, expect, test } from "bun:test";
import { validatePrototypeSpec } from "../../../../src/features/prototype/prototypeValidation";

/**
 * The host refuses toggle/increment/decrement on a mistyped key but not setState, although
 * docs/design-docs/plat/android/prototype-ux.md says setState must preserve a binding's scalar
 * type and that "the validators should refuse at show" a setState whose value type does not fit a
 * control bound to the key. The iOS agent does not re-validate at runtime, so the host is the only
 * gate on iOS; on Android the runtime silently rejects the whole tap.
 */
function spec(state: Record<string, string | number | boolean>, control: unknown, value: unknown) {
  return {
    id: "a",
    window: { placement: { type: "fullscreen" } },
    state,
    root: {
      type: "column",
      children: [
        control,
        {
          type: "button",
          label: "Go",
          onTap: [{ type: "setState", key: "k", value }],
        },
      ],
    },
  };
}

const cases: Array<[string, Record<string, string | number | boolean>, unknown, unknown]> = [
  ["switch bound to a boolean", { k: true }, { type: "switch", stateKey: "k", label: "S" }, "yes"],
  ["checkbox bound to a boolean", { k: true }, { type: "checkbox", stateKey: "k", label: "C" }, 1],
  ["textField bound to a string", { k: "x" }, { type: "textField", stateKey: "k" }, 5],
  [
    "slider bound to a number",
    { k: 1 },
    { type: "slider", stateKey: "k", min: 0, max: 10 },
    "high",
  ],
  [
    "slider bound to a number, out of range",
    { k: 1 },
    { type: "slider", stateKey: "k", min: 0, max: 10 },
    99,
  ],
  [
    "radioGroup bound to a string",
    { k: "a" },
    {
      type: "radioGroup",
      stateKey: "k",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
    true,
  ],
];

describe("setState value type against the control bound to its key", () => {
  test.each(cases)("%s is refused at show", (_name, state, control, value) => {
    const result = validatePrototypeSpec(spec(state, control, value));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.path).toBe("root.children[1].onTap[0].value");
    }
  });
});

import { expect, test } from "bun:test";
import { getFocusedTextLength } from "../../../src/features/action/ClearText";
const capture = (node: object) => ({ hierarchy: { node } });
test("focused text length uses editable captured value and preserves empty values", () => {
  expect(
    getFocusedTextLength(
      capture({ focused: true, actions: ["set_text"], value: "Actual value", text: "Hint" }),
    ),
  ).toBe(12);
  expect(
    getFocusedTextLength(
      capture({ focused: true, actions: ["set_text"], value: "", text: "Hint" }),
    ),
  ).toBe(0);
  expect(getFocusedTextLength(capture({ focused: true, text: "" }))).toBe(0);
  expect(getFocusedTextLength(capture({ focused: true }))).toBeUndefined();
});

import { expect, test } from "bun:test";
import { getFocusedTextLength, hasFocusedTextInput } from "../../../src/features/action/ClearText";
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

test("focused dialog field length is found in a secondary window", () => {
  const hierarchy = {
    hierarchy: { node: [] },
    windows: [
      {
        windowLayer: 5,
        hierarchy: {
          node: [
            {
              $: {
                class: "android.widget.EditText",
                focused: "true",
                text: "Dialog text",
              },
            },
          ],
        },
      },
      {
        windowLayer: 0,
        hierarchy: { node: [{ $: { class: "android.widget.TextView", text: "Behind dialog" } }] },
      },
    ],
  };

  expect(getFocusedTextLength(hierarchy)).toBe("Dialog text".length);
  expect(hasFocusedTextInput(hierarchy)).toBe(true);
});

test("focused field in the topmost window wins over a longer field below", () => {
  const hierarchy = {
    hierarchy: { node: [] },
    windows: [
      {
        windowLayer: 0,
        hierarchy: {
          node: [
            {
              $: {
                class: "android.widget.EditText",
                focused: true,
                text: "longer lower value",
              },
            },
          ],
        },
      },
      {
        windowLayer: 5,
        hierarchy: {
          node: [
            {
              $: { class: "android.widget.EditText", focused: true, text: "top" },
            },
          ],
        },
      },
    ],
  };

  expect(getFocusedTextLength(hierarchy)).toBe(3);
});

test("primary-window-only hierarchy still supplies the focused field length", () => {
  expect(getFocusedTextLength(capture({ focused: true, text: "Primary window" }))).toBe(14);
});

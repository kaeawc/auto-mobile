import { expect, test } from "bun:test";
import {
  getFocusedTextLength,
  hasFocusedTextInput,
  verifyKeyEventClear,
} from "../../../src/features/action/ClearText";
const capture = (node: object) => ({ hierarchy: { node } });

test.each([
  { text: "Type here", hint: "Type here", remaining: 0 },
  { text: "actual", hint: "Type here", remaining: 6 },
  { text: "actual", hint: undefined, remaining: 6 },
  { text: "actual", hint: "", remaining: 6 },
  { text: "Type here ", hint: "Type here", remaining: 10 },
])(
  "key-event clear verification distinguishes Android hints: %j",
  async ({ text, hint, remaining }) => {
    const hierarchy = capture({
      class: "android.widget.EditText",
      focused: true,
      text,
      "hint-text": hint,
    });
    expect(
      await verifyKeyEventClear(async () => ({ timestamp: 0, viewHierarchy: hierarchy })),
    ).toEqual(
      remaining === 0
        ? { success: true }
        : {
            success: false,
            error: `Field was not fully cleared: ${remaining} UTF-16 units remain`,
          },
    );
    expect(getFocusedTextLength(hierarchy)).toBe(remaining);
    expect(getFocusedTextLength(hierarchy, undefined, true)).toBe(text.length);
  },
);

test("key-event clear verification keeps an empty Compose field without captured text unreadable", async () => {
  const hierarchy = capture({ focused: true, actions: ["set_text"] });
  expect(getFocusedTextLength(hierarchy)).toBeUndefined();
  expect(
    await verifyKeyEventClear(async () => ({ timestamp: 0, viewHierarchy: hierarchy })),
  ).toEqual({
    success: false,
    error: "Cannot verify key-event clear: focused field text length is unreadable",
  });
});

test("focused iOS text equal to its placeholder remains real text", () => {
  expect(
    getFocusedTextLength(
      capture({
        class: "UITextField",
        focused: true,
        actions: ["set_text"],
        value: "Hint",
        "hint-text": "Hint",
      }),
    ),
  ).toBe(4);
});
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

import { describe, expect, test } from "bun:test";
import {
  DefaultFocusedInputQuery,
  isElementKeyboardFocused,
} from "../../../src/features/utility/FocusedInput";
import {
  DefaultClickableElementsQuery,
  DefaultScrollableElementsQuery,
} from "../../../src/features/utility/InteractiveElementQueries";
import type { ViewHierarchyResult } from "../../../src/models";

const bounds = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});

function makeHierarchy(nodes: Record<string, unknown>[]): ViewHierarchyResult {
  return {
    hierarchy: { node: { $: { bounds: bounds(0, 0, 1080, 1920) }, node: nodes } },
  };
}

/** Main hierarchy plus two windows; window layer 5 is topmost. */
function makeWindowedHierarchy(
  main: Record<string, unknown>[],
  lower: Record<string, unknown>[],
  upper: Record<string, unknown>[],
): ViewHierarchyResult {
  return {
    ...makeHierarchy(main),
    windows: [
      { windowLayer: 1, hierarchy: { node: lower } },
      { windowLayer: 5, hierarchy: { node: upper } },
    ],
  };
}

const ids = (elements: { "resource-id"?: string }[]) => elements.map((e) => e["resource-id"]);

describe("DefaultScrollableElementsQuery", () => {
  const query = new DefaultScrollableElementsQuery();

  test("returns empty for a missing hierarchy", () => {
    expect(query.findScrollableElements(null as unknown as ViewHierarchyResult)).toEqual([]);
  });

  test("returns empty when nothing scrolls", () => {
    const hierarchy = makeHierarchy([{ $: { text: "Label", bounds: bounds(0, 0, 100, 50) } }]);
    expect(query.findScrollableElements(hierarchy)).toEqual([]);
  });

  test("accepts string and boolean scrollable flags and skips unbounded nodes", () => {
    const hierarchy = makeHierarchy([
      { $: { "resource-id": "string", scrollable: "true", bounds: bounds(0, 0, 100, 100) } },
      { $: { "resource-id": "boolean", scrollable: true, bounds: bounds(0, 100, 100, 200) } },
      { $: { "resource-id": "unbounded", scrollable: "true" } },
      { $: { "resource-id": "static", scrollable: "false", bounds: bounds(0, 200, 100, 300) } },
    ]);
    expect(ids(query.findScrollableElements(hierarchy))).toEqual(["string", "boolean"]);
  });

  test("orders main-hierarchy matches before window matches, windows topmost-first", () => {
    const scrollable = (id: string) => ({
      $: { "resource-id": id, scrollable: "true", bounds: bounds(0, 0, 100, 100) },
    });
    const hierarchy = makeWindowedHierarchy(
      [scrollable("main")],
      [scrollable("lower")],
      [scrollable("upper")],
    );
    expect(ids(query.findScrollableElements(hierarchy))).toEqual(["main", "upper", "lower"]);
  });
});

describe("DefaultClickableElementsQuery", () => {
  const query = new DefaultClickableElementsQuery();

  test("returns empty for a missing hierarchy", () => {
    expect(query.findClickableElements(null as unknown as ViewHierarchyResult)).toEqual([]);
  });

  test("keeps clickable nodes and drops non-clickable ones", () => {
    const hierarchy = makeHierarchy([
      { $: { "resource-id": "button", clickable: "true", bounds: bounds(0, 0, 100, 50) } },
      { $: { "resource-id": "label", clickable: "false", bounds: bounds(0, 50, 100, 100) } },
    ]);
    expect(ids(query.findClickableElements(hierarchy))).toEqual(["button"]);
  });

  test("treats click accessibility actions as clickable", () => {
    const hierarchy = makeHierarchy([
      { $: { actions: ["click"], "resource-id": "icon_button", bounds: bounds(0, 0, 100, 50) } },
      { $: { actions: ["focus"], "resource-id": "focus_only", bounds: bounds(0, 50, 100, 100) } },
    ]);
    expect(ids(query.findClickableElements(hierarchy))).toEqual(["icon_button"]);
  });

  test("orders main-hierarchy matches before window matches, windows topmost-first", () => {
    const clickable = (id: string) => ({
      $: { "resource-id": id, clickable: "true", bounds: bounds(0, 0, 100, 100) },
    });
    const hierarchy = makeWindowedHierarchy(
      [clickable("main")],
      [clickable("lower")],
      [clickable("upper")],
    );
    expect(ids(query.findClickableElements(hierarchy))).toEqual(["main", "upper", "lower"]);
  });
});

describe("DefaultFocusedInputQuery", () => {
  const query = new DefaultFocusedInputQuery();
  const input = (id: string, extra: Record<string, unknown> = {}) => ({
    $: {
      "resource-id": id,
      class: "android.widget.EditText",
      bounds: bounds(0, 0, 100, 50),
      ...extra,
    },
  });

  test("returns null when no input is focused", () => {
    const hierarchy = makeHierarchy([input("unfocused", { focused: "false" })]);
    expect(query.findFocusedTextInput(hierarchy)).toBeNull();
  });

  test("ignores a focused node that is not a text input", () => {
    const hierarchy = makeHierarchy([
      {
        $: {
          "resource-id": "button",
          class: "android.widget.Button",
          focused: "true",
          bounds: bounds(0, 0, 100, 50),
        },
      },
    ]);
    expect(query.findFocusedTextInput(hierarchy)).toBeNull();
  });

  test("matches the className spelling and a boolean focused flag", () => {
    const hierarchy = makeHierarchy([
      {
        $: {
          "resource-id": "compose_input",
          className: "android.widget.EditText",
          focused: true,
          bounds: bounds(0, 0, 100, 50),
        },
      },
    ]);
    expect(query.findFocusedTextInput(hierarchy)?.["resource-id"]).toBe("compose_input");
  });

  test("does not treat a selected input as focused", () => {
    const hierarchy = makeHierarchy([input("selected", { selected: "true" })]);
    expect(query.findFocusedTextInput(hierarchy)).toBeNull();
  });

  test("prefers the main hierarchy, then the topmost window", () => {
    const focused = (id: string) => input(id, { focused: "true" });
    expect(
      query.findFocusedTextInput(
        makeWindowedHierarchy([focused("main")], [focused("lower")], [focused("upper")]),
      )?.["resource-id"],
    ).toBe("main");
    expect(
      query.findFocusedTextInput(
        makeWindowedHierarchy([], [focused("lower")], [focused("upper")]),
      )?.["resource-id"],
    ).toBe("upper");
  });
});

describe("isElementKeyboardFocused", () => {
  test("does not treat selection as keyboard focus", () => {
    expect(isElementKeyboardFocused({ selected: "true" })).toBe(false);
    expect(isElementKeyboardFocused({ selected: true })).toBe(false);
  });

  test("returns true for keyboard focus attributes", () => {
    expect(isElementKeyboardFocused({ focused: "true" })).toBe(true);
    expect(isElementKeyboardFocused({ focused: true })).toBe(true);
    expect(isElementKeyboardFocused({ isFocused: "true" })).toBe(true);
    expect(isElementKeyboardFocused({ isFocused: true })).toBe(true);
    expect(isElementKeyboardFocused({ "has-keyboard-focus": "true" })).toBe(true);
    expect(isElementKeyboardFocused({ "has-keyboard-focus": true })).toBe(true);
  });

  test("returns true for Android accessibility focus spellings", () => {
    expect(isElementKeyboardFocused({ "accessibility-focused": "true" })).toBe(true);
    expect(isElementKeyboardFocused({ accessibilityFocused: true })).toBe(true);
  });

  test("returns false without a true focus attribute", () => {
    expect(
      isElementKeyboardFocused({
        focused: "false",
        isFocused: false,
        "has-keyboard-focus": "false",
        "accessibility-focused": false,
        accessibilityFocused: "false",
      }),
    ).toBe(false);
    expect(isElementKeyboardFocused({})).toBe(false);
  });
});

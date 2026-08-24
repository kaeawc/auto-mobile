import { describe, expect, test } from "bun:test";
import { LongPressMetadataDetector } from "../../../src/features/action/LongPressMetadataDetector";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";

const detector = new LongPressMetadataDetector(new DefaultElementParser());

/** Build an ObserveResult wrapping a single-root hierarchy. */
const observation = (root: any): ObserveResult =>
  ({ viewHierarchy: { hierarchy: { node: root } } as ViewHierarchyResult }) as ObserveResult;

const node = (attrs: Record<string, unknown>, children?: any[]) => ({
  $: attrs,
  ...(children ? { node: children } : {}),
});

describe("LongPressMetadataDetector", () => {
  test("returns all-false when nothing changed", () => {
    const root = node({ "resource-id": "root", class: "FrameLayout", bounds: "[0,0][100,100]" });
    const result = detector.detect(observation(root), observation(root));
    expect(result).toEqual({
      pressRecognized: false,
      contextMenuOpened: false,
      selectionStarted: false,
    });
  });

  test("detects a context menu appearing as a new root with menu indicators", () => {
    const before = node({ "resource-id": "root", class: "FrameLayout", bounds: "[0,0][100,100]" });
    const after = node(
      { "resource-id": "popupWindow", class: "PopupMenu", bounds: "[10,10][90,90]" },
      [
        node({
          "resource-id": "menu_item_copy",
          class: "TextView",
          text: "Copy",
          bounds: "[10,10][50,30]",
        }),
      ],
    );
    const result = detector.detect(observation(before), observation(after));
    expect(result.contextMenuOpened).toBe(true);
    expect(result.pressRecognized).toBe(true);
  });

  test("detects text selection when a selection range becomes active", () => {
    const before = node({
      "resource-id": "field",
      class: "EditText",
      bounds: "[0,0][100,40]",
      text: "hello",
    });
    const after = node({
      "resource-id": "field",
      class: "EditText",
      bounds: "[0,0][100,40]",
      text: "hello",
      textSelectionStart: "0",
      textSelectionEnd: "5",
    });
    const result = detector.detect(observation(before), observation(after));
    expect(result.selectionStarted).toBe(true);
    expect(result.pressRecognized).toBe(true);
  });

  test("ignores a zero-width selection range", () => {
    const after = node({
      "resource-id": "field",
      class: "EditText",
      bounds: "[0,0][100,40]",
      selectionStart: "3",
      selectionEnd: "3",
    });
    const result = detector.detect(null, observation(after));
    expect(result.selectionStarted).toBe(false);
  });

  test("recognizes a press when a brand-new window appears (no menu, no selection)", () => {
    const before = node({ "resource-id": "root", class: "FrameLayout", bounds: "[0,0][100,100]" });
    const after = node({ "resource-id": "dialog", class: "AlertDialog", bounds: "[5,5][95,95]" });
    const result = detector.detect(observation(before), observation(after));
    expect(result.contextMenuOpened).toBe(false);
    expect(result.selectionStarted).toBe(false);
    expect(result.pressRecognized).toBe(true);
  });

  test("returns all-false when current observation is missing", () => {
    const before = node({ "resource-id": "root", class: "FrameLayout", bounds: "[0,0][100,100]" });
    const result = detector.detect(observation(before), undefined);
    expect(result).toEqual({
      pressRecognized: false,
      contextMenuOpened: false,
      selectionStarted: false,
    });
  });
});

import { describe, expect, test } from "bun:test";
import {
  deriveIosScreenIdentity,
  isIosKeyboardVisible,
} from "../../../../src/features/observe/ios/IosScreenIdentity";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import { viewHierarchyResultSchema } from "../../../../src/server/toolOutputSchemas";
import {
  iosKeyboardMinimizedHierarchy,
  iosKeyboardVisibleHierarchy,
} from "../../../fixtures/observe/iosKeyboardStates";

/**
 * Keyboard visibility on the captured Playground keyboard states (issue #10027):
 * `ios-keyboard-visible` has the UIKeyboard container at [0,590,402,816] on a
 * 402x874 screen; `ios-keyboard-minimized` has it parked at [0,918,402,1144],
 * below the bottom edge, with nothing drawn.
 */

/**
 * Mechanically derive a variant of the visible capture: every node inside the
 * UIKeyboard subtree (container included) moves down by `dy` points; nothing
 * else changes.
 */
function withKeyboardShiftedDown(source: ViewHierarchyResult, dy: number): ViewHierarchyResult {
  const shifted: unknown = structuredClone(source);
  const shift = (value: unknown, inKeyboard: boolean): void => {
    if (Array.isArray(value)) {
      value.forEach((child) => shift(child, inKeyboard));
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    const here = inKeyboard || ("className" in value && value.className === "UIKeyboard");
    if (here && "bounds" in value && Array.isArray(value.bounds)) {
      const [left, top, right, bottom] = value.bounds;
      value.bounds = [left, top + dy, right, bottom + dy];
    }
    if ("node" in value) {
      shift(value.node, here);
    }
    if ("hierarchy" in value) {
      shift(value.hierarchy, here);
    }
  };
  shift(shifted, false);
  return viewHierarchyResultSchema.required({ hierarchy: true }).parse(shifted);
}

describe("deriveIosScreenIdentity keyboard visibility on captured states (#10027)", () => {
  test("the visible capture reports keyboardVisible and a keyboard key part", () => {
    const identity = deriveIosScreenIdentity(iosKeyboardVisibleHierarchy);
    expect(identity?.components.keyboardVisible).toBe(true);
    expect(identity?.key).toContain('["keyboard","true"]');
    expect(isIosKeyboardVisible(iosKeyboardVisibleHierarchy)).toBe(true);
  });

  test("the minimized capture reports neither, matching keyboard: null", () => {
    const identity = deriveIosScreenIdentity(iosKeyboardMinimizedHierarchy);
    expect(identity).toBeDefined();
    expect(identity?.components).not.toHaveProperty("keyboardVisible");
    expect(identity?.key).not.toContain("keyboard");
    expect(isIosKeyboardVisible(iosKeyboardMinimizedHierarchy)).toBe(false);
  });

  test("the key differs between the keyboard on screen and parked on the same screen", () => {
    const onScreen = deriveIosScreenIdentity(iosKeyboardVisibleHierarchy);
    const parked = deriveIosScreenIdentity(
      withKeyboardShiftedDown(iosKeyboardVisibleHierarchy, 400),
    );
    expect(parked?.components).not.toHaveProperty("keyboardVisible");
    expect(parked?.key).not.toBe(onScreen?.key);
  });

  test("without a usable screen size the class-only reading is kept", () => {
    const sizeless: ViewHierarchyResult = {
      ...iosKeyboardMinimizedHierarchy,
      screenWidth: undefined,
      screenHeight: undefined,
    };
    expect(isIosKeyboardVisible(sizeless)).toBe(true);
    expect(deriveIosScreenIdentity(sizeless)?.components.keyboardVisible).toBe(true);
    // A caller-supplied screen restores the geometric reading.
    expect(isIosKeyboardVisible(sizeless, { width: 402, height: 874 })).toBe(false);
  });

  test("a one-point sliver is hidden but a two-point strip is visible", () => {
    // The container top lands at y=873 (1pt of an 874pt screen) and y=872 (2pt).
    expect(isIosKeyboardVisible(withKeyboardShiftedDown(iosKeyboardVisibleHierarchy, 283))).toBe(
      false,
    );
    expect(isIosKeyboardVisible(withKeyboardShiftedDown(iosKeyboardVisibleHierarchy, 282))).toBe(
      true,
    );
  });
});

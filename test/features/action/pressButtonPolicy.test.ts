import { describe, expect, test } from "bun:test";
import {
  isInPlacePressButton,
  isNavigationPressButton,
  resolveAndroidKeyCode,
} from "../../../src/features/action/pressButtonPolicy";

describe("pressButtonPolicy", () => {
  test("classifies navigation and in-place buttons", () => {
    expect(isNavigationPressButton("BACK")).toBe(true);
    expect(isNavigationPressButton("volume_up")).toBe(false);
    expect(isInPlacePressButton("Menu")).toBe(true);
    expect(isInPlacePressButton("home")).toBe(false);
  });

  test.each([
    ["home", 3],
    ["back", 4],
    ["menu", 82],
    ["power", 26],
    ["volume_up", 24],
    ["volume_down", 25],
    ["recent", 187],
  ])("resolves %s to keycode %i", (button, expected) => {
    expect(resolveAndroidKeyCode(button)).toBe(expected);
    expect(resolveAndroidKeyCode(button.toUpperCase())).toBe(expected);
  });

  // Issue #4187: the keycode map was a `{}` guarded by `!keyCode`, so a button named
  // after an `Object.prototype` member resolved to the truthy inherited member and
  // flowed into `shell input keyevent <function Object() { [native code] }>`.
  test.each([
    ["constructor"],
    ["toString"],
    ["valueOf"],
    ["hasOwnProperty"],
    ["__proto__"],
    // Control row: an ordinary unsupported button must behave identically.
    ["definitely_not_a_button"],
  ])("rejects the prototype-named button %s", (button) => {
    expect(resolveAndroidKeyCode(button)).toBeUndefined();
  });
});

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
    // The Action button runs a user-chosen shortcut and Camera Control opens the camera,
    // so both may change the foreground UI (#14100).
    expect(isNavigationPressButton("action")).toBe(true);
    expect(isNavigationPressButton("Camera")).toBe(true);
  });

  test.each([
    "lock",
    "power_dialog",
    "quick_settings",
    "screenshot",
    "split_screen",
    "dismiss_notification_shade",
  ])("%s is an Android system action with no keycode (#14095)", (button) => {
    expect(isNavigationPressButton(button)).toBe(true);
    expect(isNavigationPressButton(button.toUpperCase())).toBe(true);
    expect(resolveAndroidKeyCode(button)).toBeUndefined();
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
  // flowed into `shell input keyevent <constructor>`.
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

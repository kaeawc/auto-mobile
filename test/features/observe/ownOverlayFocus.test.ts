import { describe, expect, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import { isOwnOverlayFocused } from "../../../src/features/observe/ownOverlayFocus";

const bounds = { left: 0, top: 0, right: 1080, bottom: 2400 };

describe("isOwnOverlayFocused (#10000)", () => {
  test("a focused accessibility-overlay window in a CtrlProxy-labelled capture is the own overlay", () => {
    expect(
      isOwnOverlayFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [
          { id: 1, type: 1, isFocused: false, bounds },
          { id: 2, type: 4, isFocused: true, bounds },
        ],
      }),
    ).toBe(true);
  });

  test("an active but unfocused overlay window also counts", () => {
    expect(
      isOwnOverlayFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [{ id: 2, type: 4, isActive: true, isFocused: false, bounds }],
      }),
    ).toBe(true);
  });

  test("a CtrlProxy-labelled capture with only an application window is not the overlay", () => {
    expect(
      isOwnOverlayFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [{ id: 1, type: 1, isFocused: true, bounds }],
      }),
    ).toBe(false);
  });

  test("an overlay window that holds neither focus nor activity does not count", () => {
    expect(
      isOwnOverlayFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [
          { id: 1, type: 1, isFocused: true, bounds },
          { id: 2, type: 4, isActive: false, isFocused: false, bounds },
        ],
      }),
    ).toBe(false);
  });

  test("another package's focused overlay window is not the product's overlay", () => {
    expect(
      isOwnOverlayFocused({
        packageName: "com.example.screenreader",
        windows: [{ id: 2, type: 4, isFocused: true, bounds }],
      }),
    ).toBe(false);
  });

  test("a missing window list or hierarchy cannot prove the overlay", () => {
    expect(isOwnOverlayFocused({ packageName: CTRL_PROXY_PACKAGE })).toBe(false);
    expect(isOwnOverlayFocused(undefined)).toBe(false);
  });

  test("a focused overlay window that reports the CtrlProxy package is the own overlay", () => {
    expect(
      isOwnOverlayFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [
          { id: 1, type: 1, isFocused: false, packageName: "com.example.app", bounds },
          { id: 2, type: 4, isFocused: true, packageName: CTRL_PROXY_PACKAGE, bounds },
        ],
      }),
    ).toBe(true);
  });

  test("the window's own package overrides a CtrlProxy-labelled capture", () => {
    expect(
      isOwnOverlayFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [
          { id: 2, type: 4, isFocused: true, packageName: "com.example.screenreader", bounds },
        ],
      }),
    ).toBe(false);
  });

  test("the window's own package identifies the overlay even when the capture is labelled otherwise", () => {
    expect(
      isOwnOverlayFocused({
        packageName: "com.example.app",
        windows: [{ id: 2, type: 4, isActive: true, packageName: CTRL_PROXY_PACKAGE, bounds }],
      }),
    ).toBe(true);
  });

  test("a CtrlProxy-package window that is not an overlay type does not count", () => {
    expect(
      isOwnOverlayFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [{ id: 1, type: 1, isFocused: true, packageName: CTRL_PROXY_PACKAGE, bounds }],
      }),
    ).toBe(false);
  });

  test("entries without a window package behave as before (older APKs)", () => {
    expect(
      isOwnOverlayFocused({
        packageName: "com.example.app",
        windows: [{ id: 2, type: 4, isFocused: true, bounds }],
      }),
    ).toBe(false);
  });
});

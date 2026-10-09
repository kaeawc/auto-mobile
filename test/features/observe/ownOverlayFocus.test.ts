import { describe, expect, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import {
  isOwnOverlayFocused,
  ownOverlayWindows,
} from "../../../src/features/observe/ownOverlayFocus";
import {
  PROTOTYPE_CAPTURE,
  capturedAppLayerOverlayHierarchy,
  capturedOverlayHierarchy,
} from "../../helpers/overlayWindowCapture";
import launcherCapture from "../../fixtures/android-launcher/launcher-recents-emulator-5602.json";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import { FakeTimer } from "../../fakes/FakeTimer";

const bounds = { left: 0, top: 0, right: 1080, bottom: 2400 };

describe("overlay_window_metadata_v1 window fields", () => {
  test("CtrlProxyHierarchy conversion keeps the fields from the wire window entry", () => {
    const wire = JSON.parse(launcherCapture.rawViewHierarchy.json) as AccessibilityHierarchy;
    wire.windows = wire.windows!.map((entry) =>
      entry.id === 252 ? { ...entry, overlayPlacement: "sheet", overlayOpaque: false } : entry,
    );
    const converted = new CtrlProxyHierarchy({
      timer: new FakeTimer(),
    } as HierarchyDelegateContext).convertToViewHierarchyResult(wire);
    const entry = converted.windows!.find((candidate) => candidate.id === 252)!;
    expect(entry.overlayPlacement).toBe("sheet");
    expect(entry.overlayOpaque).toBe(false);
    expect(converted.windows!.find((candidate) => candidate.id === 256)!.overlayPlacement).toBe(
      undefined,
    );
  });

  test("a captured overlay window entry carries the fields", () => {
    const opaque = capturedOverlayHierarchy({
      fullScreen: true,
      overlayPlacement: "fullscreen",
      overlayOpaque: true,
    });
    const window = ownOverlayWindows(opaque)[0];
    expect(window.overlayPlacement).toBe("fullscreen");
    expect(window.overlayOpaque).toBe(true);

    const bare = ownOverlayWindows(capturedOverlayHierarchy({ fullScreen: true }))[0];
    expect(bare.overlayPlacement).toBeUndefined();
  });
});

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

  test("ownOverlayWindows lists unfocused own overlay windows and skips other packages (#10086)", () => {
    const own = { id: 2, type: 4, packageName: CTRL_PROXY_PACKAGE, bounds };
    const other = { id: 3, type: 4, packageName: "com.example.screenreader", bounds };
    const app = { id: 1, type: 1, packageName: CTRL_PROXY_PACKAGE, bounds };
    expect(
      ownOverlayWindows({ packageName: "com.example.app", windows: [app, own, other] }),
    ).toEqual([own]);
    expect(ownOverlayWindows(undefined)).toEqual([]);
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

describe("ownOverlayWindows: app-layer prototype windows (aovl D4)", () => {
  test("the captured app-layer window (TYPE_SYSTEM, no metadata) is listed; the status bar is not", () => {
    const hierarchy = capturedAppLayerOverlayHierarchy();
    expect(ownOverlayWindows(hierarchy).map((window) => window.id)).toEqual([
      PROTOTYPE_CAPTURE.appLayerOverlayWindowId,
    ]);
  });

  test("a TYPE_SYSTEM window counts only when its own package is CtrlProxy's", () => {
    const statusBar = { id: 3, type: 3, isFocused: true, bounds };
    // A CtrlProxy-labelled capture from an APK that omits window packages must not adopt SystemUI.
    expect(ownOverlayWindows({ packageName: CTRL_PROXY_PACKAGE, windows: [statusBar] })).toEqual(
      [],
    );
    const own = {
      id: 4,
      type: 3,
      isFocused: true,
      packageName: CTRL_PROXY_PACKAGE,
      bounds,
      hierarchy: { node: { text: "Bump" } },
    };
    expect(isOwnOverlayFocused({ packageName: "com.example.app", windows: [own] })).toBe(true);
  });

  test("CtrlProxy's highlight window (TYPE_SYSTEM once SYSTEM_ALERT_WINDOW is granted, no nodes) is not an overlay", () => {
    const highlight = { id: 6, type: 3, isActive: true, packageName: CTRL_PROXY_PACKAGE, bounds };
    const emptyRoot = { ...highlight, id: 7, hierarchy: { node: [] } };
    expect(
      ownOverlayWindows({ packageName: "com.example.app", windows: [highlight, emptyRoot] }),
    ).toEqual([]);
    // The captured app-layer overlay still counts beside a highlight.
    const hierarchy = capturedAppLayerOverlayHierarchy();
    hierarchy.windows = [...hierarchy.windows!, highlight];
    expect(ownOverlayWindows(hierarchy).map((window) => window.id)).toEqual([
      PROTOTYPE_CAPTURE.appLayerOverlayWindowId,
    ]);
  });

  test("overlay metadata on a CtrlProxy window decides over the window type", () => {
    const stamped = {
      id: 5,
      type: 3,
      packageName: CTRL_PROXY_PACKAGE,
      overlayPlacement: "floating" as const,
      overlayOpaque: false,
      bounds,
    };
    const app = { id: 1, type: 1, packageName: CTRL_PROXY_PACKAGE, bounds };
    const ime = { id: 2, type: 2, packageName: CTRL_PROXY_PACKAGE, bounds };
    expect(
      ownOverlayWindows({ packageName: "com.example.app", windows: [app, ime, stamped] }),
    ).toEqual([stamped]);
  });
});

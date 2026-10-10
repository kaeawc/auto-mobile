import { describe, expect, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import { isOwnWindowFocused, ownWindows } from "../../../src/features/observe/ownWindowFocus";
import {
  PROTOTYPE_CAPTURE,
  capturedAppLayerPrototypeHierarchy,
  capturedPrototypeHierarchy,
} from "../../helpers/prototypeWindowCapture";
import launcherCapture from "../../fixtures/android-launcher/launcher-recents-emulator-5602.json";
import { CtrlProxyHierarchy } from "../../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  HierarchyDelegateContext,
} from "../../../src/features/observe/android/types";
import { FakeTimer } from "../../fakes/FakeTimer";

const bounds = { left: 0, top: 0, right: 1080, bottom: 2400 };

describe("prototype_window_metadata_v1 window fields", () => {
  test("CtrlProxyHierarchy conversion keeps the fields from the wire window entry", () => {
    const wire = JSON.parse(launcherCapture.rawViewHierarchy.json) as AccessibilityHierarchy;
    wire.windows = wire.windows!.map((entry) =>
      entry.id === 252 ? { ...entry, prototypePlacement: "sheet", prototypeOpaque: false } : entry,
    );
    const converted = new CtrlProxyHierarchy({
      timer: new FakeTimer(),
    } as HierarchyDelegateContext).convertToViewHierarchyResult(wire);
    const entry = converted.windows!.find((candidate) => candidate.id === 252)!;
    expect(entry.prototypePlacement).toBe("sheet");
    expect(entry.prototypeOpaque).toBe(false);
    expect(converted.windows!.find((candidate) => candidate.id === 256)!.prototypePlacement).toBe(
      undefined,
    );
  });

  test("a captured prototype window entry carries the fields", () => {
    const opaque = capturedPrototypeHierarchy({
      fullScreen: true,
      prototypePlacement: "fullscreen",
      prototypeOpaque: true,
    });
    const window = ownWindows(opaque)[0];
    expect(window.prototypePlacement).toBe("fullscreen");
    expect(window.prototypeOpaque).toBe(true);

    const bare = ownWindows(capturedPrototypeHierarchy({ fullScreen: true }))[0];
    expect(bare.prototypePlacement).toBeUndefined();
  });
});

describe("isOwnWindowFocused (#10000)", () => {
  test("a focused accessibility-overlay window in a CtrlProxy-labelled capture is the own prototype", () => {
    expect(
      isOwnWindowFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [
          { id: 1, type: 1, isFocused: false, bounds },
          { id: 2, type: 4, isFocused: true, bounds },
        ],
      }),
    ).toBe(true);
  });

  test("an active but unfocused prototype window also counts", () => {
    expect(
      isOwnWindowFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [{ id: 2, type: 4, isActive: true, isFocused: false, bounds }],
      }),
    ).toBe(true);
  });

  test("a CtrlProxy-labelled capture with only an application window is not the prototype", () => {
    expect(
      isOwnWindowFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [{ id: 1, type: 1, isFocused: true, bounds }],
      }),
    ).toBe(false);
  });

  test("a prototype window that holds neither focus nor activity does not count", () => {
    expect(
      isOwnWindowFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [
          { id: 1, type: 1, isFocused: true, bounds },
          { id: 2, type: 4, isActive: false, isFocused: false, bounds },
        ],
      }),
    ).toBe(false);
  });

  test("another package's focused prototype window is not the product's prototype", () => {
    expect(
      isOwnWindowFocused({
        packageName: "com.example.screenreader",
        windows: [{ id: 2, type: 4, isFocused: true, bounds }],
      }),
    ).toBe(false);
  });

  test("a missing window list or hierarchy cannot prove the prototype", () => {
    expect(isOwnWindowFocused({ packageName: CTRL_PROXY_PACKAGE })).toBe(false);
    expect(isOwnWindowFocused(undefined)).toBe(false);
  });

  test("a focused prototype window that reports the CtrlProxy package is the own prototype", () => {
    expect(
      isOwnWindowFocused({
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
      isOwnWindowFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [
          { id: 2, type: 4, isFocused: true, packageName: "com.example.screenreader", bounds },
        ],
      }),
    ).toBe(false);
  });

  test("the window's own package identifies the prototype even when the capture is labelled otherwise", () => {
    expect(
      isOwnWindowFocused({
        packageName: "com.example.app",
        windows: [{ id: 2, type: 4, isActive: true, packageName: CTRL_PROXY_PACKAGE, bounds }],
      }),
    ).toBe(true);
  });

  test("a CtrlProxy-package window that is not a prototype type does not count", () => {
    expect(
      isOwnWindowFocused({
        packageName: CTRL_PROXY_PACKAGE,
        windows: [{ id: 1, type: 1, isFocused: true, packageName: CTRL_PROXY_PACKAGE, bounds }],
      }),
    ).toBe(false);
  });

  test("ownWindows lists unfocused own prototype windows and skips other packages (#10086)", () => {
    const own = { id: 2, type: 4, packageName: CTRL_PROXY_PACKAGE, bounds };
    const other = { id: 3, type: 4, packageName: "com.example.screenreader", bounds };
    const app = { id: 1, type: 1, packageName: CTRL_PROXY_PACKAGE, bounds };
    expect(ownWindows({ packageName: "com.example.app", windows: [app, own, other] })).toEqual([
      own,
    ]);
    expect(ownWindows(undefined)).toEqual([]);
  });

  test("entries without a window package behave as before (older APKs)", () => {
    expect(
      isOwnWindowFocused({
        packageName: "com.example.app",
        windows: [{ id: 2, type: 4, isFocused: true, bounds }],
      }),
    ).toBe(false);
  });
});

describe("ownWindows: app-layer prototype windows (aovl D4)", () => {
  test("the captured app-layer window (TYPE_SYSTEM, no metadata) is listed; the status bar is not", () => {
    const hierarchy = capturedAppLayerPrototypeHierarchy();
    expect(ownWindows(hierarchy).map((window) => window.id)).toEqual([
      PROTOTYPE_CAPTURE.appLayerPrototypeWindowId,
    ]);
  });

  test("a TYPE_SYSTEM window counts only when its own package is CtrlProxy's", () => {
    const statusBar = { id: 3, type: 3, isFocused: true, bounds };
    // A CtrlProxy-labelled capture from an APK that omits window packages must not adopt SystemUI.
    expect(ownWindows({ packageName: CTRL_PROXY_PACKAGE, windows: [statusBar] })).toEqual([]);
    const own = {
      id: 4,
      type: 3,
      isFocused: true,
      packageName: CTRL_PROXY_PACKAGE,
      bounds,
      hierarchy: { node: { text: "Bump" } },
    };
    expect(isOwnWindowFocused({ packageName: "com.example.app", windows: [own] })).toBe(true);
  });

  test("CtrlProxy's highlight window (TYPE_SYSTEM once SYSTEM_ALERT_WINDOW is granted, no nodes) is not a prototype", () => {
    const highlight = { id: 6, type: 3, isActive: true, packageName: CTRL_PROXY_PACKAGE, bounds };
    const emptyRoot = { ...highlight, id: 7, hierarchy: { node: [] } };
    expect(ownWindows({ packageName: "com.example.app", windows: [highlight, emptyRoot] })).toEqual(
      [],
    );
    // The captured app-layer prototype still counts beside a highlight.
    const hierarchy = capturedAppLayerPrototypeHierarchy();
    hierarchy.windows = [...hierarchy.windows!, highlight];
    expect(ownWindows(hierarchy).map((window) => window.id)).toEqual([
      PROTOTYPE_CAPTURE.appLayerPrototypeWindowId,
    ]);
  });

  test("prototype metadata on a CtrlProxy window decides over the window type", () => {
    const stamped = {
      id: 5,
      type: 3,
      packageName: CTRL_PROXY_PACKAGE,
      prototypePlacement: "floating" as const,
      prototypeOpaque: false,
      bounds,
    };
    const app = { id: 1, type: 1, packageName: CTRL_PROXY_PACKAGE, bounds };
    const ime = { id: 2, type: 2, packageName: CTRL_PROXY_PACKAGE, bounds };
    expect(ownWindows({ packageName: "com.example.app", windows: [app, ime, stamped] })).toEqual([
      stamped,
    ]);
  });
});

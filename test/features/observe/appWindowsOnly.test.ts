import { describe, expect, test } from "bun:test";
import launcherCapture from "../../fixtures/android-launcher/launcher-recents-emulator-5602.json";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import { ScreenFingerprint } from "../../../src/features/navigation/ScreenFingerprint";
import type { AccessibilityHierarchy } from "../../../src/features/observe/android/types";
import { appWindowsOnly } from "../../../src/features/observe/hierarchyLayer";
import type { CtrlProxyNode, XCTestHierarchy } from "../../../src/features/observe/ios/types";
import { iosFloatingOverlayOverSettings } from "../../fixtures/observe/iosOverlayWindow";
import {
  OVERLAY_CAPTURE,
  PROTOTYPE_CAPTURE,
  appLayerOverlayWireCapture,
  floatingCoverWireCapture,
  launcherWireWithOverlay,
  launcherWireWithPagedOverlay,
  wireWindowRoot,
  withoutWireWindow,
} from "../../helpers/overlayWindowCapture";

// Captured prototype overlays over the Playground (test/fixtures/android-overlay-window/README.txt)
// and over iOS Settings (test/fixtures/observe-output/ios-overlay-window/README.txt).

const FLOATING = PROTOTYPE_CAPTURE.floatingOverlayWindowId;
const APP_LAYER = PROTOTYPE_CAPTURE.appLayerOverlayWindowId;
// The Playground prototype captures fingerprint by the SDK's `navigation.*` id, which no overlay
// node changes; the relabelled launcher capture has none, so its fingerprint covers every node and
// the scoping is load-bearing there.
const LAUNCHER_OVERLAY = OVERLAY_CAPTURE.overlayWindowId;

function hashOf(capture: AccessibilityHierarchy): string {
  return ScreenFingerprint.compute(capture).hash;
}

/** The floating capture as the device reports it while the overlay holds window focus. */
function overlayFocusedCapture(): AccessibilityHierarchy {
  const capture = floatingCoverWireCapture();
  return {
    ...capture,
    packageName: CTRL_PROXY_PACKAGE,
    windows: capture.windows?.map((window) => ({
      ...window,
      isFocused: window.id === FLOATING,
      isActive: window.id === FLOATING,
    })),
  };
}

function iosWindows(capture: XCTestHierarchy): CtrlProxyNode[] {
  const roots = capture.hierarchy.node;
  return roots === undefined ? [] : Array.isArray(roots) ? roots : [roots];
}

describe("appWindowsOnly: app screen identity ignores AutoMobile's overlay (#9305)", () => {
  test("removes the floating overlay's window entry and root, keeping the app's roots", () => {
    const capture = floatingCoverWireCapture();
    const scoped = appWindowsOnly(capture);

    expect(scoped.windows?.map((window) => window.id)).toEqual([
      PROTOTYPE_CAPTURE.statusBarWindowId,
      PROTOTYPE_CAPTURE.appWindowId,
    ]);
    expect(() => wireWindowRoot(scoped, FLOATING)).toThrow();
    // Untouched window roots keep their identity.
    expect(wireWindowRoot(scoped, PROTOTYPE_CAPTURE.appWindowId)).toBe(
      wireWindowRoot(capture, PROTOTYPE_CAPTURE.appWindowId),
    );
    expect(scoped.packageName).toBe(PROTOTYPE_CAPTURE.appPackage);
  });

  test("the app-layer (TYPE_SYSTEM) prototype is removed the same way", () => {
    const shown = appLayerOverlayWireCapture();
    expect(appWindowsOnly(shown)).toEqual(withoutWireWindow(shown, APP_LAYER));
  });

  test("showing an overlay leaves the app screen's fingerprint unchanged", () => {
    const shown = launcherWireWithOverlay();
    const before = withoutWireWindow(shown, LAUNCHER_OVERLAY);

    // The overlay's nodes do change the whole-screen fingerprint.
    expect(hashOf(shown)).not.toBe(hashOf(before));
    expect(hashOf(appWindowsOnly(shown))).toBe(hashOf(before));
  });

  test("paging the overlay leaves the app screen's fingerprint unchanged", () => {
    const shown = launcherWireWithOverlay();
    const paged = launcherWireWithPagedOverlay();

    expect(hashOf(paged)).not.toBe(hashOf(shown));
    expect(hashOf(appWindowsOnly(paged))).toBe(hashOf(appWindowsOnly(shown)));
  });

  test("a capture labelled with the overlay host while it holds focus names the app behind it", () => {
    const focused = overlayFocusedCapture();
    const scoped = appWindowsOnly(focused);

    expect(scoped.packageName).toBe(PROTOTYPE_CAPTURE.appPackage);
    expect(() => wireWindowRoot(scoped, FLOATING)).toThrow();
  });

  test("a capture with no overlay is returned as the same object", () => {
    const noOverlay = JSON.parse(launcherCapture.rawViewHierarchy.json) as AccessibilityHierarchy;
    expect(appWindowsOnly(noOverlay)).toBe(noOverlay);

    const dismissed = withoutWireWindow(floatingCoverWireCapture(), FLOATING);
    expect(appWindowsOnly(dismissed)).toBe(dismissed);
  });

  test("iOS: removes the overlay agent's UIWindow from the runner's capture", () => {
    const capture = iosFloatingOverlayOverSettings();
    const settingsOnly = iosFloatingOverlayOverSettings();
    settingsOnly.hierarchy.node = iosWindows(settingsOnly).slice(0, 1);

    const scoped = appWindowsOnly(capture);

    expect(scoped).toEqual(settingsOnly);
    expect(JSON.stringify(scoped)).not.toContain("automobile-overlay-dismiss");
    expect(appWindowsOnly(settingsOnly)).toBe(settingsOnly);
  });
});

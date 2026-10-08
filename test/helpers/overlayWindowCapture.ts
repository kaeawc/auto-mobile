import capture from "../fixtures/android-launcher/launcher-recents-emulator-5602.json";
import appLayerCapture from "../fixtures/android-overlay-window/app-layer-overlay-over-playground.raw.json";
import floatingCoverCapture from "../fixtures/android-overlay-window/floating-overlay-over-button-elevated.raw.json";
import { CTRL_PROXY_PACKAGE } from "../../src/ctrlProxy/constants";
import { CtrlProxyHierarchy } from "../../src/features/observe/android/CtrlProxyHierarchy";
import type {
  AccessibilityHierarchy,
  AccessibilityNode,
  HierarchyDelegateContext,
} from "../../src/features/observe/android/types";
import { DefaultObserveElementCollector } from "../../src/features/observe/ObserveElementCollector";
import type { ElementBounds } from "../../src/models/ElementBounds";
import type { ObserveResult } from "../../src/models/ObserveResult";
import type {
  OwnOverlayPlacement,
  ViewHierarchyResult,
} from "../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * A captured two-window screen standing in for the CtrlProxy prototype overlay
 * over an app (issue #9305).
 *
 * No captured hierarchy contains the CtrlProxy overlay window yet (that needs a
 * device capture with the prototype overlay showing). The captured API 36
 * Recents overview (`launcher-recents-emulator-5602.json`, its raw CtrlProxy
 * wire JSON) has the same shape: an application window (256, layer 0) and a
 * smaller window above it (252, layer 2, the predicted-apps row), each root
 * stamped with its `windowId`. Only window 252's metadata is relabelled as the
 * overlay — TYPE_ACCESSIBILITY_OVERLAY reported by the CtrlProxy package — and,
 * for the full-screen case, its bounds widened to the screen. The node tree is
 * the unmodified capture.
 *
 * No capture of the new `overlayPlacement` / `overlayOpaque` window fields exists yet (that needs
 * a device running an APK that advertises `overlay_window_metadata_v1`), so the optional
 * `overlayPlacement` / `overlayOpaque` options add the two fields to this captured window entry.
 *
 * "Settings" is in both windows: the app's Settings task snapshot and the
 * overlay's predicted Settings icon. "YouTube" is overlay-only and "Screenshot"
 * app-only.
 */
export const OVERLAY_CAPTURE = {
  appWindowId: 256,
  overlayWindowId: 252,
  appPackage: "com.google.android.apps.nexuslauncher",
  screen: { left: 0, top: 0, right: 2076, bottom: 2152 } satisfies ElementBounds,
} as const;

const ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY = 4;

/** The converted capture with no window relabelled (no overlay on screen). */
export function capturedTwoWindowHierarchy(): ViewHierarchyResult {
  return new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(
    JSON.parse(capture.rawViewHierarchy.json) as AccessibilityHierarchy,
  );
}

/** The converted capture with window 252 relabelled as the CtrlProxy overlay. */
export function capturedOverlayHierarchy(
  options: {
    fullScreen?: boolean;
    overlayPlacement?: OwnOverlayPlacement;
    overlayOpaque?: boolean;
  } = {},
): ViewHierarchyResult {
  const hierarchy = capturedTwoWindowHierarchy();
  hierarchy.windows = hierarchy.windows!.map((window) =>
    window.id === OVERLAY_CAPTURE.overlayWindowId
      ? {
          ...window,
          type: ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY,
          packageName: CTRL_PROXY_PACKAGE,
          ...(options.fullScreen ? { bounds: { ...OVERLAY_CAPTURE.screen } } : {}),
          ...(options.overlayPlacement ? { overlayPlacement: options.overlayPlacement } : {}),
          ...(options.overlayOpaque === undefined ? {} : { overlayOpaque: options.overlayOpaque }),
        }
      : window,
  );
  return hierarchy;
}

/** An observation built from a converted capture, as action tools receive it. */
export function observationOf(viewHierarchy: ViewHierarchyResult): ObserveResult {
  return {
    updatedAt: 1,
    display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
    screenSize: { width: OVERLAY_CAPTURE.screen.right, height: OVERLAY_CAPTURE.screen.bottom },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy,
    elements: new DefaultObserveElementCollector().collect(viewHierarchy, "android"),
  };
}

function convertCapture(json: string): ViewHierarchyResult {
  return new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(
    JSON.parse(json) as AccessibilityHierarchy,
  );
}

/**
 * Device captures of a real prototype overlay; see the README beside them in
 * test/fixtures/android-overlay-window/. Window ids are the captured ones.
 */
export const PROTOTYPE_CAPTURE = {
  appWindowId: 150,
  statusBarWindowId: 157,
  appLayerOverlayWindowId: 174,
  floatingOverlayWindowId: 170,
  appPackage: "dev.jasonpearson.automobile.playground",
} as const;

/** The unconverted CtrlProxy wire capture of the floating prototype over "Elevated" (window 170). */
export function floatingCoverWireCapture(): AccessibilityHierarchy {
  return JSON.parse(floatingCoverCapture.rawViewHierarchy.json) as AccessibilityHierarchy;
}

/** The unconverted CtrlProxy wire capture of the `window.layer: "app"` prototype (window 174). */
export function appLayerOverlayWireCapture(): AccessibilityHierarchy {
  return JSON.parse(appLayerCapture.rawViewHierarchy.json) as AccessibilityHierarchy;
}

function wireRoots(capture: AccessibilityHierarchy): AccessibilityNode[] {
  const roots = capture.hierarchy.node;
  return roots === undefined ? [] : Array.isArray(roots) ? roots : [roots];
}

/** The window root CtrlProxy stamped with `windowId` in a wire capture. */
export function wireWindowRoot(
  capture: AccessibilityHierarchy,
  windowId: number,
): AccessibilityNode {
  const root = wireRoots(capture).find((node) => node.windowId === windowId);
  if (!root) {
    throw new Error(`capture has no window root ${windowId}`);
  }
  return root;
}

/**
 * A wire capture with one window removed (its entry and its root), which is the same screen as it
 * was before that window was shown. Every other node is the captured one.
 */
export function withoutWireWindow(
  capture: AccessibilityHierarchy,
  windowId: number,
): AccessibilityHierarchy {
  return {
    ...capture,
    hierarchy: {
      ...capture.hierarchy,
      node: wireRoots(capture).filter((node) => node.windowId !== windowId),
    },
    windows: capture.windows?.filter((window) => window.id !== windowId),
  };
}

/**
 * The captured Recents overview's raw wire capture with window 252 relabelled as the CtrlProxy
 * overlay, the wire counterpart of `capturedOverlayHierarchy`. Unlike the Playground captures,
 * whose screen fingerprint is the SDK's `navigation.*` id, its fingerprint covers every node.
 */
export function launcherWireWithOverlay(): AccessibilityHierarchy {
  const wire = JSON.parse(capture.rawViewHierarchy.json) as AccessibilityHierarchy;
  return {
    ...wire,
    windows: wire.windows?.map((window) =>
      window.id === OVERLAY_CAPTURE.overlayWindowId
        ? {
            ...window,
            type: ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY,
            packageName: CTRL_PROXY_PACKAGE,
          }
        : window,
    ),
  };
}

/** `launcherWireWithOverlay` with the overlay showing the captured floating prototype's content. */
export function launcherWireWithPagedOverlay(): AccessibilityHierarchy {
  const wire = launcherWireWithOverlay();
  wireWindowRoot(wire, OVERLAY_CAPTURE.overlayWindowId).node = wireWindowRoot(
    floatingCoverWireCapture(),
    PROTOTYPE_CAPTURE.floatingOverlayWindowId,
  ).node;
  return wire;
}

/** `window.layer: "app"` prototype (a TYPE_SYSTEM window without overlay metadata) over the Playground. */
export function capturedAppLayerOverlayHierarchy(): ViewHierarchyResult {
  return convertCapture(appLayerCapture.rawViewHierarchy.json);
}

/**
 * Floating system-layer prototype over the Playground "Elevated" button. The unfiltered wire JSON,
 * so `button_elevated` is still present under the overlay window.
 */
export function capturedFloatingCoverHierarchy(): ViewHierarchyResult {
  return convertCapture(floatingCoverCapture.rawViewHierarchy.json);
}

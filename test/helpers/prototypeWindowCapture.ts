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
import type { PrototypePlacement, ViewHierarchyResult } from "../../src/models/ViewHierarchyResult";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * A captured two-window screen standing in for the CtrlProxy prototype
 * over an app (issue #9305).
 *
 * No captured hierarchy contains the CtrlProxy prototype window yet (that needs a
 * device capture with the prototype showing). The captured API 36
 * Recents overview (`launcher-recents-emulator-5602.json`, its raw CtrlProxy
 * wire JSON) has the same shape: an application window (256, layer 0) and a
 * smaller window above it (252, layer 2, the predicted-apps row), each root
 * stamped with its `windowId`. Only window 252's metadata is relabelled as the
 * prototype — TYPE_ACCESSIBILITY_OVERLAY reported by the CtrlProxy package — and,
 * for the full-screen case, its bounds widened to the screen. The node tree is
 * the unmodified capture.
 *
 * No capture of the new `prototypePlacement` / `prototypeOpaque` window fields exists yet (that needs
 * a device running an APK that advertises `prototype_window_metadata_v1`), so the optional
 * `prototypePlacement` / `prototypeOpaque` options add the two fields to this captured window entry.
 *
 * "Settings" is in both windows: the app's Settings task snapshot and the
 * prototype's predicted Settings icon. "YouTube" is prototype-only and "Screenshot"
 * app-only.
 */
export const RELABELLED_CAPTURE = {
  appWindowId: 256,
  prototypeWindowId: 252,
  appPackage: "com.google.android.apps.nexuslauncher",
  screen: { left: 0, top: 0, right: 2076, bottom: 2152 } satisfies ElementBounds,
} as const;

const ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY = 4;

/** The converted capture with no window relabelled (no prototype on screen). */
export function capturedTwoWindowHierarchy(): ViewHierarchyResult {
  return new CtrlProxyHierarchy({
    timer: new FakeTimer(),
  } as HierarchyDelegateContext).convertToViewHierarchyResult(
    JSON.parse(capture.rawViewHierarchy.json) as AccessibilityHierarchy,
  );
}

/** The converted capture with window 252 relabelled as the CtrlProxy prototype. */
export function capturedPrototypeHierarchy(
  options: {
    fullScreen?: boolean;
    prototypePlacement?: PrototypePlacement;
    prototypeOpaque?: boolean;
  } = {},
): ViewHierarchyResult {
  const hierarchy = capturedTwoWindowHierarchy();
  hierarchy.windows = hierarchy.windows!.map((window) =>
    window.id === RELABELLED_CAPTURE.prototypeWindowId
      ? {
          ...window,
          type: ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY,
          packageName: CTRL_PROXY_PACKAGE,
          ...(options.fullScreen ? { bounds: { ...RELABELLED_CAPTURE.screen } } : {}),
          ...(options.prototypePlacement ? { prototypePlacement: options.prototypePlacement } : {}),
          ...(options.prototypeOpaque === undefined
            ? {}
            : { prototypeOpaque: options.prototypeOpaque }),
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
    screenSize: {
      width: RELABELLED_CAPTURE.screen.right,
      height: RELABELLED_CAPTURE.screen.bottom,
    },
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
 * Device captures of a real prototype; see the README beside them in
 * test/fixtures/android-overlay-window/. Window ids are the captured ones.
 */
export const PROTOTYPE_CAPTURE = {
  appWindowId: 150,
  statusBarWindowId: 157,
  appLayerPrototypeWindowId: 174,
  floatingPrototypeWindowId: 170,
  appPackage: "dev.jasonpearson.automobile.playground",
} as const;

/** The unconverted CtrlProxy wire capture of the floating prototype over "Elevated" (window 170). */
export function floatingCoverWireCapture(): AccessibilityHierarchy {
  return JSON.parse(floatingCoverCapture.rawViewHierarchy.json) as AccessibilityHierarchy;
}

/** The unconverted CtrlProxy wire capture of the `window.layer: "app"` prototype (window 174). */
export function appLayerPrototypeWireCapture(): AccessibilityHierarchy {
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
 * prototype, the wire counterpart of `capturedPrototypeHierarchy`. Unlike the Playground captures,
 * whose screen fingerprint is the SDK's `navigation.*` id, its fingerprint covers every node.
 */
export function launcherWireWithPrototype(): AccessibilityHierarchy {
  const wire = JSON.parse(capture.rawViewHierarchy.json) as AccessibilityHierarchy;
  return {
    ...wire,
    windows: wire.windows?.map((window) =>
      window.id === RELABELLED_CAPTURE.prototypeWindowId
        ? {
            ...window,
            type: ACCESSIBILITY_WINDOW_TYPE_ACCESSIBILITY_OVERLAY,
            packageName: CTRL_PROXY_PACKAGE,
          }
        : window,
    ),
  };
}

/** `launcherWireWithPrototype` with the prototype showing the captured floating prototype's content. */
export function launcherWireWithPagedPrototype(): AccessibilityHierarchy {
  const wire = launcherWireWithPrototype();
  wireWindowRoot(wire, RELABELLED_CAPTURE.prototypeWindowId).node = wireWindowRoot(
    floatingCoverWireCapture(),
    PROTOTYPE_CAPTURE.floatingPrototypeWindowId,
  ).node;
  return wire;
}

/** `window.layer: "app"` prototype (a TYPE_SYSTEM window without prototype metadata) over the Playground. */
export function capturedAppLayerPrototypeHierarchy(): ViewHierarchyResult {
  return convertCapture(appLayerCapture.rawViewHierarchy.json);
}

/**
 * Floating system-layer prototype over the Playground "Elevated" button. The unfiltered wire JSON,
 * so `button_elevated` is still present under the prototype window.
 */
export function capturedFloatingCoverHierarchy(): ViewHierarchyResult {
  return convertCapture(floatingCoverCapture.rawViewHierarchy.json);
}

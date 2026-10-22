import type { Clipboard } from "../../features/action/Clipboard";
import type { DragAndDrop } from "../../features/action/DragAndDrop";
import type { HandleIntentChooser } from "../../features/action/HandleIntentChooser";
import type { Keyboard } from "../../features/action/Keyboard";
import type { OpenURL } from "../../features/action/OpenURL";
import type { PinchOn } from "../../features/action/PinchOn";
import type { PressButton } from "../../features/action/PressButton";
import type { RecentApps } from "../../features/action/RecentApps";
import type { Rotate, RotateOptions } from "../../features/action/Rotate";
import type { SelectAllText } from "../../features/action/SelectAllText";
import type { SendKeys } from "../../features/action/SendKeys";
import type { Shake } from "../../features/action/Shake";
import type { SwipeOn } from "../../features/action/swipeon";
import type { TapAnyElement } from "../../features/action/TapAnyElement";
import type { TapAtCoordinate } from "../../features/action/TapAtCoordinate";
import type { TapOnElement } from "../../features/action/TapOnElement";
import type { WakeAndUnlock } from "../../features/action/WakeAndUnlock";
import type { SetPosture } from "../../features/device/SetPosture";
import type { RealObserveScreen } from "../../features/observe/ObserveScreen";
import type { BootedDevice, ObserveResult } from "../../models";
import type { WaitForObservationOutcome } from "../observeTools";
import type { AndroidCtrlProxy } from "../../features/observe/android";
import type { KeyboardProfileRestoreRegistry } from "../../features/utility/KeyboardProfileRestore";
import type { SessionKeyboardProfileHost } from "../sessionKeyboardProfile";

export interface SendKeysRunnerCommandSource {
  getSupportedCommands(): Promise<string[] | null>;
}

export type SendKeysRunnerCommandSourceFactory = (
  device: BootedDevice,
) => SendKeysRunnerCommandSource;

/** Outcome of a post-open waitFor poll, as produced by {@link waitForObservation}. */
export type OpenLinkWaitOutcome = WaitForObservationOutcome;

// Injection seam for the swipeOn handler (mirrors the pinchOn/tapOn factory
// seams). Lets a unit test exercise the registered handler wiring with a fake
// SwipeOn whose execute() returns a failure, so a revert of the `isError`
// gating below is caught by a test — not just the formatter (#6163).
export type SwipeOnLike = Pick<SwipeOn, "execute">;

/**
 * Overridable collaborators for the interaction tool handlers. Every field is
 * optional and defaults to the real implementation; tests pass fakes instead
 * of mutating module-level state (#11831).
 */
export interface InteractionToolDependencies {
  sendKeysFactory?: (device: BootedDevice) => SendKeysLike;
  swipeOnFactory?: (device: BootedDevice) => SwipeOnLike;
  pinchOnFactory?: (device: BootedDevice) => PinchOnLike;
  tapOnElementFactory?: (device: BootedDevice) => TapOnElementLike;
  tapAtElementFactory?: (device: BootedDevice) => TapAtElementLike;
  hitTestObservationFactory?: (device: BootedDevice) => HitTestObservationReader;
  hitTestDeviceReadFactory?: (device: BootedDevice, display?: string) => HitTestDeviceReader;
  tapAnyElementFactory?: (device: BootedDevice) => TapAnyElementLike;
  dragAndDropFactory?: (device: BootedDevice) => DragAndDropLike;
  selectAllTextFactory?: (device: BootedDevice) => SelectAllTextLike;
  pressButtonFactory?: (device: BootedDevice) => PressButtonLike;
  rotateFactory?: (device: BootedDevice, options?: RotateOptions) => RotateLike;
  setPostureFactory?: (device: BootedDevice) => SetPostureLike;
  keyboardFactory?: (device: BootedDevice) => Pick<Keyboard, "execute">;
  openUrlFactory?: (device: BootedDevice) => Pick<OpenURL, "execute">;
  openLinkChooserFactory?: (device: BootedDevice) => Pick<HandleIntentChooser, "execute">;
  shakeFactory?: (device: BootedDevice) => Pick<Shake, "execute">;
  recentAppsFactory?: (device: BootedDevice) => Pick<RecentApps, "execute">;
  clipboardFactory?: (device: BootedDevice) => Pick<Clipboard, "execute">;
  wakeAndUnlockFactory?: (device: BootedDevice) => Pick<WakeAndUnlock, "execute">;
  keyboardProfile?: KeyboardProfileToolDependencies;
}

/** Collaborators of `keyboard setProfile`; each defaults to the daemon's own (#14705). */
export interface KeyboardProfileToolDependencies {
  sessionManager?: () => SessionKeyboardProfileHost | undefined;
  clientFor?: (
    device: BootedDevice,
  ) => Pick<AndroidCtrlProxy, "supportsCommand" | "setKeyboardProfile">;
  registry?: KeyboardProfileRestoreRegistry;
}

type SendKeysLike = Pick<SendKeys, "execute">;

// Injection seam for the pinchOn handler (mirrors the systemTray factory seam in
// this file). Lets a unit test exercise the registered handler wiring with a fake
// PinchOn whose execute() returns a failure, so a revert of the handler message
// wiring is caught by a test — not just the formatter (#6056).
export type PinchOnLike = Pick<PinchOn, "execute">;

// Injection seam for the tapOn handler (mirrors the pinchOn factory seam above).
// Lets a unit test exercise the registered handler wiring with a fake
// TapOnElement whose execute() returns a selector miss, so a revert of the
// failure gating below is caught by a test — not just the formatter (#6152).
export type TapOnElementLike = Pick<TapOnElement, "execute">;

export type TapAtElementLike = Pick<TapAtCoordinate, "execute">;

type HitTestObservationReader = Pick<RealObserveScreen, "execute">;

type HitTestDeviceReader = Pick<RealObserveScreen, "executeDeviceRead">;

export type OpenAlertHierarchyRefresh = () => Promise<ObserveResult["viewHierarchy"] | null>;

export type SystemAlertTap = () => Promise<{ success: boolean; error?: string }>;

export type OpenAlertResolution =
  | { hierarchy: ObserveResult["viewHierarchy"] }
  | { systemTapped: true }
  | null;

export interface AcceptIosAppOpenAlertOptions {
  refreshHierarchy?: OpenAlertHierarchyRefresh;
  tapSystemAlert?: SystemAlertTap;
  tapOnElementFactory?: InteractionToolDependencies["tapOnElementFactory"];
}

// Injection seam for the tapAny handler (mirrors the tapOn factory seam above).
// Lets a unit test exercise the registered handler wiring with a fake
// TapAnyElement whose execute() returns a failure (#6163).
export type TapAnyElementLike = Pick<TapAnyElement, "execute">;

// Injection seam for the dragAndDrop handler. Lets a unit test exercise the
// registered handler wiring with a fake DragAndDrop whose execute() returns a
// failure (#6163).
export type DragAndDropLike = Pick<DragAndDrop, "execute">;

// Injection seam for the selectAllText handler. Lets a unit test exercise the
// registered handler wiring with a fake SelectAllText whose execute() returns
// a failure (#6163).
export type SelectAllTextLike = Pick<SelectAllText, "execute">;

// Injection seam for the pressButton handler. Lets a unit test exercise the
// registered handler wiring with a fake PressButton whose execute() returns a
// failure (#6163).
export type PressButtonLike = Pick<PressButton, "execute">;

// Injection seam for the rotate handler. In particular, persistent-orientation
// failures must reach MCP clients as errors rather than success-shaped results.
export type RotateLike = Pick<Rotate, "execute">;

export type SetPostureLike = Pick<SetPosture, "execute" | "executeHingeAngle">;

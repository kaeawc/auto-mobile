import type { TapCoordinatesRequest } from "../observe/shared/SharedGestureDelegate";
import type { BootedDevice } from "../../models";
import type { A11yTapCoordinatesResult } from "../observe/android/types";
import { AndroidCtrlProxyClient } from "../observe/android";
import type { FocusNavigationDriver } from "./FocusNavigationExecutor";
export { DefaultTalkBackNavigationDriverFactory } from "./DefaultTalkBackNavigationDriverFactory";

/**
 * Extended driver interface for TalkBack navigation that adds coordinate tap capabilities to the
 * focus-navigation reads and accessibility actions. This interface is used by TalkBackTapStrategy
 * to perform element activation after navigation.
 */
export interface TalkBackNavigationDriver extends FocusNavigationDriver {
  /**
   * Request a tap at specific coordinates via accessibility service.
   * @param x - X coordinate
   * @param y - Y coordinate
   * @param durationMs - Duration of the tap in milliseconds
   */
  requestTapCoordinates(request: TapCoordinatesRequest): Promise<A11yTapCoordinatesResult>;

  /** Dispatch both activation taps in one device request. */
  requestDoubleTapCoordinates(
    x: number,
    y: number,
    onDispatch?: () => void,
  ): Promise<A11yTapCoordinatesResult>;
}

export type TalkBackDriverClient = Pick<
  AndroidCtrlProxyClient,
  | "getAccessibilityHierarchy"
  | "requestTraversalOrder"
  | "requestCurrentFocus"
  | "requestTapCoordinates"
  | "requestDoubleTapCoordinates"
  | "requestAction"
  | "requestNodeAction"
  | "supportsNodeActionSelectors"
>;

/**
 * Factory interface for creating TalkBackNavigationDriver instances.
 */
export interface TalkBackNavigationDriverFactory {
  createDriver(device: BootedDevice): TalkBackNavigationDriver;
}

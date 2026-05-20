import type { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../models";

/**
 * Platform-specific surface used by `systemTrayHelpers.ts` so its
 * helper functions are free of `device.platform === ...` branches.
 *
 * Each implementation captures its {@link BootedDevice} at construction.
 * See `AndroidNotificationUIDetector` / `IosNotificationUIDetector` for
 * per-platform notes on the underlying mechanism.
 */
export interface NotificationUIDetector {
  /** The device this detector is bound to. */
  readonly device: BootedDevice;

  /**
   * Returns `true` when the view hierarchy snapshot shows the
   * notification shade (Android) or NotificationCenter (iOS) open.
   * `undefined` snapshots return `false`.
   */
  isTrayOpen(viewHierarchy?: ViewHierarchyResult): boolean;

  /**
   * Open the notification shade / NotificationCenter. The observation
   * is optional because not every implementation needs screen
   * dimensions — iOS does; Android does not.
   */
  expandTray(observation?: ObserveResult): Promise<void>;

  /** Close the notification shade / NotificationCenter. See {@link expandTray} on `observation`. */
  collapseTray(observation?: ObserveResult): Promise<void>;

  /**
   * Resolve a `minTimestamp` for the next observation request so
   * polling can gate on a clock that's monotonic relative to the
   * platform doing the gesture.
   */
  getObservationTimestamp(): Promise<number>;

  /** Tap a notification row element. */
  tapElement(element: Element): Promise<void>;

  /** Left-swipe a notification row to dismiss it. */
  swipeElement(element: Element): Promise<void>;
}

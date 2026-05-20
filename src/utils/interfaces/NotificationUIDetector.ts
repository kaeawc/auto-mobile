import type { BootedDevice, Element, ObserveResult, ViewHierarchyResult } from "../../models";

/**
 * Platform-specific surface used by `systemTrayHelpers.ts` so its
 * helper functions are free of `device.platform === ...` branches.
 *
 * Implemented by `AndroidNotificationUIDetector` and
 * `IosNotificationUIDetector`; selected per call site via
 * `createNotificationUIDetector`. Each detector captures its
 * {@link BootedDevice} at construction and reads side-effect
 * dependencies (ADB client, iOS CtrlProxy client, timer) lazily from
 * `getSystemTrayDependencies()` so callers can swap them in tests.
 *
 * Method shape rationale:
 *
 * - `isTrayOpen` is a pure predicate over a view hierarchy snapshot.
 *   Android matches systemui resource-ids / class hints; iOS matches
 *   NotificationCenter class hints rooted under SpringBoard.
 * - `expandTray` / `collapseTray` issue the platform-native gesture
 *   or shell command to toggle the shade / NotificationCenter. iOS
 *   needs the observation to read `screenSize` for its swipe path;
 *   Android ignores the argument.
 * - `getObservationTimestamp` returns the `minTimestamp` used to gate
 *   the next `observeScreen.execute(...)` call. Android uses an ADB
 *   `date +%s%3N`-style query so freshness is judged against the
 *   device's monotonic clock; iOS falls back to the local timer.
 * - `tapElement` / `swipeElement` issue a single tap / left-swipe on a
 *   specific notification row.
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
   * Open the notification shade / NotificationCenter. iOS requires
   * the observation for screen dimensions; Android ignores it.
   * Throws an `ActionableError` if a required prerequisite is missing.
   */
  expandTray(observation?: ObserveResult): Promise<void>;

  /**
   * Close the notification shade / NotificationCenter. iOS requires
   * the observation for screen dimensions; Android ignores it.
   * Throws an `ActionableError` if a required prerequisite is missing.
   */
  collapseTray(observation?: ObserveResult): Promise<void>;

  /**
   * Resolve a `minTimestamp` to feed into the next observation
   * request. Android queries the device clock via ADB so freshness
   * is measured against the device's monotonic time; iOS falls back
   * to the host timer.
   */
  getObservationTimestamp(): Promise<number>;

  /** Tap a notification row element. */
  tapElement(element: Element): Promise<void>;

  /** Left-swipe a notification row to dismiss it. */
  swipeElement(element: Element): Promise<void>;
}

/**
 * Result of a scoped Keychain/Keystore reset (issues #5187, #5188, #5190).
 *
 * The tool contract is scoped: callers name the `appId` whose secure-storage
 * test state they intend to reset. Not every platform can honor that scope:
 *
 * - **iOS Simulator** only exposes a device-wide `simctl keychain <udid> reset`,
 *   so it erases EVERY app's Keychain on that simulator regardless of `appId`.
 *   The result records this honestly with `scope: "all-apps"` and
 *   `exceededRequestedScope: true` so consumers never mistake it for a per-app
 *   operation.
 * - Scoped, app-owned resets (physical iOS #5188, Android #5190) will report
 *   `scope: "app"` and `exceededRequestedScope: false` once implemented.
 */
export interface ResetKeychainResult {
  success: boolean;
  deviceId: string;
  platform: "ios" | "android";
  /** The app scope the caller requested. Preserved even when the platform over-resets. */
  requestedAppId: string;
  /** Actual scope the platform could honor: one app, or every app on the device. */
  scope: "app" | "all-apps";
  /** True when the platform erased more than the requested `appId` (iOS Simulator). */
  exceededRequestedScope: boolean;
  message: string;
}

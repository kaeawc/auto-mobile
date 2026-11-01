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
 * - Android resets only app-declared aliases and reports `scope: "app"` with
 *   `exceededRequestedScope: false`. Physical iOS resets remain unsupported.
 */
export interface ResetKeychainResult {
  schemaVersion?: 1;
  capability?: "storage.keystore";
  bridgeAvailable?: boolean;
  /** Android-only deletion results. Refusals omit status and per-alias results. */
  requestedScope?: string | null;
  requestedAlias?: string | null;
  status?: "deleted" | "partial" | "failed" | null;
  deletedCount?: number;
  aliases?:
    | {
        alias: string;
        outcome: "deleted" | "not_found" | "locked" | "authentication_required" | "failed";
      }[]
    | null;
  outcome?:
    | "ok"
    | "disabled"
    | "unavailable"
    | "unsupported"
    | "scope_not_declared"
    | "authorization_denied"
    | "invalid_selector";
  reason?:
    | "DISABLED"
    | "BRIDGE_NOT_INSTALLED"
    | "BRIDGE_UNAVAILABLE"
    | "DECLARED_UNSUPPORTED"
    | "SCOPE_NOT_DECLARED"
    | "MUTATION_NOT_ALLOWED"
    | "EMPTY_SELECTOR"
    | null;
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

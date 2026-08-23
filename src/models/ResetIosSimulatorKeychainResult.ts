/**
 * Result of an explicit iOS Simulator Keychain reset (issue #5187).
 *
 * The reset is device-wide: it clears the Keychain for EVERY app on the target
 * simulator, not one app's credentials. `scope: "all-apps"` records that fact so
 * consumers never mistake it for a per-app operation.
 */
export interface ResetIosSimulatorKeychainResult {
  success: boolean;
  deviceId: string;
  platform: "ios";
  scope: "all-apps";
  message: string;
}

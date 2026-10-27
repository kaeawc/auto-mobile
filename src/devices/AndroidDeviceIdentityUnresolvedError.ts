import { AndroidIdentityUnresolvedError } from "./AndroidIdentityUnresolvedError";

/** adb lists the serial, but its unanswered probe prevents lifecycle identity resolution. */
export class AndroidDeviceIdentityUnresolvedError extends AndroidIdentityUnresolvedError {
  constructor(deviceId: string) {
    super(
      `target_identity_unresolved: Android emulator '${deviceId}' is listed by adb but did not answer its AVD-name probe, ` +
        "so it cannot be resolved for lifecycle coordination. Retry once it responds; " +
        "if it stays unresponsive, call killDevice for it and then startDevice.",
      [deviceId],
    );
  }
}

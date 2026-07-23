/**
 * Structured device-lock signal surfaced on `observe` (Android only).
 *
 * An agent driving a locked device otherwise sees a populated lock-screen tree
 * and no error, so it proceeds against the wrong UI. This lets it branch:
 * dismiss a swipe lock itself, or stop and ask the user for a PIN when the lock
 * is credential-protected (issue #4235). It sits beside `intentChooserDetected`
 * and `notificationPermissionDetected` — top-level "a system UI is blocking your
 * app" signals — on the observe result.
 */
export interface DeviceLockState {
  /** Whether the keyguard is currently obscuring the app under test. */
  locked: boolean;
  /** Whether the Android keyguard is showing. */
  keyguardShowing: boolean;
  /**
   * Whether the lock is credential-protected (PIN/pattern/password) rather than
   * a dismissable swipe lock. `undefined` when it could not be determined over
   * adb — deliberately left unset rather than guessed, so an agent never
   * mistakes a secure lock for a swipe lock it could dismiss on its own.
   */
  secure?: boolean;
}

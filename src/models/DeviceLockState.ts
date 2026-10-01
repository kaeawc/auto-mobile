/**
 * Structured device-lock signal surfaced on `observe` (Android and iOS simulators).
 *
 * An agent driving a locked device can otherwise see a lock-screen tree or a
 * failed hierarchy read, so it proceeds without a reliable lock signal. This lets it branch:
 * dismiss a swipe lock itself, or stop and ask the user for a PIN when the lock
 * is credential-protected (issue #4235). It sits beside `intentChooserDetected`
 * and `notificationPermissionDetected` — top-level "a system UI is blocking your
 * app" signals — on the observe result.
 */
export interface DeviceLockState {
  /** Whether the keyguard is currently obscuring the app under test. */
  locked: boolean;
  /** Whether the device lock screen or keyguard is showing. */
  keyguardShowing: boolean;
  /**
   * Whether the lock is credential-protected (PIN/pattern/password) rather than
   * a dismissable swipe lock. `undefined` when it could not be determined over
   * the platform — deliberately left unset rather than guessed, so an agent never
   * mistakes a secure lock for a swipe lock it could dismiss on its own.
   */
  secure?: boolean;
}

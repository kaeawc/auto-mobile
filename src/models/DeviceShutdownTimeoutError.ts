import { ActionableError } from "./ActionableError";

/**
 * A device shutdown (or a deadline-bounded phase of it) ran out of budget. Typed like
 * `provisionDevice`'s `timeout` so a controller that retries timeouts can branch on `code` and
 * `retryable` instead of the message text (#11548). `isShutdownTimeoutError` still classifies on
 * the message prefix, so existing callers are unaffected.
 */
export class DeviceShutdownTimeoutError extends ActionableError {
  readonly code = "timeout";
  readonly retryable = true;
}

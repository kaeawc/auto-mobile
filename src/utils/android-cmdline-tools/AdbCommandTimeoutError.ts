/**
 * Thrown when an adb command exceeds its effective `timeoutMs` budget, as
 * opposed to failing for a device reason (offline, adb error, non-numeric output).
 *
 * The distinction is load-bearing for callers that thread a request deadline — the
 * daemon's append-text path. They tell "our budget expired" apart from "the device
 * cannot answer" by an `instanceof` check, never a message match: the former must
 * NOT be cached (a later request with a fresh budget should retry), the latter is
 * cached so a dead device is not re-probed on every call. The message is preserved
 * verbatim, so existing message-based logging is unaffected.
 */
export class AdbCommandTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdbCommandTimeoutError";
  }
}

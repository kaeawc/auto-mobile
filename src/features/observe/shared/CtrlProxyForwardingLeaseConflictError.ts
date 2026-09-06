/**
 * Typed error for the CtrlProxy forwarding-lease conflict (issue #6260): this
 * device's forwarding lease is already held by another AutoMobile process,
 * most commonly a stale/orphaned daemon left behind by an incomplete
 * `--daemon restart`.
 *
 * Thrown by the platform-specific client (e.g. AndroidCtrlProxyClient) and
 * detected via `instanceof` by `DeviceServiceClient`/`RunnerReadinessService`
 * (PRRT ft82e) so the orphan-naming diagnostic is surfaced ONLY for this
 * specific condition — never for an ordinary `ECONNREFUSED`, timeout, or
 * other connect failure, which must keep the existing device diagnostics
 * (e.g. Android's `primaryUserStartState`/`deviceLock`). A tagged class is
 * used instead of matching the message substring so detection can't drift
 * from the thrown text.
 */
export class CtrlProxyForwardingLeaseConflictError extends Error {
  constructor(
    message: string,
    readonly ownerPid: number | undefined,
  ) {
    super(message);
    this.name = "CtrlProxyForwardingLeaseConflictError";
  }
}

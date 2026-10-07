import { defaultTimer, type Timer } from "../../../utils/SystemTimer";

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
    readonly ownerSocketPath?: string,
  ) {
    super(message);
    this.name = "CtrlProxyForwardingLeaseConflictError";
  }
}

/**
 * How long a recorded conflict explains a later tool failure on the device. A
 * conflict is cleared as soon as this process acquires the lease again.
 */
export const FORWARDING_LEASE_CONFLICT_TTL_MS = 60_000;

interface RecordedConflict {
  error: CtrlProxyForwardingLeaseConflictError;
  recordedAt: number;
}

const recentConflicts = new Map<string, RecordedConflict>();

/**
 * Remember that `deviceId`'s CtrlProxy connection failed on a lease conflict,
 * so a tool whose failure surfaces later as a missing hierarchy or device loss
 * can report the real cause instead (issue #10485).
 */
export function recordForwardingLeaseConflict(
  deviceId: string,
  error: CtrlProxyForwardingLeaseConflictError,
  timer: Timer = defaultTimer,
): void {
  recentConflicts.set(deviceId, { error, recordedAt: timer.now() });
}

export function clearForwardingLeaseConflict(deviceId: string): void {
  recentConflicts.delete(deviceId);
}

/** The unexpired lease conflict recorded for any of `deviceIds`, if one exists. */
export function recentForwardingLeaseConflict(
  deviceIds: Iterable<string> | undefined,
  timer: Timer = defaultTimer,
): CtrlProxyForwardingLeaseConflictError | undefined {
  for (const deviceId of deviceIds ?? []) {
    const recorded = recentConflicts.get(deviceId);
    if (!recorded) {
      continue;
    }
    if (timer.now() - recorded.recordedAt >= FORWARDING_LEASE_CONFLICT_TTL_MS) {
      recentConflicts.delete(deviceId);
      continue;
    }
    return recorded.error;
  }
  return undefined;
}

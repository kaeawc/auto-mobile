/**
 * The lease arithmetic of stall and host-sleep forgiveness (#10051, #10699, #11080), shared by
 * every lease the daemon judges on heartbeats: device sessions (`SessionManager.forgiveDaemonStall`)
 * and observer registrations (`ObserverSessionRegistry.forgiveStall`, #11554). The heartbeat
 * monitor detects a gap once; each store applies it with these functions, so an observer and a
 * session owner are excused the same interval under the same conditions.
 */

/**
 * A gap the daemon could hear no heartbeat in, as durations: a store that keeps its own clock
 * places the gap on that clock, ending at the instant the store is told of it.
 */
export interface StallGap {
  /** How long the daemon's own event loop stalled while the host was awake. */
  lostMs: number;
  /** How long the host was suspended. */
  sleptMs: number;
  /**
   * How long ago the gap can have begun at the earliest. Absent: forgive every lease, whenever its
   * holder last heartbeated.
   */
  gapAgeMs?: number;
}

/** A lease store other than the session manager that is excused the same gaps (#11554). */
export interface StallForgivingLeases {
  /** Move every lease that was running when the gap began forward by it; returns how many. */
  forgiveStall(gap: StallGap): number;
  /** Register the detector the store runs before every expiry judgement; undefined detaches it. */
  setStallProbe(probe: (() => void) | undefined): void;
}

/**
 * Whether a lease of `leaseMs` last renewed at `lastHeartbeat` was still running at `at` (#11080).
 * Asked of a gap's start with the raw heartbeat stamp, never a forgiven lease start, so successive
 * late scans cannot chain one forgiveness onto the last for a holder that is gone.
 */
export function leaseRunningAt(lastHeartbeat: number, leaseMs: number, at: number): boolean {
  return at - lastHeartbeat <= leaseMs;
}

/**
 * Where a lease that started at `leaseStart` starts once `leaseLostMs` of gap is excused: moved
 * forward by exactly the gap, never reset (#10662) and never past `resumedAt`, so time its holder
 * genuinely missed before the gap still counts.
 */
export function forgivenLeaseStart(
  leaseStart: number,
  resumedAt: number,
  leaseLostMs: number,
): number {
  return Math.max(leaseStart, Math.min(resumedAt, leaseStart + leaseLostMs));
}

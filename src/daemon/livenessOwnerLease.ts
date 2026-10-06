/**
 * The decision "is the current liveness owner's lease still live?" (#10050).
 *
 * A daemon rejects a claim from a different token only while this answers true.
 * It is a pure function of a snapshot so the suspect/grace window (#10051) can
 * extend the decision in one place without touching the claim path.
 */

import type { SessionLivenessPolicy } from "./sessionManager";

/** Everything the lease decision reads, captured at one instant. */
export interface LivenessOwnerLeaseSnapshot {
  /** The daemon clock reading to judge the lease against. */
  now: number;
  /** Time of the last heartbeat the session's owner delivered. */
  lastHeartbeat: number;
  /** The lease length: the session's heartbeat timeout. */
  heartbeatTimeoutMs: number;
  livenessPolicy: SessionLivenessPolicy;
}

/**
 * Whether the owner holds a live lease.
 *
 * The comparison is the heartbeat monitor's own reaping rule inverted (a session
 * is reaped when `now - lastHeartbeat > heartbeatTimeoutMs`), so an owner is never
 * "live" for a claim after the monitor would already have released the session.
 *
 * A `cli-idle` session is owned by one-shot `--cli` processes that exit between
 * invocations (#6870). Nobody is left to hold a lease, and the next invocation
 * necessarily arrives with a new per-process token, so a lease that long cannot
 * block it: a CLI session never has a live lease for conflict purposes.
 */
export function isLivenessOwnerLeaseLive(snapshot: LivenessOwnerLeaseSnapshot): boolean {
  if (snapshot.livenessPolicy === "cli-idle") {
    return false;
  }
  return snapshot.now - snapshot.lastHeartbeat <= snapshot.heartbeatTimeoutMs;
}

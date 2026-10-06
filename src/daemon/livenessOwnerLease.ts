/**
 * The decision "is the current liveness owner's lease still live?" (#10050) and
 * the suspect/grace window that follows lease expiry (#10051).
 *
 * A daemon rejects a claim from a different token while this answers true. It is
 * a pure function of a snapshot so the claim path, the reaper and `session-info`
 * all judge a lease the same way.
 */

import type { Session, SessionLivenessPolicy } from "./sessionManager";

/**
 * How long a session whose owner missed its lease is held, device still reserved
 * for the owner token, before it is released (#10051, owner decision 2026-10-05).
 */
export const SUSPECT_GRACE_MS = 10_000;

/**
 * - `live`: the owner's lease has not expired.
 * - `suspect`: the lease expired but the grace window has not; the session and
 *   its device are held for the owner token, and only the owner can restore it.
 * - `lapsed`: the lease and any grace are over; the session may be released.
 */
export type LivenessLeasePhase = "live" | "suspect" | "lapsed";

/** Everything the lease decision reads, captured at one instant. */
export interface LivenessOwnerLeaseSnapshot {
  /** The daemon clock reading to judge the lease against. */
  now: number;
  /** Time of the last heartbeat the session's owner delivered. */
  lastHeartbeat: number;
  /** The lease length: the session's heartbeat timeout. */
  heartbeatTimeoutMs: number;
  livenessPolicy: SessionLivenessPolicy;
  /** Length of the suspect window after lease expiry. Absent means no grace. */
  graceMs?: number;
}

/** The lease phase plus how long until it ends (the lease for `live`, the grace for `suspect`). */
export interface LivenessLeaseState {
  phase: LivenessLeasePhase;
  /** Milliseconds until the phase ends; 0 once `lapsed`. */
  remainingMs: number;
}

/**
 * Where the lease stands.
 *
 * The comparison is the heartbeat monitor's own reaping rule (a session is
 * reaped when `now - lastHeartbeat > heartbeatTimeoutMs`, plus the grace window
 * for a session that has one), so an owner is never reported live for a claim
 * after the monitor would already have released the session.
 */
export function livenessLeaseState(snapshot: LivenessOwnerLeaseSnapshot): LivenessLeaseState {
  const age = snapshot.now - snapshot.lastHeartbeat;
  if (age <= snapshot.heartbeatTimeoutMs) {
    return { phase: "live", remainingMs: snapshot.heartbeatTimeoutMs - age };
  }
  const graceEnd = snapshot.heartbeatTimeoutMs + (snapshot.graceMs ?? 0);
  if (age <= graceEnd) {
    return { phase: "suspect", remainingMs: graceEnd - age };
  }
  return { phase: "lapsed", remainingMs: 0 };
}

/**
 * Whether the owner still holds the session: its lease is live or it is inside
 * the suspect window.
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
  return livenessLeaseState(snapshot).phase !== "lapsed";
}

/** The slice of a session the lease reads. */
export type LeaseSession = Pick<
  Session,
  | "lastHeartbeat"
  | "lastOwnerHeartbeat"
  | "stallForgivenAt"
  | "heartbeatTimeoutMs"
  | "livenessPolicy"
  | "hasReceivedHeartbeat"
  | "ownership"
  | "livenessOwnershipReleased"
  | "livenessOwnershipRelease"
>;

/**
 * The last moment the daemon can vouch the owner's lease was running from.
 *
 * It is the owner's last heartbeat, or the daemon's resume point after a stall
 * of its own when that is later: a daemon cannot have received heartbeats while
 * it was stalled, so the stalled interval is never held against the owner.
 */
export function effectiveLastHeartbeat(
  session: Pick<LeaseSession, "lastHeartbeat" | "stallForgivenAt">,
): number {
  return Math.max(session.lastHeartbeat, session.stallForgivenAt ?? Number.NEGATIVE_INFINITY);
}

/**
 * The last moment the daemon can vouch the session's OWNER was alive, for the decision whether a
 * different token may claim it (#10050).
 *
 * `lastHeartbeat` is the session's activity clock: any tool call refreshes it, whoever made the
 * call, so a client that merely names the session (a second harness, or a restarted proxy that has
 * not claimed it yet) would keep the owner's lease looking live for as long as it kept working. The
 * owner lease is therefore read from `lastOwnerHeartbeat`, which only the owner's own heartbeats and
 * a recorded claim advance. A session that never had an owner stamp falls back to `lastHeartbeat`.
 */
export function ownerLeaseHeartbeat(
  session: Pick<LeaseSession, "lastHeartbeat" | "lastOwnerHeartbeat" | "stallForgivenAt">,
): number {
  return Math.max(
    session.lastOwnerHeartbeat ?? session.lastHeartbeat,
    session.stallForgivenAt ?? Number.NEGATIVE_INFINITY,
  );
}

/**
 * The suspect window a session is entitled to. Only a session whose owner has
 * actually delivered a heartbeat holds a lease worth a grace period. Release
 * retains precisely that existing grace; a session
 * that never heartbeated, an awaiting-owner rehydration and a `cli-idle` session
 * keep their existing release policies.
 */
export function suspectGraceMsFor(
  session: Pick<
    LeaseSession,
    | "livenessPolicy"
    | "hasReceivedHeartbeat"
    | "ownership"
    | "livenessOwnershipReleased"
    | "livenessOwnershipRelease"
  >,
): number {
  if (session.livenessOwnershipReleased) {
    return session.livenessOwnershipRelease?.graceMs ?? 0;
  }
  return session.livenessPolicy === "heartbeat" &&
    session.hasReceivedHeartbeat &&
    session.ownership === "owned"
    ? SUSPECT_GRACE_MS
    : 0;
}

/** Build the lease snapshot for a session at `now`. */
export function sessionLeaseSnapshot(
  session: LeaseSession,
  now: number,
): LivenessOwnerLeaseSnapshot {
  return {
    now,
    lastHeartbeat:
      session.livenessOwnershipReleased && session.livenessPolicy !== "cli-idle"
        ? ownerLeaseHeartbeat(session)
        : effectiveLastHeartbeat(session),
    heartbeatTimeoutMs: session.heartbeatTimeoutMs,
    livenessPolicy: session.livenessPolicy,
    graceMs: suspectGraceMsFor(session),
  };
}

/**
 * The lease snapshot the claim path judges, built from the owner's own heartbeats rather than the
 * session's tool activity (see {@link ownerLeaseHeartbeat}).
 */
export function sessionOwnerLeaseSnapshot(
  session: LeaseSession,
  now: number,
): LivenessOwnerLeaseSnapshot {
  return { ...sessionLeaseSnapshot(session, now), lastHeartbeat: ownerLeaseHeartbeat(session) };
}

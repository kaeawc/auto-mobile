/**
 * The decision "is the current liveness owner's lease still live?" (#10050) and
 * the suspect/grace window that follows lease expiry (#10051).
 *
 * A daemon rejects a claim from a different token while this answers true. It is
 * a pure function of a snapshot so the claim path, the reaper and `session-info`
 * all judge a lease the same way.
 */

import type { SessionLivenessClock } from "./sessionClocks";
import type { Session, SessionLivenessPolicy } from "./sessionManager";
import { SUSPECT_GRACE_MS } from "./sessionLivenessWindows";

/**
 * How long a session whose owner missed its lease is held, device still reserved
 * for the owner token, before it is released (#10051). Defined with the other
 * release windows in `./sessionLivenessWindows`.
 */
export { SUSPECT_GRACE_MS };

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
 * The owner's hold reported with a refused claim (#10701): the lease phase, the time left in it,
 * and the time until the hold ends entirely (lease plus suspect grace), after which a claim wins.
 */
export interface LivenessOwnerHold {
  state: LivenessLeasePhase;
  remainingMs: number;
  holdRemainingMs: number;
}

/** Where the owner's hold stands, judged on the same snapshot the claim path judges. */
export function livenessOwnerHold(snapshot: LivenessOwnerLeaseSnapshot): LivenessOwnerHold {
  const { phase, remainingMs } = livenessLeaseState(snapshot);
  const holdEnd = snapshot.heartbeatTimeoutMs + (snapshot.graceMs ?? 0);
  return {
    state: phase,
    remainingMs,
    holdRemainingMs: Math.max(0, holdEnd - (snapshot.now - snapshot.lastHeartbeat)),
  };
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

/**
 * The slice of a session the lease reads: its liveness clocks, never an activity clock (#10703).
 */
export type LeaseSession = Pick<
  Session,
  | SessionLivenessClock
  | "heartbeatTimeoutMs"
  | "livenessPolicy"
  | "hasReceivedHeartbeat"
  | "ownership"
  | "livenessOwnerToken"
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
 * Whether the session's lease is judged on its owner's own heartbeats (#11107): an owned session
 * that has heartbeated. `lastHeartbeat` is also stamped by tool calls from any connection, so such
 * a session must not let a non-owner's calls stand in for its owner. A session no proxy owns keeps
 * the activity-refreshed `lastHeartbeat`.
 */
export function judgesOwnerHeartbeats(
  session: Pick<LeaseSession, "livenessOwnerToken" | "hasReceivedHeartbeat">,
): boolean {
  return session.livenessOwnerToken !== undefined && session.hasReceivedHeartbeat;
}

/**
 * The lease start the session is judged on: {@link ownerLeaseHeartbeat} when
 * {@link judgesOwnerHeartbeats}, else {@link effectiveLastHeartbeat}. Stall forgiveness anchors on
 * it too (#11162), so the daemon's stall extends the lease that is actually judged and a
 * non-owner's tool call cannot restart a dead owner's lease through it.
 */
export function judgedLeaseHeartbeat(session: LeaseSession): number {
  return judgesOwnerHeartbeats(session)
    ? ownerLeaseHeartbeat(session)
    : effectiveLastHeartbeat(session);
}

/**
 * Whether an owned session's owner lease was still running at `at` (#11080): `at` is within one
 * lease of the owner's last heartbeat. The daemon's stall forgiveness asks this of a gap's start,
 * so it excuses only owners that were live when the daemon stopped hearing them. Read from the
 * raw heartbeat stamp, not the forgiven lease start, so successive late scans cannot chain one
 * forgiveness onto the last for an owner that is gone; and, for a session judged on its owner's
 * heartbeats, from `lastOwnerHeartbeat` rather than the activity-refreshed `lastHeartbeat`, so a
 * non-owner's tool call cannot make a dead owner look live (#11162). A session not owned (awaiting
 * its rehydrated owner) has no owner lease to have lapsed, and an absent `at` asks nothing: both
 * are treated as live.
 */
export function ownerLeaseLiveAt(
  session: Pick<
    LeaseSession,
    | "lastHeartbeat"
    | "lastOwnerHeartbeat"
    | "heartbeatTimeoutMs"
    | "ownership"
    | "livenessOwnerToken"
    | "hasReceivedHeartbeat"
  >,
  at: number | undefined,
): boolean {
  if (at === undefined || session.ownership !== "owned") {
    return true;
  }
  const lastHeartbeat = judgesOwnerHeartbeats(session)
    ? (session.lastOwnerHeartbeat ?? session.lastHeartbeat)
    : session.lastHeartbeat;
  return at - lastHeartbeat <= session.heartbeatTimeoutMs;
}

/**
 * The suspect window a session is entitled to. Only a session whose owner has
 * actually delivered a heartbeat holds a lease worth a grace period; a session
 * that never heartbeated, an awaiting-owner rehydration and a `cli-idle` session
 * keep their existing release policies.
 */
export function suspectGraceMsFor(
  session: Pick<LeaseSession, "livenessPolicy" | "hasReceivedHeartbeat" | "ownership">,
): number {
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
    lastHeartbeat: effectiveLastHeartbeat(session),
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

/**
 * The lease snapshot that decides whether a session is live, suspect or lapsed (#11107).
 *
 * An owned session that has heartbeated is judged on its owner's own heartbeats, exactly as
 * `SessionHeartbeatMonitor` judges release: `lastHeartbeat` is also stamped by tool calls from any
 * connection, so judging suspect on it would let a non-owner's calls hide a dead owner and the
 * session would never enter its suspect window. A session no proxy owns keeps the
 * activity-refreshed fallback.
 */
export function sessionJudgedLeaseSnapshot(
  session: LeaseSession,
  now: number,
): LivenessOwnerLeaseSnapshot {
  return { ...sessionLeaseSnapshot(session, now), lastHeartbeat: judgedLeaseHeartbeat(session) };
}

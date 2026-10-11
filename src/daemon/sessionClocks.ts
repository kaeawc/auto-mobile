import type { Session } from "./sessionManager";

/**
 * The names of a device session's two kinds of clock (#10656, #10668, #10703).
 *
 * - **Activity clocks** say when the session was last USED. Only tool usage may write them, and
 *   an idle-expiry judgement reads only them.
 * - **Liveness clocks** say the owner process is still ALIVE. Heartbeats, claims and stall
 *   forgiveness write them, and a lease judgement reads only them.
 *
 * `test/lint/livenessActivityClockSeparation.test.ts` imports these lists rather than repeating
 * the names, and each list is checked against the `Session` fields it names, so renaming a field
 * fails the typecheck here instead of silently escaping the guard.
 */
export const SESSION_ACTIVITY_CLOCKS = [
  "lastUsedAt",
  "expiresAt",
  "idleStallForgivenAt",
] as const satisfies readonly (keyof Session)[];

/** Session liveness clocks: timestamps of the owner's last proof of life. */
export const SESSION_LIVENESS_CLOCKS = [
  "lastHeartbeat",
  "lastOwnerHeartbeat",
  "stallForgivenAt",
  "hasReceivedHeartbeat",
] as const satisfies readonly (keyof Session)[];

/**
 * The stdio proxy's replay-lease clock (`DaemonMcpProxy.boundSessionUuidAt`). A held session's
 * `lastUsedAt` (#10677) is covered by {@link SESSION_ACTIVITY_CLOCKS}: only a tool call naming
 * the session may stamp it.
 */
export const PROXY_ACTIVITY_CLOCKS = ["boundSessionUuidAt"] as const;

/** A session field that records the owner's liveness. */
export type SessionLivenessClock = (typeof SESSION_LIVENESS_CLOCKS)[number];

/**
 * The moment a `cli-idle` session's idle window is measured from: its last tool activity, or the
 * daemon's resume point after a stall of its own when that is later (#10835). The stalled interval
 * is the daemon's lost time, not the CLI's idleness.
 */
export function effectiveLastToolActivity(
  session: Pick<Session, "lastUsedAt" | "idleStallForgivenAt">,
): number {
  return Math.max(session.lastUsedAt, session.idleStallForgivenAt ?? Number.NEGATIVE_INFINITY);
}

/** What {@link sessionIdleDeadline} reads of a session. */
export type SessionIdleDeadlineSnapshot = Pick<
  Session,
  "livenessPolicy" | "lastUsedAt" | "idleStallForgivenAt" | "heartbeatTimeoutMs" | "expiresAt"
>;

/**
 * The one answer to "when does this session idle-expire", on the session clock (#11558). Every
 * idle judgement derives from it: the scan that releases an idle session (the idle sweep, and the
 * heartbeat monitor for a `cli-idle` session), the lazy-expiry check when a new call is admitted,
 * and the `idleReleaseAt` a client is told. A session is idle-expired once the clock is PAST this
 * instant, never at it.
 *
 * A `cli-idle` session's deadline is its CLI idle window (`heartbeatTimeoutMs`, which adopting the
 * policy set to that window) after its last tool activity, moved by the daemon's own stalls
 * ({@link effectiveLastToolActivity}). Every other session's is `expiresAt`, which each tool call
 * and each forgiven stall moves directly.
 */
export function sessionIdleDeadline(session: SessionIdleDeadlineSnapshot): number {
  if (session.livenessPolicy === "cli-idle") {
    return effectiveLastToolActivity(session) + session.heartbeatTimeoutMs;
  }
  return session.expiresAt;
}

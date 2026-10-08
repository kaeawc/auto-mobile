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
] as const satisfies readonly (keyof Session)[];

/** Session liveness clocks: timestamps of the owner's last proof of life. */
export const SESSION_LIVENESS_CLOCKS = [
  "lastHeartbeat",
  "lastOwnerHeartbeat",
  "stallForgivenAt",
] as const satisfies readonly (keyof Session)[];

/**
 * The stdio proxy's replay-lease clock (`DaemonMcpProxy.boundSessionUuidAt`). A held session's
 * `lastUsedAt` (#10677) is covered by {@link SESSION_ACTIVITY_CLOCKS}: only a tool call naming
 * the session may stamp it.
 */
export const PROXY_ACTIVITY_CLOCKS = ["boundSessionUuidAt"] as const;

/** A session field that records the owner's liveness. */
export type SessionLivenessClock = (typeof SESSION_LIVENESS_CLOCKS)[number];

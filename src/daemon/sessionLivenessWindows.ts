/**
 * The device-session release windows, in one place (owner decision 2026-10-08).
 *
 * A device session is released:
 *
 * 1. about 10 s after its owner's last heartbeat (no heartbeat): the owner lease
 *    ({@link DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS}), then the suspect grace
 *    ({@link SUSPECT_GRACE_MS}), then at most one heartbeat-monitor scan
 *    ({@link DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS}) sum to
 *    {@link NO_HEARTBEAT_RELEASE_BUDGET_MS};
 * 2. {@link DEFAULT_SESSION_IDLE_TIMEOUT_MS} after the END of its last tool call
 *    while heartbeats keep arriving (idle). A tool call in flight is activity
 *    and is never released mid-call.
 *
 * The proxy heartbeats every {@link PROXY_HEARTBEAT_INTERVAL_MS}: one late or
 * lost beat never lapses the lease, and an owner must miss four consecutive
 * beats before its session can be released. The lease and grace are split
 * evenly so the proxy's own liveness recovery (detection after one unanswered
 * heartbeat, then three attempts, see `proxyLivenessRecovery.ts`) completes
 * inside lease plus grace at the default cadence. Every dependent window (the
 * proxy's bound-session replay TTL, its held-session eviction, the CLI idle
 * timeout) derives from these values rather than restating them.
 *
 * Kept free of imports from the session machinery so the CLI-side proxy can read
 * it without loading the daemon.
 */

/** Length of the owner lease: how long after a heartbeat the owner is still live. */
export const DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS = 4_000;

/**
 * How long a session whose owner missed its lease is held, device still reserved
 * for the owner token, before it is released (#10051).
 */
export const SUSPECT_GRACE_MS = 4_000;

/** How often the daemon's heartbeat monitor scans for stale and idle sessions. */
export const DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS = 2_000;

/** Worst-case time from the owner's last heartbeat to the session's release. */
export const NO_HEARTBEAT_RELEASE_BUDGET_MS =
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS +
  SUSPECT_GRACE_MS +
  DEFAULT_SESSION_HEARTBEAT_CHECK_INTERVAL_MS;

/** The MCP proxy's bound-session heartbeat cadence. */
export const PROXY_HEARTBEAT_INTERVAL_MS = 2_000;

/**
 * Default idle window: how long a heartbeating session with no tool call in flight
 * keeps its device, measured from the end of its last tool call.
 */
export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

/** Env override for {@link DEFAULT_SESSION_IDLE_TIMEOUT_MS} (#10671). */
export const SESSION_IDLE_TIMEOUT_ENV = "AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS";
/** Legacy-prefixed alias of {@link SESSION_IDLE_TIMEOUT_ENV}. */
export const LEGACY_SESSION_IDLE_TIMEOUT_ENV = "AUTO_MOBILE_SESSION_IDLE_TIMEOUT_MS";

/**
 * The configured idle window. A value that is not a positive base-10 integer is
 * ignored in favour of the default, matching the other session timing knobs.
 */
export function getSessionIdleTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const rawValue = env[SESSION_IDLE_TIMEOUT_ENV] ?? env[LEGACY_SESSION_IDLE_TIMEOUT_ENV];
  const parsed = rawValue && /^\d+$/.test(rawValue.trim()) ? Number(rawValue.trim()) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_IDLE_TIMEOUT_MS;
}

import { ENV } from "../../config/env";
import { SCREEN_READER_RESTORE_TIMEOUT_MS } from "../../features/accessibility/ScreenReaderRestore";
import { exponentialBackoff, type BackoffPolicy } from "../../utils/Backoff";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../utils/deviceTimeouts";
import { readEnvPositiveInteger } from "../../utils/envNumbers";
import { SESSION_RELEASE_DRAIN_TIMEOUT_MS } from "../wire/constants";
import type { SessionReleaseReason } from "../releaseReasons";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  getSessionHeartbeatCheckIntervalMs,
} from "../wire/sessionLivenessWindows";
import type { Session, SessionCacheData } from "./sessionTypes";

/**
 * `device_sessions.source` of a session an acquisition without an MCP connection id (a `--cli`
 * startDevice/getAndroid/getApple) created. Only such a session may be reused by another anonymous
 * acquisition of its device (#2421, #11071); it is persisted, so a daemon restart keeps the rule.
 */
export const ANONYMOUS_ACQUISITION_SESSION_SOURCE = "anonymous-acquisition";

/**
 * `device_sessions.source` of a derived `<base>:<label>` session a multi-device plan run minted
 * (#11572). Its lifetime is that plan run: the row is never rehydrated after a daemon restart, a
 * call naming it outside its run is refused as terminal, and only a later plan run's allocation
 * may mint the name again. It is persisted, so a daemon restart keeps the rule.
 */
export const PLAN_LABEL_SESSION_SOURCE = "plan-label";

/** Whether an anonymous acquisition (no MCP connection id) created this session (#11071). */
export function isAnonymousAcquisitionSession(session: Session): boolean {
  return session.persistenceMetadata?.source === ANONYMOUS_ACQUISITION_SESSION_SOURCE;
}

export const KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS = 1_000;

export const BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS = 1_000;

export const NETWORK_CONDITION_RESTORE_TIMEOUT_MS = 1_000;

/**
 * Clock restore ends with `adb unroot`, which restarts adbd: the device goes offline and the
 * restore only finishes once it reconnects (a few seconds on an emulator). The network path's
 * 1 s deadline fired on every successful restore and quarantined it for nothing (#10771).
 */
export const CLOCK_RESTORE_TIMEOUT_MS = 15_000;

export const NETWORK_CONDITION_RESTORE_RETRY_DELAY_MS = 250;

export const SESSION_SETUP_DRAIN_TIMEOUT_MS = 1_000;

/**
 * Cap for pending keep-awake, biometric and network teardown retries, measured with the
 * injected Timer. The release awaits their separately bounded first attempts, then hands
 * pending work back as device cleanup. Teardown runs under its own signal, not the caller's;
 * this cap stops wedged retries from holding the device quarantined. Screen-reader, clock
 * and rotation restores keep their own budgets and abandon mechanisms (#10198).
 */
export const SESSION_RELEASE_TEARDOWN_CAP_MS = 10_000;

/**
 * Bound on one release's `markReleased` write (#10836). It is the only await on the release
 * path that has no budget of its own, so a wedged DB write would otherwise hold the session's
 * device forever. A terminal release that reaches it keeps the session fenced in memory, frees
 * the device, and leaves the row for a later release to persist. It is longer than the shutdown
 * release drain by 1 s, so a write wedged at shutdown still keeps the database open and the
 * release on the drain's daemon-shutdown fallback path.
 */
export const SESSION_RELEASE_PERSIST_TIMEOUT_MS = SESSION_RELEASE_DRAIN_TIMEOUT_MS + 1_000;

/**
 * Scheduling slack between stages separated only by microtasks; monitor scan granularity is
 * budgeted separately. This is the only slack a release waiting on a pending rebind gets.
 */
export const SESSION_RELEASE_STUCK_MARGIN_MS = 2_000;

/** First attempts plus two row writes and scheduling slack: 18 s without own-budget state. */
export const SESSION_RELEASE_STUCK_DEADLINE_MS =
  SESSION_SETUP_DRAIN_TIMEOUT_MS +
  KEEP_SCREEN_AWAKE_RESTORE_TIMEOUT_MS +
  BIOMETRIC_ENROLLMENT_RESTORE_TIMEOUT_MS +
  NETWORK_CONDITION_RESTORE_TIMEOUT_MS +
  2 * SESSION_RELEASE_PERSIST_TIMEOUT_MS +
  SESSION_RELEASE_STUCK_MARGIN_MS;

/**
 * The first attempts a release actually awaits: 18 s plus clock (15 s), rotation (1 s) and
 * screen-reader (35 s) budgets when it carries that state. Pending retries do not hold release.
 */
export function getSessionReleaseStuckDeadlineMs(
  state?: Pick<SessionCacheData, "clock" | "rotation" | "screenReader">,
): number {
  return (
    SESSION_RELEASE_STUCK_DEADLINE_MS +
    (state?.clock ? CLOCK_RESTORE_TIMEOUT_MS : 0) +
    (state?.rotation ? NETWORK_CONDITION_RESTORE_TIMEOUT_MS : 0) +
    (state?.screenReader ? SCREEN_READER_RESTORE_TIMEOUT_MS : 0)
  );
}

/**
 * Force at the first scan at or after the per-release deadline measured from teardown's start
 * (the ownership hold's cap while pending), even when a monitor reap joins it: one interval,
 * then the capped forced quarantine. A second interval allows a late timer tick. With the
 * default 2 s interval this advertises 32 s without clock, rotation or screen-reader state.
 * Every release in flight is tracked and forced by the monitor at its stuck deadline.
 */
export function getSessionReleaseCleanupWorstCaseMs(
  env: NodeJS.ProcessEnv = process.env,
  state?: Pick<SessionCacheData, "clock" | "rotation" | "screenReader">,
): number {
  return (
    getSessionReleaseStuckDeadlineMs(state) +
    2 * getSessionHeartbeatCheckIntervalMs(env) +
    SESSION_RELEASE_TEARDOWN_CAP_MS
  );
}

/**
 * Bound on a session creation's own waits (#10963): a release of the same UUID still in flight,
 * and the creation's DB reads and writes. A device bind runs these under the pool's assignment
 * mutex, and the SQLite dialect queues every query behind an open transaction, so an unbounded
 * await held every other assignment for as long as the DB stayed wedged. Covers a release's
 * capped teardown and its bounded writes, with margin, like the pool's create-release wait.
 */
export const SESSION_CREATE_WAIT_TIMEOUT_MS =
  SESSION_RELEASE_TEARDOWN_CAP_MS + 2 * SESSION_RELEASE_PERSIST_TIMEOUT_MS + 10_000;

/** Non-terminal release reason recorded for a creation abandoned at its deadline (#10963). */
export const SESSION_CREATION_TIMEOUT_REASON =
  "session-creation-timeout" satisfies SessionReleaseReason;

/**
 * Retry delays for a terminal release write that timed out and then failed (#10959). The in-memory
 * fence keeps the UUID refused for this process; the row must still become terminal before a
 * restart, or the next daemon would admit the released UUID again. Retried until it lands.
 */
export const DEFAULT_TERMINAL_RELEASE_RETRY_BACKOFF: BackoffPolicy = exponentialBackoff({
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
});

export const SESSION_REHYDRATION_DEADLINE_MS = 15_000;

/** Persisted rows recovered at once during startup rehydration (#11114). */
export const SESSION_REHYDRATION_CONCURRENCY = 4;

/** Plan cleanup frees devices; the base and label UUIDs may be issued again by name (not rehydrated). */
export const PLAN_AUTO_RELEASE_REASON = "plan-auto-release" satisfies SessionReleaseReason;

export function getDefaultSessionHeartbeatTimeoutMs(): number {
  return readEnvPositiveInteger(
    ENV.SESSION_HEARTBEAT_TIMEOUT_MS.name,
    ENV.SESSION_HEARTBEAT_TIMEOUT_MS.legacyName,
    { fallback: DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS },
  );
}

/** Default grace before a never-heartbeated default-policy session is reaped. */
export const DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS = 5_000;

// Give a restarted emulator the same three-minute cold-boot allowance as device readiness.
export const DEVICE_RESTART_RECOVERY_WINDOW_MS = DEFAULT_DEVICE_READY_TIMEOUT_MS;

/**
 * The grace `SessionHeartbeatMonitor` applies before reaping a default-policy
 * session that never sent its first heartbeat. Single-sourced here so the
 * `missing-first-heartbeat` release snapshot reports the deadline that actually
 * fired — the grace, not the (longer) heartbeat timeout — instead of leaving a
 * reader to conclude the daemon reaped early (issue #5689).
 */
export function getDefaultPreFirstHeartbeatGraceMs(): number {
  return readEnvPositiveInteger(
    ENV.SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS.name,
    ENV.SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS.legacyName,
    { fallback: DEFAULT_PRE_FIRST_HEARTBEAT_GRACE_MS },
  );
}

/**
 * The `managed-execution` session liveness policy (epic #11172, #11176).
 *
 * A session a managed slot execution acquired is held by that execution's stdio proxy for the
 * execution's whole lifetime. It keeps the ordinary owner-heartbeat lease (4 s lease plus 4 s
 * suspect grace, so ~10 s after the last heartbeat). A non-lapsed owner lease exempts it from
 * idle release (owner decision 2026-10-12). A lapsed lease ends through the heartbeat path,
 * never idle cleanup. The validated 2–60 minute idleTimeoutMs remains stored and reported;
 * it does not end a live-owned execution. Persisted rows have no heartbeat stamp, so recovery
 * ignores their idle deadline and retains the existing awaiting-owner and recovery bounds.
 *
 * Kept free of the session machinery so the proxy and the request handlers can read it cheaply.
 */

import {
  MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS,
  MIN_MANAGED_SLOT_IDLE_TIMEOUT_MS,
  ManagedSlotConfigError,
} from "../models/managedSlotConfig";
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "./sessionLivenessWindows";
import type { LivenessLeasePhase } from "./livenessOwnerLease";

export const MANAGED_EXECUTION_LIVENESS_POLICY = "managed-execution";

/**
 * The shared idle-deadline exception. Without a lease phase (persistence and idle reapers),
 * managed executions defer entirely to owner-loss/recovery rules. Reporting supplies the judged
 * phase: only live and suspect leases advertise exemption, never a lapsed owner.
 */
export function ignoresManagedExecutionIdleDeadline(
  policy: string | null | undefined,
  leasePhase?: LivenessLeasePhase,
): boolean {
  return policy === MANAGED_EXECUTION_LIVENESS_POLICY && leasePhase !== "lapsed";
}

/**
 * Bound on the proxy's release of its managed execution sessions at shutdown (stdin EOF, owner
 * loss). Short so release lands within ~2 s of the end of the execution; past it the daemon's
 * no-heartbeat release still frees the session.
 */
export const MANAGED_EXECUTION_RELEASE_TIMEOUT_MS = 1_500;

/** The policies whose sessions are judged on their owner's heartbeat lease. */
export function holdsOwnerHeartbeatLease(policy: string): boolean {
  return policy === "heartbeat" || policy === MANAGED_EXECUTION_LIVENESS_POLICY;
}

/** Whether a declared idle window is inside the managed-execution bounds. */
export function isManagedExecutionIdleTimeoutInBounds(idleTimeoutMs: number): boolean {
  return (
    Number.isSafeInteger(idleTimeoutMs) &&
    idleTimeoutMs >= MIN_MANAGED_SLOT_IDLE_TIMEOUT_MS &&
    idleTimeoutMs <= MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS
  );
}

/**
 * The idle window of a managed-execution session: the declared override, else the 2-minute
 * default. The config schema already bounds the override; the daemon re-checks it because the
 * value crosses a socket, and refuses (rather than clamps) a value outside the bounds so a launcher
 * bug surfaces instead of silently holding a device for a different window than it asked for.
 */
export function resolveManagedExecutionIdleTimeoutMs(idleTimeoutMs?: number): number {
  if (idleTimeoutMs === undefined) {
    return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  }
  if (!isManagedExecutionIdleTimeoutInBounds(idleTimeoutMs)) {
    throw new ManagedSlotConfigError(
      "managed_slot_config_invalid",
      `managed execution idleTimeoutMs ${String(idleTimeoutMs)} must be an integer between ` +
        `${MIN_MANAGED_SLOT_IDLE_TIMEOUT_MS} and ${MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS}`,
    );
  }
  return idleTimeoutMs;
}

/**
 * A persisted managed-execution idle window, brought back inside the bounds on recovery. The row
 * was written by this daemon, so an out-of-range value is corruption, not a request; clamping keeps
 * the rehydrated session on a valid window instead of failing recovery.
 */
export function clampManagedExecutionIdleTimeoutMs(idleTimeoutMs: number): number {
  if (!Number.isFinite(idleTimeoutMs)) {
    return DEFAULT_SESSION_IDLE_TIMEOUT_MS;
  }
  return Math.min(
    MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS,
    Math.max(MIN_MANAGED_SLOT_IDLE_TIMEOUT_MS, Math.trunc(idleTimeoutMs)),
  );
}

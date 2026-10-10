/**
 * The `managed-execution` session liveness policy (epic #11172, #11176).
 *
 * A session a managed slot execution acquired is held by that execution's stdio proxy for the
 * execution's whole lifetime. It keeps the ordinary owner-heartbeat lease (4 s lease plus 4 s
 * suspect grace, so ~10 s after the last heartbeat), and the ordinary idle rule measured from the
 * end of the last tool call: reads never count. Only the idle WINDOW differs: the 2-minute default,
 * or the longer `idleTimeoutMs` the launcher-trusted slot config declared, bounded to 2–60 minutes
 * (owner decision 2026-10-09, Q1: configurable, never exempt).
 *
 * Kept free of the session machinery so the proxy and the request handlers can read it cheaply.
 */

import {
  MAX_MANAGED_SLOT_IDLE_TIMEOUT_MS,
  MIN_MANAGED_SLOT_IDLE_TIMEOUT_MS,
  ManagedSlotConfigError,
} from "../models/managedSlotConfig";
import { DEFAULT_SESSION_IDLE_TIMEOUT_MS } from "./sessionLivenessWindows";

export const MANAGED_EXECUTION_LIVENESS_POLICY = "managed-execution";

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

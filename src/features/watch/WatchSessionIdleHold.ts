import {
  DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
} from "../../daemon/wire/constants";
import { toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

/**
 * Declares a one-shot CLI session's idle window to the daemon (a `daemon/heartbeat` with the `cli`
 * liveness policy and `idleTimeoutMs`). The window is measured from the session's last control
 * call, not from the declaration, so a declaration alone is not use (#10656).
 */
export interface CliIdleWindowDeclarer {
  declareIdleWindow(idleTimeoutMs: number): Promise<void>;
}

export interface CliSessionIdleHoldOptions {
  /** The idle window the session keeps after the run; defaults to the CLI default. */
  baseIdleTimeoutMs?: number;
  /** How often the window is widened while the run is in flight. */
  refreshIntervalMs?: number;
}

/**
 * The window to declare `elapsedMs` into a hold. The session's last control call came before the
 * hold started and less than `baseMs` before it (or the session would already be idle-released),
 * so `elapsedMs + 2 * baseMs` puts the idle deadline more than `baseMs` past now. Clamped to the
 * daemon's one-hour ceiling.
 */
export function heldIdleWindowMs(elapsedMs: number, baseMs: number): number {
  return Math.min(Math.max(0, elapsedMs) + 2 * baseMs, MAX_CLI_SESSION_IDLE_TIMEOUT_MS);
}

/**
 * Run work that drives a device without daemon tool calls (the watch runner WebSocket, #17992)
 * while keeping its one-shot CLI session from idle release. The session's idle clock only moves
 * on control calls, and a `cli` heartbeat is otherwise a no-op, so the hold widens the declared
 * idle window from the run's start and keeps widening it, leaving the session at least the base
 * window once the run ends. The daemon caps the window at one hour of idleness.
 */
export async function withCliSessionIdleHold<T>(
  declarer: CliIdleWindowDeclarer,
  timer: Timer,
  run: () => Promise<T>,
  options: CliSessionIdleHoldOptions = {},
): Promise<T> {
  const baseMs = options.baseIdleTimeoutMs ?? DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS;
  const refreshIntervalMs = options.refreshIntervalMs ?? Math.floor(baseMs / 4);
  const startedAt = timer.now();
  const declare = () =>
    declarer.declareIdleWindow(heldIdleWindowMs(timer.now() - startedAt, baseMs));
  try {
    await declare();
  } catch (error) {
    throw toActionableError(error, "Failed to hold the watch session through the daemon");
  }
  const refresh = () => {
    void declare().catch((error: unknown) => {
      // The next tick retries; a missed refresh still leaves more than the base window.
      logger.warn(`Watch session idle hold refresh failed: ${errorMessage(error)}`, error);
    });
  };
  const interval = timer.setInterval(refresh, refreshIntervalMs);
  try {
    return await run();
  } finally {
    timer.clearInterval(interval);
    await declare().catch((error: unknown) => {
      logger.warn(`Watch session idle hold final refresh failed: ${errorMessage(error)}`, error);
    });
  }
}

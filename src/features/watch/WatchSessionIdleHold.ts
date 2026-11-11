import {
  CLI_SESSION_LIVENESS_POLICY,
  DAEMON_HEARTBEAT_METHOD,
  DEFAULT_CLI_SESSION_IDLE_TIMEOUT_MS,
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
} from "../../daemon/wire/constants";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";

/**
 * Declares a one-shot CLI session's idle window to the daemon (a `daemon/heartbeat` with the `cli`
 * liveness policy and `idleTimeoutMs`). The window is measured from the session's last control
 * call, not from the declaration, so a declaration alone is not use (#10656).
 */
export interface CliIdleWindowDeclarer {
  /** When the session's last control call was, as wall-clock epoch ms (its idle clock's origin). */
  lastControlCallAt(): Promise<number>;
  declareIdleWindow(idleTimeoutMs: number): Promise<void>;
}

/** The daemon control-socket calls {@link daemonCliIdleWindowDeclarer} makes. */
export interface IdleWindowDaemonClient {
  connect(): Promise<void>;
  callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number },
  ): Promise<unknown>;
}

const DECLARATION_TIMEOUT_MS = 5_000;
const SESSION_INFO_METHOD = "daemon/sessionInfo";

/**
 * Declares the window the way a one-shot `--cli` invocation does: a liveness ownership claim under
 * `ownerToken` with the `cli` policy. A `cli-idle` session holds no lease against a claim, so the
 * claim is admitted and the window applied. A `cli-keeper` heartbeat would be acknowledged without
 * any change, and a tokenless one is ignored once the session has an owner token.
 */
export function daemonCliIdleWindowDeclarer(
  client: IdleWindowDaemonClient,
  sessionId: string,
  ownerToken: string,
): CliIdleWindowDeclarer {
  return {
    lastControlCallAt: async () => {
      await client.connect();
      const info = await client.callDaemonMethod(
        SESSION_INFO_METHOD,
        { sessionId },
        { timeoutMs: DECLARATION_TIMEOUT_MS },
      );
      const lastUsedAt =
        typeof info === "object" && info !== null ? Reflect.get(info, "lastUsedAt") : undefined;
      if (typeof lastUsedAt !== "number" || !Number.isFinite(lastUsedAt)) {
        throw new ActionableError(
          `Session ${sessionId} did not report when it was last used, so its idle window cannot be held while the watch runner is driven.`,
        );
      }
      return lastUsedAt;
    },
    declareIdleWindow: async (idleTimeoutMs) => {
      await client.connect();
      const result = await client.callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        {
          sessionId,
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          livenessOwnerToken: ownerToken,
          claimLivenessOwnership: true,
          idleTimeoutMs,
        },
        { timeoutMs: DECLARATION_TIMEOUT_MS },
      );
      if (
        typeof result === "object" &&
        result !== null &&
        Reflect.get(result, "livenessUnchanged") === true
      ) {
        throw new ActionableError(
          `Session ${sessionId} did not take the CLI idle window (its liveness policy is unchanged), so it cannot be held while the watch runner is driven.`,
        );
      }
    },
  };
}

export interface CliSessionIdleHoldOptions {
  /** The idle window the session keeps after the run; defaults to the CLI default. */
  baseIdleTimeoutMs?: number;
  /** How often the window is widened while the run is in flight. */
  refreshIntervalMs?: number;
}

/**
 * The window to declare when the session's last control call is `idleAgeMs` old. The daemon
 * measures the window from that call, so `idleAgeMs + 2 * baseMs` puts the idle deadline two base
 * windows past now however old the call is (a previous hold may have left it many windows old), and
 * never before a deadline an earlier hold declared. Clamped to the daemon's one-hour ceiling.
 */
export function heldIdleWindowMs(idleAgeMs: number, baseMs: number): number {
  return Math.min(Math.max(0, idleAgeMs) + 2 * baseMs, MAX_CLI_SESSION_IDLE_TIMEOUT_MS);
}

/**
 * Run work that drives a device without daemon tool calls (the watch runner WebSocket, #17992)
 * while keeping its one-shot CLI session from idle release. The session's idle clock only moves
 * on control calls, and a `cli` heartbeat is otherwise a no-op, so the hold widens the declared
 * idle window from the session's last control call and keeps widening it, leaving the session at least the base
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
  let lastControlCallAt = timer.now();
  // Sized from the session's actual idle age, not the hold's start: a session a previous hold kept
  // can already be idle for longer than any fixed window, which would put its deadline in the past.
  const declare = () =>
    declarer.declareIdleWindow(heldIdleWindowMs(timer.now() - lastControlCallAt, baseMs));
  try {
    lastControlCallAt = await declarer.lastControlCallAt();
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

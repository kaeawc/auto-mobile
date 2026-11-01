import { daemonSupportsSessionBroker, type SessionConfig } from "../devices/sessionConfig";
import {
  NO_PREPARATION_BUDGET_REASON,
  type SessionBrokerFailure,
  type SessionBrokerReleaseResult,
  type SessionBrokerResult,
} from "../devices/sessionBrokerResult";
import { errorMessage } from "../utils/describeUnknownError";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { DAEMON_RECONNECT_OUTAGE_BUDGET_MS } from "./wire/constants";
import { DaemonUnavailableError } from "./DaemonUnavailableError";
import { McpTimeoutError } from "./wire/McpTimeoutError";
import { DaemonConnectAttemptStalledError } from "./proxy/DaemonConnectAttemptStalledError";
import { DaemonPreflightConnectionError } from "./proxy/DaemonPreflightConnectionError";
import { SESSION_BROKER_RETRY_AFTER_MS } from "./sessionBroker/timing";

export const DAEMON_PREPARE_SESSION_METHOD = "daemon/prepareSession";
export const DAEMON_SESSION_REQUEST_STATUS_METHOD = "daemon/sessionRequestStatus";
export const DAEMON_ABANDON_SESSION_REQUEST_METHOD = "daemon/abandonSessionRequest";
export const DAEMON_RELEASE_BROKER_SESSION_METHOD = "daemon/releaseBrokerSession";

const DAEMON_CAPABILITIES_METHOD = "daemon/capabilities";
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
const STATUS_POLL_INTERVAL_MS = 250;
const STATUS_RECOVERY_RESERVE_MS = 15_000;
/** Pause between reconnect attempts while the daemon is restarting (#15019). */
const RECONNECT_RETRY_DELAY_MS = 1_000;

export interface SessionBrokerProxyAcquisitionPorts {
  ensureConnected(): Promise<void>;
  callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal; cancelOnTimeout?: boolean },
  ): Promise<unknown>;
  holdSession(requestId: string, sessionUuid: string): Promise<void>;
  releaseSession(sessionUuid: string): Promise<unknown>;
  livenessOwnerToken: string;
  timer: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
}

function brokerFailure(code: string, message: string, retryable: boolean): SessionBrokerFailure {
  return { code, message, retryable };
}

function failedResult(
  config: Pick<SessionConfig, "requestId">,
  failure: SessionBrokerFailure,
  cleanupPending = false,
): SessionBrokerResult {
  return {
    contractVersion: 1,
    requestId: config.requestId,
    outcome: "failed",
    sessionUuid: null,
    profile: null,
    cleanupPending,
    failure,
  };
}

function unresolvedResult(config: SessionConfig, message: string): SessionBrokerResult {
  return {
    contractVersion: 1,
    requestId: config.requestId,
    outcome: "pending",
    sessionUuid: null,
    profile: null,
    cleanupPending: true,
    failure: brokerFailure("session_status_unresolved", message, true),
  };
}

function hasSessionBrokerEnvelope(value: unknown, requestId: string): value is SessionBrokerResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SessionBrokerResult>;
  return !(
    candidate.contractVersion !== 1 ||
    candidate.requestId !== requestId ||
    !["ready", "pending", "released", "failed"].includes(String(candidate.outcome)) ||
    typeof candidate.cleanupPending !== "boolean" ||
    !(candidate.sessionUuid === null || typeof candidate.sessionUuid === "string") ||
    !(candidate.profile === null || typeof candidate.profile === "object")
  );
}

function isSessionBrokerResult(value: unknown, requestId: string): value is SessionBrokerResult {
  if (!hasSessionBrokerEnvelope(value, requestId)) {
    return false;
  }
  if (value.outcome === "ready") {
    return (
      typeof value.sessionUuid === "string" &&
      value.sessionUuid.trim().length > 0 &&
      typeof value.profile === "object" &&
      value.profile !== null
    );
  }
  return true;
}

function isReleaseResult(value: unknown, sessionUuid: string): value is SessionBrokerReleaseResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<SessionBrokerReleaseResult>;
  return (
    candidate.sessionUuid === sessionUuid &&
    ["released", "cleanup_pending", "unknown_session"].includes(String(candidate.outcome))
  );
}

function timeoutFailure(config: SessionConfig, error: unknown): SessionBrokerResult {
  return failedResult(
    config,
    brokerFailure(
      "timeout",
      `Session preparation did not finish within its deadline: ${errorMessage(error)}`,
      true,
    ),
  );
}

/** A refused or stalled connect is what a restarting daemon looks like; policy failures are not. */
function isTransientConnectFailure(error: unknown): boolean {
  return (
    error instanceof DaemonUnavailableError &&
    (error.constructor === DaemonUnavailableError ||
      error instanceof DaemonConnectAttemptStalledError ||
      error instanceof DaemonPreflightConnectionError)
  );
}

/**
 * Connect, retrying transient failures, for at most one outage budget (#15019). A daemon restart
 * must not leave `initialize` waiting out the whole preparation deadline: when the daemon stays
 * unreachable past the budget the caller gets a typed retryable `daemon_unavailable`. Each attempt
 * is itself bounded by the proxy's single-flight watchdog, so a stalled attempt is replaced.
 */
async function connectWithinOutageBudget(
  ports: SessionBrokerProxyAcquisitionPorts,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  const outageEndsMs = Math.min(deadlineMs, ports.timer.now() + DAEMON_RECONNECT_OUTAGE_BUDGET_MS);
  for (;;) {
    try {
      await raceWithDeadline(() => ports.ensureConnected(), {
        timer: ports.timer,
        timeoutMs: Math.max(1, outageEndsMs - ports.timer.now()),
        signal,
        label,
      });
      return;
    } catch (error) {
      const delayMs = Math.min(RECONNECT_RETRY_DELAY_MS, outageEndsMs - ports.timer.now());
      if (signal?.aborted || !isTransientConnectFailure(error) || delayMs <= 0) {
        throw error;
      }
      logger.debug(`[SessionBroker] ${label} failed; retrying: ${errorMessage(error)}`, error);
      await waitForStoppingRetry(ports.timer, delayMs, signal);
    }
  }
}

async function queryStatus(
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<SessionBrokerResult | undefined> {
  try {
    const reply = await ports.callDaemonMethod(
      DAEMON_SESSION_REQUEST_STATUS_METHOD,
      {
        requestId: config.requestId,
        livenessOwnerToken: ports.livenessOwnerToken,
      },
      { timeoutMs, signal },
    );
    return isSessionBrokerResult(reply, config.requestId) ? reply : undefined;
  } catch (error) {
    if (!signal?.aborted) {
      // A lost status reply is expected during daemon churn; the bounded loop asks again.
      logger.debug(
        `[SessionBroker] Same-request status check failed: ${errorMessage(error)}`,
        error,
      );
    }
    return undefined;
  }
}

/** The daemon could not be reached at all, as opposed to answering without a usable status. */
const DAEMON_UNREACHABLE = Symbol("daemon-unreachable");

async function queryStatusAfterReconnect(
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<SessionBrokerResult | undefined | typeof DAEMON_UNREACHABLE> {
  const remainingMs = deadlineMs - ports.timer.now();
  try {
    await raceWithDeadline(() => ports.ensureConnected(), {
      timer: ports.timer,
      timeoutMs: Math.max(1, Math.min(CAPABILITY_PROBE_TIMEOUT_MS, remainingMs)),
      signal,
      label: "session broker status connection",
    });
  } catch (error) {
    if (!signal?.aborted) {
      // A daemon restart is expected to refuse connections briefly; polling retries.
      logger.debug(`[SessionBroker] Status reconnect failed: ${errorMessage(error)}`, error);
    }
    return DAEMON_UNREACHABLE;
  }
  if (signal?.aborted || ports.timer.now() >= deadlineMs) {
    return undefined;
  }
  return queryStatus(
    config,
    ports,
    Math.max(1, Math.min(CAPABILITY_PROBE_TIMEOUT_MS, deadlineMs - ports.timer.now())),
    signal,
  );
}

interface StatusRecoveryState {
  last: SessionBrokerResult | undefined;
  unreachableSinceMs: number | undefined;
}

/**
 * Folds one status poll into the recovery state; returns the result that ends the wait, if any.
 * #15019: a daemon that stays unreachable past the outage budget ends it with the typed
 * unresolved result (same requestId, owner token kept) instead of the full preparation deadline.
 */
function absorbStatusReply(
  state: StatusRecoveryState,
  reply: SessionBrokerResult | undefined | typeof DAEMON_UNREACHABLE,
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
): SessionBrokerResult | undefined {
  if (reply !== DAEMON_UNREACHABLE) {
    state.unreachableSinceMs = undefined;
    if (reply && reply.outcome !== "pending") {
      return reply;
    }
    state.last = reply ?? state.last;
    return undefined;
  }
  state.unreachableSinceMs ??= ports.timer.now();
  if (ports.timer.now() - state.unreachableSinceMs < DAEMON_RECONNECT_OUTAGE_BUDGET_MS) {
    return undefined;
  }
  return (
    state.last ??
    unresolvedResult(
      config,
      `The daemon stayed unreachable for ${DAEMON_RECONNECT_OUTAGE_BUDGET_MS}ms; status recovery must keep the same requestId and liveness owner token.`,
    )
  );
}

async function statusUntilSettled(
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
  deadlineMs: number,
  { signal, initial }: { signal?: AbortSignal; initial?: SessionBrokerResult } = {},
): Promise<SessionBrokerResult> {
  const state: StatusRecoveryState = { last: initial, unreachableSinceMs: undefined };
  while (!signal?.aborted && ports.timer.now() < deadlineMs) {
    const reply = await queryStatusAfterReconnect(config, ports, deadlineMs, signal);
    if (signal?.aborted) {
      break;
    }
    const settled = absorbStatusReply(state, reply, config, ports);
    if (settled) {
      return settled;
    }
    const delayMs = Math.min(STATUS_POLL_INTERVAL_MS, deadlineMs - ports.timer.now());
    if (delayMs > 0) {
      await ports.timer.sleep(delayMs);
    }
  }
  return (
    state.last ??
    unresolvedResult(
      config,
      "The daemon may still be preparing this request; status recovery must keep the same requestId and liveness owner token.",
    )
  );
}

/**
 * Returns whether cleanup is still pending. With a deadline, the wait is bounded by it so a
 * release that never settles cannot hold the acquisition open; the release itself keeps running
 * and the caller reports cleanupPending (#12985).
 */
async function releaseUnheldSession(
  sessionUuid: string,
  ports: SessionBrokerProxyAcquisitionPorts,
  deadlineMs?: number,
): Promise<boolean> {
  try {
    const release = ports.releaseSession(sessionUuid);
    const released =
      deadlineMs === undefined
        ? await release
        : await raceWithDeadline(release, {
            timer: ports.timer,
            timeoutMs: Math.max(1, deadlineMs - ports.timer.now()),
            label: `session broker release of unheld session ${sessionUuid}`,
          });
    return !isReleaseResult(released, sessionUuid) || released.outcome !== "released";
  } catch (releaseError) {
    logger.warn(
      `[SessionBroker] Releasing unheld session ${sessionUuid} failed: ${errorMessage(releaseError)}`,
      releaseError,
    );
    return true;
  }
}

class OwnershipHoldDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`Session ownership was not established within the remaining ${timeoutMs}ms`);
    this.name = "OwnershipHoldDeadlineError";
  }
}

/**
 * The hold keeps running after the acquisition settles; it is never abandoned. A late success must
 * not restore the cancelled grant, so it is released again once it lands (#12770).
 */
function releaseAfterLateHold(
  hold: Promise<void>,
  sessionUuid: string,
  ports: SessionBrokerProxyAcquisitionPorts,
): void {
  void hold.then(
    async () => {
      logger.warn(
        `[SessionBroker] Ownership of ${sessionUuid} was established after acquisition ended; releasing it.`,
      );
      await releaseUnheldSession(sessionUuid, ports);
    },
    (error: unknown) => {
      // The grant was already released when acquisition ended; a late hold failure holds nothing.
      logger.debug(
        `[SessionBroker] Late hold of ${sessionUuid} failed after acquisition ended: ${errorMessage(error)}`,
      );
    },
  );
}

type AcquisitionEnd = "cancelled" | "timeout";

function acquisitionEnded(
  ports: SessionBrokerProxyAcquisitionPorts,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): AcquisitionEnd | undefined {
  if (signal?.aborted) {
    return "cancelled";
  }
  return ports.timer.now() >= deadlineMs ? "timeout" : undefined;
}

async function abandonHeldReadyResult(
  result: SessionBrokerResult,
  late: Promise<void> | undefined,
  ports: SessionBrokerProxyAcquisitionPorts,
  { end, deadlineMs }: { end: AcquisitionEnd; deadlineMs: number },
): Promise<SessionBrokerResult> {
  const sessionUuid = result.sessionUuid!;
  if (late) {
    releaseAfterLateHold(late, sessionUuid, ports);
  }
  const cleanupPending = await releaseUnheldSession(sessionUuid, ports, deadlineMs);
  return failedResult(
    { requestId: result.requestId },
    end === "cancelled"
      ? brokerFailure(
          "cancelled",
          "The proxy shut down before session ownership was established.",
          true,
        )
      : brokerFailure(
          "timeout",
          "Session preparation did not finish within its deadline: ownership was not established.",
          true,
        ),
    cleanupPending,
  );
}

async function failedHoldResult(
  result: SessionBrokerResult,
  ports: SessionBrokerProxyAcquisitionPorts,
  error: unknown,
  deadlineMs: number,
): Promise<SessionBrokerResult> {
  const sessionUuid = result.sessionUuid!;
  logger.warn(
    `[SessionBroker] Holding session ${sessionUuid} failed: ${errorMessage(error)}`,
    error,
  );
  return failedResult(
    { requestId: result.requestId },
    brokerFailure(
      "session_hold_failed",
      `The prepared session could not be held: ${errorMessage(error)}`,
      true,
    ),
    await releaseUnheldSession(sessionUuid, ports, deadlineMs),
  );
}

/**
 * Final ownership establishment shares the acquisition's one deadline and cancellation: a hold
 * still pending when either fires is fenced, its grant released, and its late answer cleaned up.
 */
async function holdReadyResult(
  result: SessionBrokerResult,
  ports: SessionBrokerProxyAcquisitionPorts,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<SessionBrokerResult> {
  if (result.outcome !== "ready") {
    return result;
  }
  const sessionUuid = result.sessionUuid!;
  const endedBeforeHold = acquisitionEnded(ports, deadlineMs, signal);
  if (endedBeforeHold) {
    // Never start ownership for a grant whose acquisition already ended; release it instead.
    return abandonHeldReadyResult(result, undefined, ports, { end: endedBeforeHold, deadlineMs });
  }
  const holdTimeoutMs = deadlineMs - ports.timer.now();
  const hold = ports.holdSession(result.requestId, sessionUuid);
  try {
    await raceWithDeadline(hold, {
      timer: ports.timer,
      timeoutMs: holdTimeoutMs,
      signal,
      label: `session broker ownership hold for ${sessionUuid}`,
      timeoutError: () => new OwnershipHoldDeadlineError(holdTimeoutMs),
    });
  } catch (error) {
    const ended = signal?.aborted
      ? "cancelled"
      : error instanceof OwnershipHoldDeadlineError
        ? "timeout"
        : undefined;
    if (!ended) {
      return failedHoldResult(result, ports, error, deadlineMs);
    }
    logger.warn(
      `[SessionBroker] Holding session ${sessionUuid} did not finish before acquisition ended: ${errorMessage(error)}`,
      error,
    );
    return abandonHeldReadyResult(result, hold, ports, { end: ended, deadlineMs });
  }
  // Fence publication after the awaited hold: cancellation may land in the same turn it resolves.
  const endedDuringHold = acquisitionEnded(ports, deadlineMs, signal);
  return endedDuringHold
    ? abandonHeldReadyResult(result, undefined, ports, { end: endedDuringHold, deadlineMs })
    : result;
}

async function daemonSupportsRequestedContract(
  ports: SessionBrokerProxyAcquisitionPorts,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const capabilities = (await ports.callDaemonMethod(
    DAEMON_CAPABILITIES_METHOD,
    {},
    { timeoutMs, signal },
  )) as { capabilities?: unknown } | undefined;
  const advertised = Array.isArray(capabilities?.capabilities)
    ? capabilities.capabilities.filter((entry): entry is string => typeof entry === "string")
    : [];
  return daemonSupportsSessionBroker(advertised);
}

/** Typed session_broker_stopping and session_broker_maintenance refusals admit nothing and are safe to resend. */
function stoppingRetryDelay(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    (error.code !== "session_broker_stopping" && error.code !== "session_broker_maintenance")
  ) {
    return undefined;
  }
  const delay = "retryAfterMs" in error ? error.retryAfterMs : undefined;
  // Invalid hints use the shared default; a zero hint must still yield before retrying.
  return typeof delay === "number" && Number.isFinite(delay) && delay >= 0
    ? Math.max(1, delay)
    : SESSION_BROKER_RETRY_AFTER_MS;
}

function waitForStoppingRetry(
  timer: SessionBrokerProxyAcquisitionPorts["timer"],
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const onAbort = () => {
      timer.clearTimeout(handle);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const handle = timer.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

async function prepareBudgetAfterRetry(
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
  statusReserveMs: number,
  {
    deadlineMs,
    signal,
    retryAfterMs,
  }: { deadlineMs: number; signal: AbortSignal | undefined; retryAfterMs: number | undefined },
): Promise<number | SessionBrokerResult> {
  let prepareCallBudgetMs = Math.floor(deadlineMs - ports.timer.now() - statusReserveMs);
  if (retryAfterMs !== undefined && prepareCallBudgetMs > 0) {
    const delayMs = Math.min(retryAfterMs, Math.max(0, deadlineMs - ports.timer.now()));
    await waitForStoppingRetry(ports.timer, delayMs, signal);
    prepareCallBudgetMs = Math.floor(deadlineMs - ports.timer.now() - statusReserveMs);
    if (prepareCallBudgetMs <= 0) {
      return exhaustedPrepareBudget(config, retryAfterMs);
    }
    try {
      await connectWithinOutageBudget(
        ports,
        deadlineMs - statusReserveMs,
        signal,
        "session broker retry daemon connection",
      );
    } catch (error) {
      if (signal?.aborted) {
        // Cancellation must preserve the proxy's existing unresolved shutdown result.
        logger.debug("[SessionBroker] Retry reconnect cancelled during proxy shutdown.", error);
        return unresolvedResult(config, "Session preparation was cancelled during proxy shutdown.");
      }
      if (ports.timer.now() >= deadlineMs - statusReserveMs) {
        // Stopping admitted nothing, so exhausting the retry budget needs no status recovery.
        logger.debug("[SessionBroker] Retry reconnect exhausted the preparation budget.", error);
        return exhaustedPrepareBudget(config, retryAfterMs);
      }
      const message = `Session preparation could not reconnect to the daemon after a stopping refusal: ${errorMessage(error)}`;
      logger.warn(message, error);
      return failedResult(config, brokerFailure("daemon_unavailable", message, true));
    }
    prepareCallBudgetMs = Math.floor(deadlineMs - ports.timer.now() - statusReserveMs);
  }
  return prepareCallBudgetMs;
}

function exhaustedPrepareBudget(
  config: SessionConfig,
  retryAfterMs: number | undefined,
): SessionBrokerResult {
  // Stopping refused admission, so there is no durable request or grant to clean up.
  return retryAfterMs === undefined
    ? timeoutFailure(config, new Error(NO_PREPARATION_BUDGET_REASON))
    : failedResult(
        config,
        brokerFailure(
          "session_broker_stopping",
          "The session broker kept stopping until no preparation budget remained.",
          true,
        ),
      );
}

async function prepareThenRecover(
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
  statusReserveMs: number,
  { deadlineMs, signal }: { deadlineMs: number; signal?: AbortSignal },
): Promise<SessionBrokerResult> {
  // The runner's start identity is proxy-only; older daemons reject unknown config keys.
  const { executionOwnerStartIdentity: _executionOwnerStartIdentity, ...daemonConfig } = config;
  void _executionOwnerStartIdentity;
  const params = { config: daemonConfig, livenessOwnerToken: ports.livenessOwnerToken };
  let retryAfterMs: number | undefined;
  while (true) {
    let reply: unknown;
    try {
      const prepareCallBudgetMs = await prepareBudgetAfterRetry(config, ports, statusReserveMs, {
        deadlineMs,
        signal,
        retryAfterMs,
      });
      if (typeof prepareCallBudgetMs !== "number") {
        return prepareCallBudgetMs;
      }
      if (prepareCallBudgetMs <= 0) {
        return exhaustedPrepareBudget(config, retryAfterMs);
      }
      reply = await ports.callDaemonMethod(
        DAEMON_PREPARE_SESSION_METHOD,
        // The broker fingerprints the complete config. Keep it byte-for-value stable across a
        // lost reply or process relaunch; only this RPC's wait is shortened for status recovery.
        params,
        // A reply that does not arrive in time must not cancel the daemon-side preparation: the
        // reserve exists so the late result is recovered by request id (#13800). Real caller
        // cancellation arrives through `signal`, which still cancels. `daemon/*` methods hold their
        // socket's barrier lane, so status polls on this connection wait behind an in-flight
        // prepare (each poll may answer queue-timeout) and settle once it finishes.
        { timeoutMs: Math.max(1, prepareCallBudgetMs), signal, cancelOnTimeout: false },
      );
    } catch (error) {
      if (signal?.aborted) {
        // Caller cancellation keeps the existing unresolved result; never resend after abort.
        return unresolvedResult(config, "Session preparation was cancelled during proxy shutdown.");
      }
      retryAfterMs = stoppingRetryDelay(error);
      if (retryAfterMs !== undefined) {
        // Stopping or maintenance admitted nothing; the same request can be accepted on retry.
        logger.debug(
          `[SessionBroker] Prepare refused while stopping or maintaining snapshots; retrying in ${retryAfterMs}ms.`,
          error,
        );
        continue;
      }
      logger.warn(
        `[SessionBroker] Prepare reply was not received; checking request ${config.requestId}: ${errorMessage(error)}`,
        error,
      );
      return statusUntilSettled(config, ports, deadlineMs, { signal });
    }
    const initial = isSessionBrokerResult(reply, config.requestId) ? reply : undefined;
    return initial !== undefined && initial.outcome !== "pending"
      ? initial
      : await statusUntilSettled(config, ports, deadlineMs, { signal, initial });
  }
}

function acquisitionFailure(
  config: SessionConfig,
  error: unknown,
  signal: AbortSignal | undefined,
): SessionBrokerResult {
  if (error instanceof McpTimeoutError) {
    return timeoutFailure(config, error);
  }
  const cancelled = signal?.aborted === true;
  return failedResult(
    config,
    brokerFailure(
      cancelled ? "cancelled" : "daemon_unavailable",
      cancelled
        ? "The proxy shut down while preparing its session."
        : `Session preparation could not reach the daemon: ${errorMessage(error)}`,
      true,
    ),
  );
}

/**
 * Prepares exactly one durable request. Recovery reads status for the same request ID and owner
 * token, except typed session_broker_stopping and session_broker_maintenance refusals admitted
 * nothing: after the retry delay, prepare is resent with identical params within the acquisition deadline.
 * A retryable session_broker_stopping receipt with retryRequires: "new_request_id" is returned
 * to the caller without resending: the request ID belongs to the caller.
 */
export async function acquireSessionThroughDaemon(
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
  signal?: AbortSignal,
): Promise<SessionBrokerResult> {
  const budgetMs = config.preparationTimeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS;
  const deadlineMs = ports.timer.now() + budgetMs;
  const remaining = () => deadlineMs - ports.timer.now();
  try {
    await connectWithinOutageBudget(ports, deadlineMs, signal, "session broker daemon connection");
    if (
      !(await daemonSupportsRequestedContract(
        ports,
        Math.max(1, Math.min(CAPABILITY_PROBE_TIMEOUT_MS, remaining())),
        signal,
      ))
    ) {
      return failedResult(
        config,
        brokerFailure(
          "contract_unsupported",
          "The running daemon does not advertise session-broker/v1; nothing was changed.",
          false,
        ),
      );
    }

    const statusReserveMs = Math.min(
      STATUS_RECOVERY_RESERVE_MS,
      Math.max(1, Math.floor(budgetMs / 4)),
    );
    const result = await prepareThenRecover(config, ports, statusReserveMs, { deadlineMs, signal });
    return await holdReadyResult(result, ports, deadlineMs, signal);
  } catch (error) {
    const result = acquisitionFailure(config, error, signal);
    logger.warn(`[SessionBroker] Acquisition failed (${result.failure?.code})`, error);
    return result;
  }
}

import { daemonSupportsSessionBroker, type SessionConfig } from "../devices/sessionConfig";
import type {
  SessionBrokerFailure,
  SessionBrokerReleaseResult,
  SessionBrokerResult,
} from "../devices/sessionBrokerResult";
import { errorMessage } from "../utils/describeUnknownError";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { McpTimeoutError } from "./McpTimeoutError";

export const DAEMON_PREPARE_SESSION_METHOD = "daemon/prepareSession";
export const DAEMON_SESSION_REQUEST_STATUS_METHOD = "daemon/sessionRequestStatus";
export const DAEMON_ABANDON_SESSION_REQUEST_METHOD = "daemon/abandonSessionRequest";
export const DAEMON_RELEASE_BROKER_SESSION_METHOD = "daemon/releaseBrokerSession";

const DAEMON_CAPABILITIES_METHOD = "daemon/capabilities";
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;
const STATUS_POLL_INTERVAL_MS = 250;
const STATUS_RECOVERY_RESERVE_MS = 15_000;

export interface SessionBrokerProxyAcquisitionPorts {
  ensureConnected(): Promise<void>;
  callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
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

async function statusUntilSettled(
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  initial: SessionBrokerResult | undefined,
): Promise<SessionBrokerResult> {
  let last = initial;
  while (!signal?.aborted && ports.timer.now() < deadlineMs) {
    const remainingMs = deadlineMs - ports.timer.now();
    const reply = await queryStatus(
      config,
      ports,
      Math.max(1, Math.min(CAPABILITY_PROBE_TIMEOUT_MS, remainingMs)),
      signal,
    );
    if (reply?.outcome !== "pending" && reply !== undefined) {
      return reply;
    }
    if (reply) {
      last = reply;
    }
    const delayMs = Math.min(STATUS_POLL_INTERVAL_MS, deadlineMs - ports.timer.now());
    if (delayMs > 0) {
      await ports.timer.sleep(delayMs);
    }
  }
  if (last) {
    return last;
  }
  return unresolvedResult(
    config,
    "The daemon may still be preparing this request; status recovery must keep the same requestId and liveness owner token.",
  );
}

async function releaseUnheldSession(
  sessionUuid: string,
  ports: SessionBrokerProxyAcquisitionPorts,
): Promise<boolean> {
  try {
    const released = await ports.releaseSession(sessionUuid);
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
  end: AcquisitionEnd,
): Promise<SessionBrokerResult> {
  const sessionUuid = result.sessionUuid!;
  if (late) {
    releaseAfterLateHold(late, sessionUuid, ports);
  }
  const cleanupPending = await releaseUnheldSession(sessionUuid, ports);
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
    await releaseUnheldSession(sessionUuid, ports),
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
    return abandonHeldReadyResult(result, undefined, ports, endedBeforeHold);
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
      return failedHoldResult(result, ports, error);
    }
    logger.warn(
      `[SessionBroker] Holding session ${sessionUuid} did not finish before acquisition ended: ${errorMessage(error)}`,
      error,
    );
    return abandonHeldReadyResult(result, hold, ports, ended);
  }
  // Fence publication after the awaited hold: cancellation may land in the same turn it resolves.
  const endedDuringHold = acquisitionEnded(ports, deadlineMs, signal);
  return endedDuringHold
    ? abandonHeldReadyResult(result, undefined, ports, endedDuringHold)
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

async function prepareThenRecover(
  config: SessionConfig,
  ports: SessionBrokerProxyAcquisitionPorts,
  prepareCallBudgetMs: number,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<SessionBrokerResult> {
  let reply: unknown;
  try {
    // The runner's start identity is proxy-only; older daemons reject unknown config keys.
    const { executionOwnerStartIdentity: _executionOwnerStartIdentity, ...daemonConfig } = config;
    void _executionOwnerStartIdentity;
    reply = await ports.callDaemonMethod(
      DAEMON_PREPARE_SESSION_METHOD,
      {
        // The broker fingerprints the complete config. Keep it byte-for-value stable across a
        // lost reply or process relaunch; only this RPC's wait is shortened for status recovery.
        config: daemonConfig,
        livenessOwnerToken: ports.livenessOwnerToken,
      },
      { timeoutMs: prepareCallBudgetMs, signal },
    );
  } catch (error) {
    if (signal?.aborted) {
      return unresolvedResult(config, "Session preparation was cancelled during proxy shutdown.");
    }
    logger.warn(
      `[SessionBroker] Prepare reply was not received; checking request ${config.requestId}: ${errorMessage(error)}`,
      error,
    );
    return statusUntilSettled(config, ports, deadlineMs, signal, undefined);
  }
  const initial = isSessionBrokerResult(reply, config.requestId) ? reply : undefined;
  return initial?.outcome !== "pending" && initial !== undefined
    ? initial
    : await statusUntilSettled(config, ports, deadlineMs, signal, initial);
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
 * Prepares exactly one durable request. Once prepare is sent, all recovery reads status for the
 * same request ID and owner token; this function never issues a second prepare.
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
    await raceWithDeadline(() => ports.ensureConnected(), {
      timer: ports.timer,
      timeoutMs: Math.max(1, remaining()),
      signal,
      label: "session broker daemon connection",
    });
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
    const prepareCallBudgetMs = Math.floor(remaining() - statusReserveMs);
    if (prepareCallBudgetMs <= 0) {
      return timeoutFailure(config, new Error("No preparation budget remains"));
    }
    const result = await prepareThenRecover(config, ports, prepareCallBudgetMs, deadlineMs, signal);
    return await holdReadyResult(result, ports, deadlineMs, signal);
  } catch (error) {
    const result = acquisitionFailure(config, error, signal);
    logger.warn(`[SessionBroker] Acquisition failed (${result.failure?.code})`, error);
    return result;
  }
}

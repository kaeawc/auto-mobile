/**
 * The stdio proxy's managed slot acquisition (epic #11172, #11173 part b), run before the proxy
 * answers `initialize` or `tools/list`.
 *
 * One preparation deadline (`preparationTimeoutMs`, else the provision default) bounds the whole
 * thing: connecting to (or starting) the daemon, negotiating `managed-slots/v1`, and the daemon's
 * acquisition, whose own deadline is the budget left after connecting, and establishing the
 * session hold. Settlement after a miss is bounded by the managed execution release timeout.
 * Shutdown (stdin EOF, SIGTERM, owner loss) aborts it. Every outcome is a typed
 * {@link ManagedSlotsResult}: a launcher reads failures over MCP (owner decision Q5) instead of
 * from a crashed process.
 */

import {
  daemonSupportsManagedSlots,
  unmetManagedSlotConfigCapabilities,
  type ManagedSlotConfig,
  type ManagedSlotConfigErrorCode,
} from "../models/managedSlotConfig";
import {
  managedSlotSessions,
  type ManagedSlotAcquisitionOwnFailureCode,
  type ManagedSlotsFailure,
  type ManagedSlotsResult,
} from "../models/managedSlotsResult";
import { errorMessage } from "../utils/describeUnknownError";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD } from "./constants";
import { DaemonHandshakeMismatchError, DaemonUnavailableError } from "./client";
import { McpTimeoutError } from "./McpTimeoutError";
import { MANAGED_EXECUTION_RELEASE_TIMEOUT_MS } from "./managedExecutionLiveness";

/** Same method name the daemon serves (`daemonRequestHandlers.DAEMON_CAPABILITIES_METHOD`). */
const DAEMON_CAPABILITIES_METHOD = "daemon/capabilities";

/**
 * Time (at most a quarter of the budget) kept back from the preparation budget for the daemon to answer after its own deadline
 * (rollback of a partial create, backing a session out) and for the reply to travel.
 */
export const MANAGED_SLOT_ACQUISITION_REPLY_GRACE_MS = 15_000;

/** Bound on the capability probe; it is daemon self-description and answers at once. */
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;

const CONFIG_ERROR_CODES: ReadonlySet<string> = new Set<ManagedSlotConfigErrorCode>([
  "managed_slot_config_invalid",
  "contract_unsupported",
  "managed_slot_group_unsupported",
  "managed_slots_unsupported",
]);

export interface ManagedSlotProxyAcquisitionPorts {
  ensureConnected(): Promise<void>;
  callDaemonMethod(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown>;
  /** Record the daemon's grants synchronously, before attempting any hold. */
  trackAcquiredSessions(sessionUuids: readonly string[], scopeKey?: string | null): void;
  /** Bind, claim and heartbeat a slot's session; stop establishing once the signal aborts. */
  holdSession(sessionUuid: string, signal: AbortSignal): Promise<void>;
  /** Release every tracked session and drop the proxy's hold on them. */
  releaseHeldSessions(): Promise<void>;
  livenessOwnerToken: string;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
}

function failure(
  code: ManagedSlotAcquisitionOwnFailureCode,
  message: string,
  retryable: boolean,
  nextAction: string,
) {
  return { code, message, retryable, nextAction } satisfies ManagedSlotsFailure;
}

export function failedManagedSlotsResult(
  config: ManagedSlotConfig,
  slotFailure: ManagedSlotsFailure,
): ManagedSlotsResult {
  return {
    contractVersion: 1,
    scope: {
      managedHostScope: config.managedHostScope,
      runnerNamespace: config.runnerNamespace,
      runnerIncarnation: config.runnerIncarnation,
      scopeKey: null,
    },
    outcome: "failed",
    slots: [],
    failure: slotFailure,
  };
}

function isManagedSlotsResult(value: unknown): value is ManagedSlotsResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ManagedSlotsResult>;
  return (
    candidate.contractVersion === 1 &&
    (candidate.outcome === "ready" || candidate.outcome === "failed") &&
    Array.isArray(candidate.slots) &&
    typeof candidate.scope === "object" &&
    candidate.scope !== null
  );
}

function incompatibleDaemonFailure(error: unknown): ManagedSlotsFailure | undefined {
  if (error instanceof DaemonHandshakeMismatchError) {
    return failure(
      "contract_unsupported",
      `Managed slot acquisition refused a daemon ${error.failure.reason} mismatch: ${errorMessage(error)}`,
      false,
      "Restart the daemon from this client's installation (`auto-mobile --daemon restart`) so frontend and daemon match; nothing was changed.",
    );
  }
  // Match structurally to avoid an import cycle with daemonMcpProxy, which imports this module.
  if (
    error instanceof DaemonUnavailableError &&
    (error.name === "DaemonVersionMismatchError" || error.name === "DaemonBuildMismatchError") &&
    "reason" in error &&
    typeof error.reason === "string" &&
    error.reason !== "cooldown"
  ) {
    return failure(
      "contract_unsupported",
      `Managed slot acquisition refused a daemon mismatch (${error.reason}): ${errorMessage(error)}`,
      false,
      "Restart the daemon from this client's installation (`auto-mobile --daemon restart`) so frontend and daemon match; nothing was changed.",
    );
  }
  return undefined;
}

function classifyError(error: unknown, signal: AbortSignal | undefined): ManagedSlotsFailure {
  if (signal?.aborted) {
    return failure(
      "cancelled",
      "The proxy shut down while acquiring its managed slots.",
      true,
      "Relaunch the execution.",
    );
  }
  if (error instanceof McpTimeoutError) {
    return failure(
      "timeout",
      `Managed slot acquisition did not finish within the preparation deadline: ${errorMessage(error)}`,
      true,
      "Retry with a longer preparationTimeoutMs, and set the MCP init timeout at or above it.",
    );
  }
  const incompatibleDaemon = incompatibleDaemonFailure(error);
  if (incompatibleDaemon) {
    return incompatibleDaemon;
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONFIG_ERROR_CODES.has(code)) {
    return failure(
      code as ManagedSlotConfigErrorCode,
      errorMessage(error),
      false,
      "Fix the managed slot config; nothing changed.",
    );
  }
  return failure(
    "daemon_unavailable",
    `Managed slot acquisition could not reach the daemon: ${errorMessage(error)}`,
    true,
    "Retry once the AutoMobile daemon is reachable.",
  );
}

/**
 * Acquire the config's slots through the daemon and hold their sessions. Never throws: every
 * failure is a `failed` result with a typed code.
 */
export async function acquireManagedSlotsThroughDaemon(
  config: ManagedSlotConfig,
  ports: ManagedSlotProxyAcquisitionPorts,
  signal?: AbortSignal,
): Promise<ManagedSlotsResult> {
  const budgetMs = config.preparationTimeoutMs ?? DEFAULT_PROVISION_DEVICE_TIMEOUT_MS;
  const deadlineMs = ports.timer.now() + budgetMs;
  const remaining = () => deadlineMs - ports.timer.now();
  const timeoutError = () =>
    new McpTimeoutError({
      toolName: DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
      timeoutMs: budgetMs,
      origin: "acquireManagedSlotsThroughDaemon",
    });
  let result: ManagedSlotsResult;
  try {
    await raceWithDeadline(() => ports.ensureConnected(), {
      timer: ports.timer,
      timeoutMs: Math.max(1, remaining()),
      signal,
      label: "managed slot daemon connection",
      timeoutError,
    });
    const capabilities = (await ports.callDaemonMethod(
      DAEMON_CAPABILITIES_METHOD,
      {},
      { timeoutMs: Math.max(1, Math.min(CAPABILITY_PROBE_TIMEOUT_MS, remaining())), signal },
    )) as { capabilities?: unknown } | undefined;
    const advertised = Array.isArray(capabilities?.capabilities)
      ? capabilities.capabilities.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (!daemonSupportsManagedSlots(advertised)) {
      return failedManagedSlotsResult(
        config,
        failure(
          "contract_unsupported",
          "The running daemon does not advertise managed-slots/v1; nothing was changed.",
          false,
          "Restart the daemon from a build that supports managed slots.",
        ),
      );
    }
    const unmet = unmetManagedSlotConfigCapabilities(config, advertised);
    if (unmet.length > 0) {
      return failedManagedSlotsResult(
        config,
        failure(
          "contract_unsupported",
          `The running daemon does not advertise ${unmet[0]!.capability}, which ${unmet[0]!.field} requires; nothing was changed.`,
          false,
          "Upgrade the daemon to a build that supports deviceFamily; if it starts automatically from this same installation, an older daemon is still running and must be restarted. Alternatively, remove deviceFamily from the config.",
        ),
      );
    }
    const graceMs = Math.min(MANAGED_SLOT_ACQUISITION_REPLY_GRACE_MS, Math.floor(budgetMs / 4));
    const preparationMs = Math.floor(remaining() - graceMs);
    if (preparationMs <= 0) {
      throw timeoutError();
    }
    const reply = await ports.callDaemonMethod(
      DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD,
      {
        // The daemon's deadline is what is left of this one after connecting.
        config: { ...config, preparationTimeoutMs: preparationMs },
        livenessOwnerToken: ports.livenessOwnerToken,
      },
      { timeoutMs: Math.max(1, remaining()), signal },
    );
    if (!isManagedSlotsResult(reply)) {
      return failedManagedSlotsResult(
        config,
        failure(
          "daemon_unavailable",
          "The daemon returned a malformed managed slot result.",
          true,
          "Restart the daemon from this client installation.",
        ),
      );
    }
    result = reply;
  } catch (error) {
    const classified = classifyError(error, signal);
    logger.warn(
      `[ManagedSlots] Acquisition failed (${classified.code}): ${errorMessage(error)}`,
      error,
    );
    return failedManagedSlotsResult(config, classified);
  }
  if (result.outcome !== "ready") {
    return result;
  }
  const sessionUuids = managedSlotSessions(result);
  // No await between learning the grants and registering close's cleanup responsibility.
  ports.trackAcquiredSessions(sessionUuids, result.scope.scopeKey);
  return await holdReadySessions(result, ports, sessionUuids, remaining, timeoutError, signal);
}

/** Hold every ready slot's session; a failed hold turns the result into a typed failure. */
async function holdReadySessions(
  result: ManagedSlotsResult,
  ports: ManagedSlotProxyAcquisitionPorts,
  sessionUuids: readonly string[],
  remaining: () => number,
  timeoutError: () => McpTimeoutError,
  signal?: AbortSignal,
): Promise<ManagedSlotsResult> {
  const holdAbort = new AbortController();
  const cancelHold = () => holdAbort.abort(signal?.reason);
  signal?.addEventListener("abort", cancelHold, { once: true });
  try {
    signal?.throwIfAborted();
    const timeoutMs = remaining();
    if (timeoutMs <= 0) {
      throw timeoutError();
    }
    await raceWithDeadline(
      async () => {
        for (const sessionUuid of sessionUuids) {
          holdAbort.signal.throwIfAborted();
          await ports.holdSession(sessionUuid, holdAbort.signal);
        }
      },
      {
        timer: ports.timer,
        timeoutMs,
        signal,
        label: "managed slot session hold",
        timeoutError,
        onTimeout: () => holdAbort.abort(timeoutError()),
      },
    );
    signal?.throwIfAborted();
    if (remaining() <= 0) {
      throw timeoutError();
    }
    return result;
  } catch (error) {
    holdAbort.abort(error);
    logger.warn(
      `[ManagedSlots] Holding the acquired sessions failed: ${errorMessage(error)}`,
      error,
    );
    try {
      await raceWithDeadline(() => ports.releaseHeldSessions(), {
        timer: ports.timer,
        timeoutMs: MANAGED_EXECUTION_RELEASE_TIMEOUT_MS,
        label: "managed slot abandoned hold release",
      });
    } catch (releaseError) {
      logger.warn(
        `[ManagedSlots] Releasing the acquired sessions failed; the daemon's owner-disconnect / ` +
          `no-heartbeat release remains responsible: ${errorMessage(releaseError)}`,
        releaseError,
      );
    }
    return {
      ...result,
      outcome: "failed",
      slots: result.slots.map((slot) => ({ ...slot, sessionUuid: null })),
      failure:
        signal?.aborted || error instanceof McpTimeoutError
          ? classifyError(error, signal)
          : failure(
              "execution_hold_failed",
              `The acquired session could not be held: ${errorMessage(error)}`,
              true,
              "Relaunch the execution; the slot keeps its device.",
            ),
    };
  } finally {
    signal?.removeEventListener("abort", cancelHold);
  }
}

/**
 * The stdio proxy's managed slot acquisition (epic #11172, #11173 part b), run before the proxy
 * answers `initialize` or `tools/list`.
 *
 * One preparation deadline (`preparationTimeoutMs`, else the provision default) bounds the whole
 * thing: connecting to (or starting) the daemon, negotiating `managed-slots/v1`, and the daemon's
 * acquisition, whose own deadline is the budget left after connecting. Shutdown (stdin EOF,
 * SIGTERM, owner loss) aborts it. Every outcome is a typed {@link ManagedSlotsResult}: a launcher
 * reads failures over MCP (owner decision Q5) instead of from a crashed process.
 */

import {
  daemonSupportsManagedSlots,
  type ManagedSlotConfig,
  type ManagedSlotConfigErrorCode,
} from "../models/managedSlotConfig";
import {
  managedSlotSessions,
  type ManagedSlotsFailure,
  type ManagedSlotsResult,
} from "../models/managedSlotsResult";
import { errorMessage } from "../utils/describeUnknownError";
import { DEFAULT_PROVISION_DEVICE_TIMEOUT_MS } from "../utils/deviceTimeouts";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";
import { DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD } from "./constants";
import { McpTimeoutError } from "./McpTimeoutError";

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
  /** Bind, claim and heartbeat a slot's session for the execution (`holdManagedExecutionSession`). */
  holdSession(sessionUuid: string): Promise<void>;
  /** Release whatever was held after a failed hold. */
  releaseHeldSessions(): Promise<void>;
  livenessOwnerToken: string;
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
}

function failure(code: string, message: string, retryable: boolean, nextAction: string) {
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
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONFIG_ERROR_CODES.has(code)) {
    return failure(
      code,
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
  return await holdReadySessions(result, ports);
}

/** Hold every ready slot's session; a failed hold turns the result into a typed failure. */
async function holdReadySessions(
  result: ManagedSlotsResult,
  ports: ManagedSlotProxyAcquisitionPorts,
): Promise<ManagedSlotsResult> {
  try {
    for (const sessionUuid of managedSlotSessions(result)) {
      await ports.holdSession(sessionUuid);
    }
    return result;
  } catch (error) {
    logger.warn(
      `[ManagedSlots] Holding the acquired sessions failed: ${errorMessage(error)}`,
      error,
    );
    await ports.releaseHeldSessions();
    return {
      ...result,
      outcome: "failed",
      slots: result.slots.map((slot) => ({ ...slot, sessionUuid: null })),
      failure: failure(
        "execution_hold_failed",
        `The acquired session could not be held: ${errorMessage(error)}`,
        true,
        "Relaunch the execution; the slot keeps its device.",
      ),
    };
  }
}

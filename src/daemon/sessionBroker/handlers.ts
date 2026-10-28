import {
  SessionRequestOwnerMismatchError,
  SESSION_BROKER_RETRY_AFTER_MS,
} from "./SessionRequestOwnerMismatchError";
import { SessionBrokerStoppingError } from "./SessionBrokerStoppingError";
import { z } from "zod";
import { SESSION_BROKER_RELEASE_REPLY_BUDGET_MS } from "./broker";
import { RECEIPT_RETENTION_MS } from "./retention";
import { SessionExportIdentityMismatchError } from "./store";
import { parseSessionConfig } from "../../devices/sessionConfig";
import { SESSION_OWNER_EXITED_CODE } from "../../devices/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { DaemonRequest } from "../types";
import type {
  DaemonMethodResult,
  DaemonStateAccess,
  InitializedDaemonMethodHandler,
} from "../daemonRequestHandlers";

const ownerToken = z.string().min(1);
const exportIdentity = z
  .object({
    prepareId: z.string().min(1).max(256),
    requestDigest: z.string().min(1).max(256),
  })
  .strict();
const exportParams = exportIdentity.extend({ livenessOwnerToken: ownerToken }).strict();
const prepareParams = z
  .object({
    config: z.unknown(),
    livenessOwnerToken: ownerToken,
    export: exportIdentity.optional(),
  })
  .strict();
const statusParams = z
  .object({ requestId: z.string().min(1), livenessOwnerToken: ownerToken })
  .strict();
const abandonParams = statusParams;
const releaseParams = z
  .object({
    sessionId: z.string().uuid(),
    livenessOwnerToken: ownerToken,
    // Set only by a proxy whose execution owner died (#12791); a client release omits it.
    reason: z.literal(SESSION_OWNER_EXITED_CODE).optional(),
    replyBudgetMs: z.preprocess(
      (value) => (typeof value === "number" && !Number.isFinite(value) ? undefined : value),
      z
        .number()
        .transform((value) => Math.max(0, Math.min(value, SESSION_BROKER_RELEASE_REPLY_BUDGET_MS)))
        .nullish(),
    ),
  })
  .strict();

export async function handlePrepareBrokerSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
  signal?: AbortSignal,
  socketSessionId?: string,
): Promise<DaemonMethodResult> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable(state);
  }
  // Fail closed before validation/acquisition: this connection is never a generic allocator.
  bind(state, socketSessionId, service.scopeKey, []);
  const parsed = prepareParams.safeParse(request.params);
  if (!parsed.success) {
    return {
      success: false,
      code: "session_config_invalid",
      error: "config and livenessOwnerToken are required",
    };
  }
  let config;
  try {
    config = parseSessionConfig(parsed.data.config);
  } catch (error) {
    logger.warn(`Session broker rejected invalid configuration: ${errorMessage(error)}`);
    return { success: false, code: "session_config_invalid", error: errorMessage(error) };
  }
  let result;
  try {
    result = await service.broker.prepare(
      config,
      parsed.data.livenessOwnerToken,
      signal,
      parsed.data.export,
    );
  } catch (error) {
    return brokerRejection(error);
  }
  if (!signal?.aborted) {
    bind(
      state,
      socketSessionId,
      service.scopeKey,
      result.outcome === "ready" && result.sessionUuid ? [result.sessionUuid] : [],
    );
  }
  return { success: true, result: { ...result } };
}

export async function handleGetSessionExport(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  return handleSessionExport(request, state, false);
}

export async function handleAcknowledgeSessionExport(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  return handleSessionExport(request, state, true);
}

async function handleSessionExport(
  request: DaemonRequest,
  state: DaemonStateAccess,
  acknowledge: boolean,
): Promise<DaemonMethodResult> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable(state);
  }
  // Reading proof or releasing its pin neither grants nor revokes this connection's device
  // control, so the existing binding is deliberately left untouched.
  const parsed = exportParams.safeParse(request.params);
  if (!parsed.success) {
    return {
      success: false,
      code: "session_config_invalid",
      error: "prepareId, requestDigest and livenessOwnerToken are required",
    };
  }
  const { prepareId, requestDigest, livenessOwnerToken } = parsed.data;
  try {
    const result = acknowledge
      ? await service.broker.acknowledgeExport(prepareId, requestDigest, livenessOwnerToken)
      : await service.broker.getExport(prepareId, requestDigest, livenessOwnerToken);
    return result
      ? { success: true, result: { ...result } }
      : {
          success: false,
          code: "session_export_not_found",
          error: "No session export has that prepare identity",
        };
  } catch (error) {
    return brokerRejection(error);
  }
}

function brokerRejection(error: unknown): DaemonMethodResult {
  if (
    error instanceof SessionRequestOwnerMismatchError ||
    error instanceof SessionBrokerStoppingError
  ) {
    const message = `Session broker rejected request: ${errorMessage(error)}`;
    if (error.retryable) {
      logger.debug(message);
    } else {
      logger.warn(message);
    }
    return {
      success: false,
      code: error.code,
      error: errorMessage(error),
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  if (!(error instanceof SessionExportIdentityMismatchError)) {
    throw error;
  }
  logger.warn(`Session broker rejected export identity: ${errorMessage(error)}`);
  return { success: false, code: error.code, error: errorMessage(error) };
}

export async function handleBrokerSessionStatus(
  request: DaemonRequest,
  state: DaemonStateAccess,
  socketSessionId?: string,
): Promise<DaemonMethodResult> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable(state);
  }
  // A malformed or unauthorized recovery request must not retain an earlier grant.
  bind(state, socketSessionId, service.scopeKey, []);
  const parsed = statusParams.safeParse(request.params);
  if (!parsed.success) {
    return { success: false, error: "requestId and livenessOwnerToken are required" };
  }
  const result = await service.broker.ownedStatus(
    parsed.data.requestId,
    parsed.data.livenessOwnerToken,
  );
  bind(
    state,
    socketSessionId,
    service.scopeKey,
    result?.outcome === "ready" && result.sessionUuid ? [result.sessionUuid] : [],
  );
  return result
    ? { success: true, result: { ...result } }
    : {
        success: false,
        code: "session_request_not_found",
        error: "No committed session request has that identity",
      };
}

export async function handleAbandonBrokerSessionRequest(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable(state);
  }
  const parsed = abandonParams.safeParse(request.params);
  if (!parsed.success) {
    return { success: false, error: "requestId and livenessOwnerToken are required" };
  }
  try {
    const result = await service.broker.abandon(
      parsed.data.requestId,
      parsed.data.livenessOwnerToken,
    );
    return { success: true, result: { ...result } };
  } catch (error) {
    return brokerRejection(error);
  }
}

export async function handleReleaseBrokerSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable(state);
  }
  const parsed = releaseParams.safeParse(request.params);
  if (!parsed.success) {
    return { success: false, error: "sessionId and livenessOwnerToken are required" };
  }
  try {
    const receipt = await service.broker.ownedSessionRequest(
      parsed.data.sessionId,
      parsed.data.livenessOwnerToken,
    );
    if (!receipt) {
      return {
        success: true,
        result: { sessionUuid: parsed.data.sessionId, outcome: "unknown_session" },
      };
    }
    return {
      success: true,
      result: {
        ...(await service.broker.release(parsed.data.sessionId, parsed.data.reason, {
          replyBudgetMs: parsed.data.replyBudgetMs ?? undefined,
        })),
      },
    };
  } catch (error) {
    return brokerRejection(error);
  }
}

/** Reconnect proves request ownership and derives private binding from the receipt. */
export async function bindBrokerRegistration(
  state: DaemonStateAccess,
  sessionId: string,
  registration: { requestId: string; livenessOwnerToken: string },
  socketSessionId?: string,
): Promise<DaemonMethodResult | undefined> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable(state);
  }
  bind(state, socketSessionId, service.scopeKey, []);
  const result = await service.broker.ownedStatus(
    registration.requestId,
    registration.livenessOwnerToken,
  );
  if (!result || result.outcome !== "ready" || result.sessionUuid !== sessionId) {
    return {
      success: false,
      code: "session_ownership_lost",
      error: "That request no longer grants this session; no replacement was acquired",
    };
  }
  if (
    state.getSessionManager().getSessionLivenessOwnerToken?.(sessionId) !==
    registration.livenessOwnerToken
  ) {
    return {
      success: false,
      code: "session_ownership_lost",
      error: "This provider no longer holds the requested session for that owner",
    };
  }
  bind(state, socketSessionId, service.scopeKey, [sessionId]);
  return undefined;
}

function bind(
  state: DaemonStateAccess,
  socketId: string | undefined,
  scopeKey: string,
  sessions: string[],
): void {
  if (socketId) {
    state.getBrokerConnectionScopes?.().bind(socketId, { scopeKey, sessionUuids: sessions });
  }
}

function unavailable(state: DaemonStateAccess): DaemonMethodResult {
  // Broker mode is set from the configured host path before installation and survives close.
  const retryable = state.isSessionBrokerMode?.() === true;
  return {
    success: false,
    code: "session_broker_unavailable",
    error: "Session-broker mode is not available in this provider",
    retryable,
    ...(retryable ? { retryAfterMs: SESSION_BROKER_RETRY_AFTER_MS } : {}),
  };
}

/** Session-broker socket dispatch shares the initialized daemon context. */
export const BROKER_DAEMON_METHOD_HANDLERS: Array<[string, InitializedDaemonMethodHandler]> = [
  [
    "daemon/sessionBrokerStats",
    async (request, state) => {
      const service = state.getSessionBrokerService?.();
      if (!service) {
        return unavailable(state);
      }
      const parsed = z
        .object({
          windowMs: z.number().finite().min(0).max(RECEIPT_RETENTION_MS).optional(),
          limit: z.number().int().min(1).max(10000).optional(),
        })
        .strict()
        .safeParse(request.params ?? {});
      if (!parsed.success) {
        return {
          success: false,
          code: "session_config_invalid",
          error: "Invalid broker stats window or limit",
        };
      }
      return {
        success: true,
        result: { ...(await service.broker.stats(parsed.data.windowMs, parsed.data.limit)) },
      };
    },
  ],
  [
    "daemon/prepareSession",
    (request, state, _executions, signal, context) =>
      handlePrepareBrokerSession(request, state, signal, context.socketSessionId),
  ],
  ["daemon/getSessionExport", (request, state) => handleGetSessionExport(request, state)],
  [
    "daemon/acknowledgeSessionExport",
    (request, state) => handleAcknowledgeSessionExport(request, state),
  ],
  [
    "daemon/sessionRequestStatus",
    (request, state, _executions, _signal, context) =>
      handleBrokerSessionStatus(request, state, context.socketSessionId),
  ],
  [
    "daemon/abandonSessionRequest",
    (request, state) => handleAbandonBrokerSessionRequest(request, state),
  ],
  ["daemon/releaseBrokerSession", (request, state) => handleReleaseBrokerSession(request, state)],
  ["daemon/drainBrokerPool", (request, state) => handleDrainBrokerPool(request, state)],
];

/** Operator drain of idle pooled devices; takes no parameters and binds no connection. */
export async function handleDrainBrokerPool(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable(state);
  }
  const parsed = z
    .object({})
    .strict()
    .safeParse(request.params ?? {});
  if (!parsed.success) {
    return { success: false, code: "session_config_invalid", error: "Drain takes no parameters" };
  }
  try {
    return { success: true, result: { ...(await service.broker.drainIdlePool()) } };
  } catch (error) {
    return brokerRejection(error);
  }
}

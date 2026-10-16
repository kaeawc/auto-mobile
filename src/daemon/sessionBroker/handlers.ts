import { z } from "zod";
import { parseSessionConfig } from "../../devices/sessionConfig";
import { SESSION_OWNER_EXITED_CODE } from "../../devices/sessionBrokerResult";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { DaemonRequest } from "../types";
import type { DaemonMethodResult, DaemonStateAccess } from "../daemonRequestHandlers";

const ownerToken = z.string().min(1);
const prepareParams = z.object({ config: z.unknown(), livenessOwnerToken: ownerToken }).strict();
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
    return unavailable();
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
  const result = await service.broker.prepare(config, parsed.data.livenessOwnerToken, signal);
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

export async function handleBrokerSessionStatus(
  request: DaemonRequest,
  state: DaemonStateAccess,
  socketSessionId?: string,
): Promise<DaemonMethodResult> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable();
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
    return unavailable();
  }
  const parsed = abandonParams.safeParse(request.params);
  if (!parsed.success) {
    return { success: false, error: "requestId and livenessOwnerToken are required" };
  }
  const result = await service.broker.abandon(
    parsed.data.requestId,
    parsed.data.livenessOwnerToken,
  );
  return { success: true, result: { ...result } };
}

export async function handleReleaseBrokerSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const service = state.getSessionBrokerService?.();
  if (!service) {
    return unavailable();
  }
  const parsed = releaseParams.safeParse(request.params);
  if (!parsed.success) {
    return { success: false, error: "sessionId and livenessOwnerToken are required" };
  }
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
    result: { ...(await service.broker.release(parsed.data.sessionId, parsed.data.reason)) },
  };
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
    return unavailable();
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

function unavailable(): DaemonMethodResult {
  return {
    success: false,
    code: "session_broker_unavailable",
    error: "Session-broker mode is not available in this provider",
  };
}

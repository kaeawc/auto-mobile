import { bindBrokerRegistration } from "../sessionBroker/handlers";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { type ReleaseCutExecutions } from "../releaseSessionAndDevice";
import { z } from "zod";
import {
  MAX_OBSERVER_CLIENT_NAME_LENGTH,
  MAX_OBSERVER_SESSION_ID_LENGTH,
  type ObserverSessionStore,
} from "../observerSessionRegistry";
import { DaemonRequest, releasedSessionNotFoundFields } from "../types";
import { type SessionReleaseSnapshot } from "../sessionManager";
import { sessionForIngress } from "../sessionForIngress";
import {
  DAEMON_REGISTER_SESSION_METHOD,
  SESSION_RELEASE_DRAIN_TIMEOUT_MS,
} from "../wire/constants";
import { SESSION_OWNERSHIP_LOST_CODE } from "../sessionReleasedDuringCall";
import {
  idleReleaseField,
  isExpiryReleaseReason,
  isTerminalReleaseReason,
} from "../releaseReasons";
import { ACQUIRE_NEW_SESSION_NEXT_ACTION } from "../../models/deviceSessionRecovery";
import { type BrokerConnectionBinding } from "../sessionBroker/connectionScope";
import { DeviceOutsideBrokerGrantError } from "../sessionBroker/connectionRefusal";
import type { DaemonStateAccess, DaemonMethodResult, DaemonRequestContext } from "./contracts";
import { reportedWallClock, lookupReleasedSessionReason } from "./sessionReporting";

const registerSessionParams = z.object({
  sessionId: z.string().max(MAX_OBSERVER_SESSION_ID_LENGTH).uuid(),
  clientName: z.string().max(MAX_OBSERVER_CLIENT_NAME_LENGTH).trim().min(1),
  sessionBroker: z
    .object({
      requestId: z.string().min(1),
      livenessOwnerToken: z.string().min(1),
    })
    .strict()
    .optional(),
});

/** A same-scope managed placeholder may prove its holds; other bindings keep session confinement. */
function brokerConnectionSessionRegistrationRefusal(
  binding: BrokerConnectionBinding | undefined,
  sessionId: string,
): DaemonMethodResult | undefined {
  if (binding && !binding.sessionUuids.has(sessionId)) {
    const refusal = new DeviceOutsideBrokerGrantError(
      DAEMON_REGISTER_SESSION_METHOD,
      "session",
      binding.scopeKey,
      { sessionUuid: sessionId },
    );
    return { success: false, code: refusal.code, retryable: false, error: refusal.message };
  }
  return undefined;
}

/** Wait (bounded) for an in-flight release of `sessionId`; a retry failure when it outlasts it. */
async function releaseDrainRefusal(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
): Promise<DaemonMethodResult | undefined> {
  const drained = await manager.waitForSessionReleaseWithin?.(
    sessionId,
    SESSION_RELEASE_DRAIN_TIMEOUT_MS,
  );
  return drained === false
    ? {
        success: false,
        error: `Session ${sessionId} release is still in progress after ${SESSION_RELEASE_DRAIN_TIMEOUT_MS}ms; retry registration`,
      }
    : undefined;
}

/**
 * The terminal refusal for registering a UUID that an idle or heartbeat release ended (#11367), or
 * undefined when the UUID may register. Such a UUID never comes back, so admitting it as an
 * observer would let a client heartbeat and re-authenticate streams under a dead session. The
 * answer is the standard `session_ownership_lost` (not retryable, `acquire_new_session`) with the
 * release reason and, for an idle-window release, `idle: true`. A never-issued UUID has no
 * snapshot and no row, and still registers as an observer.
 *
 * A registration's live lookup may start lazy expiry before teardown publishes the terminal
 * snapshot. Without that snapshot, consult the existing read-only terminal answer first, then
 * the expired-row snapshot or persisted release (also covering daemon restarts). The read changes
 * nothing: a handoff or `plan-auto-release` row still inside its window keeps registering.
 */
async function lookupTerminalSessionRegistrationRefusal(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
): Promise<DaemonMethodResult | undefined> {
  const snapshot = inMemorySessionRelease(manager, sessionId);
  let expired: SessionReleaseSnapshot | undefined;
  if (!snapshot) {
    try {
      expired = await manager.getExpiredReleaseSnapshot?.(sessionId);
    } catch (error) {
      logger.warn(`Expired snapshot lookup failed for ${sessionId}: ${errorMessage(error)}`, error);
    }
  }
  const release = snapshot ?? expired ?? (await persistedTerminalRelease(manager, sessionId));
  return terminalSessionRegistrationRefusal(sessionId, release, expired !== undefined);
}

/** The release this UUID ended or is ending with, without yielding or starting teardown. */
function inMemorySessionRelease(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
): SessionReleaseSnapshot | undefined {
  return (
    manager.getTerminalReleaseSnapshot?.(sessionId) ??
    manager.peekTerminalAnswerForEndedSession?.(sessionId)?.release
  );
}

/** Build the unchanged terminal-expiry refusal; expired rows also qualify without an expiry reason. */
function terminalSessionRegistrationRefusal(
  sessionId: string,
  release: Pick<SessionReleaseSnapshot, "releaseReason" | "terminal" | "ownerPid"> | undefined,
  expiredRow = false,
): DaemonMethodResult | undefined {
  if (!release?.terminal || (!expiredRow && !isExpiryReleaseReason(release.releaseReason))) {
    return undefined;
  }
  const { releaseReason, ownerPid } = release;
  return {
    success: false,
    code: SESSION_OWNERSHIP_LOST_CODE,
    retryable: false,
    nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
    error:
      `Session ${sessionId} is terminal after ${releaseReason} and cannot be registered again. ` +
      "Acquire a new device with getAndroid or getApple, or register a new session UUID to observe.",
    details: {
      sessionUuid: sessionId,
      reason: releaseReason,
      ...idleReleaseField(releaseReason),
      ...(ownerPid === undefined ? {} : { ownerPid }),
    },
    ...releasedSessionNotFoundFields(releaseReason),
  };
}

/** The persisted release of a UUID this daemon holds no snapshot for (best-effort read). */
async function persistedTerminalRelease(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
): Promise<Pick<SessionReleaseSnapshot, "releaseReason" | "terminal" | "ownerPid"> | undefined> {
  const releaseReason = await lookupReleasedSessionReason(manager, sessionId);
  return releaseReason === undefined
    ? undefined
    : { releaseReason, terminal: isTerminalReleaseReason(releaseReason) };
}

/** The accepted registration of a UUID that is a live device session, or undefined. */
function liveSessionRegistration(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  clientName: string,
): DaemonMethodResult | undefined {
  const session = sessionForIngress(manager, sessionId);
  if (!session) {
    return undefined;
  }
  manager.recordSessionClientName?.(sessionId, clientName);
  return {
    success: true,
    result: {
      accepted: true,
      heartbeatTimeoutMs: session.heartbeatTimeoutMs,
      // Reported to another process: wall-clock epoch ms, not the session clock (#11243).
      expiresAtMs: reportedWallClock(manager, session.lastHeartbeat + session.heartbeatTimeoutMs),
    },
  };
}

/** Start or join lazy idle expiry before publishing its refusal, without waiting for teardown. */
function releaseBeforeRegistrationRefusal(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  refusal: DaemonMethodResult,
): DaemonMethodResult {
  manager.terminalAnswerForEndedSession?.(sessionId);
  return refusal;
}

export async function handleRegisterSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
  _executions?: ReleaseCutExecutions,
  _signal?: AbortSignal,
  context: DaemonRequestContext = {},
): Promise<DaemonMethodResult> {
  const params: unknown = request.params;
  const parsed = registerSessionParams.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: `Invalid registerSession parameters: ${parsed.error.message}` };
  }
  const { sessionId, clientName } = parsed.data;
  const refusal = await bindExecutionRegistration(state, parsed.data, context);
  if (refusal) {
    return refusal;
  }
  const manager = state.getSessionManager();
  const draining = await releaseDrainRefusal(manager, sessionId);
  if (draining) {
    return draining;
  }
  const live = liveSessionRegistration(manager, sessionId, clientName);
  if (live) {
    return live;
  }
  const terminal = await lookupTerminalSessionRegistrationRefusal(manager, sessionId);
  if (terminal) {
    return releaseBeforeRegistrationRefusal(manager, sessionId, terminal);
  }
  // The persisted read yielded: a session issued meanwhile answers as itself, never an observer.
  const issued = liveSessionRegistration(manager, sessionId, clientName);
  if (issued) {
    return issued;
  }
  // This last lookup may itself start lazy expiry. Judge its end synchronously before registering.
  const ended = terminalSessionRegistrationRefusal(
    sessionId,
    inMemorySessionRelease(manager, sessionId),
  );
  if (ended) {
    return releaseBeforeRegistrationRefusal(manager, sessionId, ended);
  }
  return observerSessionRegistration(state.getObserverSessionRegistry?.(), sessionId, clientName);
}

/** Register an observer only after synchronous device-session admission has finished. */
function observerSessionRegistration(
  registry: ObserverSessionStore | undefined,
  sessionId: string,
  clientName: string,
): DaemonMethodResult {
  if (!registry) {
    return { success: false, error: "Observer session registration is unavailable" };
  }
  const registration = registry.register(sessionId, clientName);
  return registration.accepted
    ? { success: true, result: { ...registration } }
    : { success: false, error: registration.error };
}

async function bindExecutionRegistration(
  state: DaemonStateAccess,
  registration: z.infer<typeof registerSessionParams>,
  context: DaemonRequestContext,
): Promise<DaemonMethodResult | undefined> {
  const { sessionId, sessionBroker } = registration;
  if (sessionBroker) {
    const brokerRefusal = await bindBrokerRegistration(
      state,
      sessionId,
      sessionBroker,
      context.socketSessionId,
    );
    if (brokerRefusal) {
      return brokerRefusal;
    }
  }
  const refusal = brokerConnectionSessionRegistrationRefusal(
    state.getBrokerConnectionScopes?.().get(context.socketSessionId),
    sessionId,
  );
  if (refusal) {
    return refusal;
  }
  return undefined;
}

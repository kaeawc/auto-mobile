import { sessionDeviceInfo } from "./sessionDeviceBinding";
import { releaseCleanupStatus } from "./releaseCleanupStatus";
import { holderOf } from "./deviceBinding";
import {
  SESSION_BROKER_CAPABILITY,
  SESSION_BROKER_EXPORT_CAPABILITY,
  SESSION_BROKER_IOS_DUO_CAPABILITY,
} from "./sessionBroker/hostConfig";
import { BROKER_DAEMON_METHOD_HANDLERS } from "./sessionBroker/handlers";
import { BootedDeviceDiscoveryIncompleteError } from "../models/BootedDeviceDiscoveryIncompleteError";
import { isSessionReleasing } from "./sessionReleaseState";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import {
  cancelExecutionsCutBySessionRelease,
  releasePoolDevice,
  releaseSessionAndDevice,
  type ReleaseCutExecutions,
} from "./releaseSessionAndDevice";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { z } from "zod";
import {
  DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
  DaemonRequest,
} from "./types";
import { Session } from "./sessionManager";
import { sessionForIngress } from "./sessionForIngress";
import type { LivenessLeasePhase, LivenessLeaseState } from "./livenessOwnerLease";
import {
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_RELEASE_SESSION_METHOD,
  DAEMON_TOKEN_OWNED_SESSIONS_METHOD,
  DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD,
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_LIST_DEVICE_SESSIONS_METHOD,
  DAEMON_DEVICE_LEASE_STATUS_METHOD,
  DAEMON_RELINQUISH_DEVICE_LEASE_METHOD,
} from "./wire/constants";
import { executionTracker } from "./executionTracker";
import { sessionHoldDiagnostics } from "./sessionHoldDiagnostics";
import { readDeviceLeaseActivity, type DeviceLeaseActivitySources } from "./deviceLeaseActivity";
import { SessionReleasedDuringCallError } from "./sessionReleasedDuringCall";
import { canonicalFrameDeviceId } from "./frameDeviceIdentity";
import {
  brokerConnectionControlRefusal,
  brokerConnectionHostMutationRefusal,
} from "./sessionBroker/connectionScope";
import {
  daemonDeviceLeaseActivitySources,
  daemonDeviceLeaseRelinquishPort,
} from "./deviceLeaseActivitySources";
import { decideOwnerRelinquish } from "../features/observe/shared/ctrlProxyForwardLeaseOwnership";
import { screenLockRestoreResult } from "./screenLockSessionCleanup";
import { powerRestoreResult } from "./powerSessionCleanup";
import type {
  DaemonStateAccess,
  DevicePoolStats,
  DaemonMethodResult,
  ListedDeviceSessionRecord,
  DaemonRequestContext,
  DaemonRequestOptions,
  InitializedDaemonMethodHandler,
  InitializedDaemonMethodOptions,
} from "./daemonRequestHandlersParts/contracts";
import {
  reportedWallClock,
  sessionNotFoundResult,
  lookupReleasedSessionReason,
} from "./daemonRequestHandlersParts/sessionReporting";
import { handleRegisterSession } from "./daemonRequestHandlersParts/registration";
import {
  handleReleaseLivenessOwnership,
  handleTokenOwnedSessions,
  handleHeartbeat,
} from "./daemonRequestHandlersParts/heartbeat";

export type {
  DaemonStateAccess,
  DevicePoolStats,
  DaemonMethodResult,
  DaemonRequestContext,
  DaemonRequestOptions,
  InitializedDaemonMethodHandler,
  InitializedDaemonMethodOptions,
} from "./daemonRequestHandlersParts/contracts";
export {
  isTokenOwnedOrClaimPending,
  type HeartbeatMiss,
  resolveHeartbeatMiss,
  refuseCliKeeperOnProxySession,
} from "./daemonRequestHandlersParts/heartbeat";

/** Socket endpoint clients may query before sending optional newer parameters. */
export const DAEMON_CAPABILITIES_METHOD = "daemon/capabilities";

/** Non-destructive Android text input introduced with desktop keyboard forwarding. */
export const INPUT_TYPE_TEXT_APPEND_CAPABILITY = "input/typeText.mode:append";

/**
 * Streaming (real-time) gesture input: `input/gestureStart` / `input/gestureMove` /
 * `input/gestureEnd`, chained into one continued on-device gesture (Android only). A client probes
 * for this before streaming a drag; when absent it falls back to the atomic `input/swipe`.
 */
export const INPUT_GESTURE_STREAM_CAPABILITY = "input/gestureStream";

export async function handleDaemonRequest(
  request: DaemonRequest,
  state: DaemonStateAccess,
  options: DaemonRequestOptions = {},
): Promise<DaemonMethodResult> {
  if (!request.method.startsWith("daemon/")) {
    return {
      success: false,
      error: `Unsupported daemon method: ${request.method}`,
    };
  }

  // This is daemon self-description, not a pool operation. Keep it available while startup is
  // still settling so a client can decide whether to issue an optional request before forwarding.
  if (request.method === DAEMON_CAPABILITIES_METHOD) {
    return {
      success: true,
      result: {
        capabilities: [
          INPUT_TYPE_TEXT_APPEND_CAPABILITY,
          INPUT_GESTURE_STREAM_CAPABILITY,
          DAEMON_REGISTER_SESSION_METHOD,
          ...(state.isSessionBrokerMode?.()
            ? [SESSION_BROKER_CAPABILITY, SESSION_BROKER_EXPORT_CAPABILITY]
            : []),
          ...(state.isSessionBrokerMode?.() &&
          state.getSessionBrokerService?.()?.broker.supportsIosDuo()
            ? [SESSION_BROKER_IOS_DUO_CAPABILITY]
            : []),
        ],
      },
    };
  }

  if (!state.isInitialized()) {
    return {
      success: false,
      error: "Daemon not initialized",
    };
  }

  return handleInitializedDaemonRequest(request, state, options);
}

/** Socket daemon methods served once the daemon is initialized, by method name. */
const INITIALIZED_DAEMON_METHOD_HANDLERS: ReadonlyMap<string, InitializedDaemonMethodHandler> =
  new Map<string, InitializedDaemonMethodHandler>([
    ...BROKER_DAEMON_METHOD_HANDLERS,
    [DAEMON_REGISTER_SESSION_METHOD, handleRegisterSession],
    [DAEMON_RELEASE_LIVENESS_OWNERSHIP_METHOD, handleReleaseLivenessOwnership],
    [DAEMON_HEARTBEAT_METHOD, handleHeartbeat],
    [DAEMON_TOKEN_OWNED_SESSIONS_METHOD, handleTokenOwnedSessions],
    [
      "daemon/refreshDevices",
      (request, state, { context }) => handleRefreshDevices(request, state, context),
    ],
    ["daemon/availableDevices", handleAvailableDevices],
    ["daemon/sessionInfo", (request, state) => handleSessionInfo(request, state)],
    ["daemon/activeSessions", (request, state) => handleActiveSessions(request, state)],
    [
      DAEMON_RELEASE_SESSION_METHOD,
      (request, state, { executions, context }) =>
        handleReleaseSession(request, state, executions, context),
    ],
    [DAEMON_LIST_DEVICE_SESSIONS_METHOD, handleListDeviceSessions],
    [DAEMON_DEVICE_LEASE_STATUS_METHOD, handleDeviceLeaseStatus],
    [DAEMON_RELINQUISH_DEVICE_LEASE_METHOD, handleRelinquishDeviceLease],
  ]);

async function handleInitializedDaemonRequest(
  request: DaemonRequest,
  state: DaemonStateAccess,
  options: DaemonRequestOptions,
): Promise<DaemonMethodResult> {
  const handler = INITIALIZED_DAEMON_METHOD_HANDLERS.get(request.method);
  if (!handler) {
    return {
      success: false,
      error: `Unsupported daemon method: ${request.method}`,
    };
  }
  return await handler(request, state, { ...options, context: options.context ?? {} });
}

/**
 * Pool stats with a fresh broker binding snapshot and foreign-daemon ownership, so `availableDevices`
 * means "allocation can lend it". An unreadable binding registry fails the call (as listDevices does)
 * rather than reporting held devices as idle.
 */
async function refreshedPoolStats(
  pool: ReturnType<DaemonStateAccess["getDevicePool"]>,
): Promise<
  | { ok: true; stats: DevicePoolStats; deviceIds?: ReadonlySet<string> }
  | { ok: false; refusal: Pick<DaemonMethodResult, "success" | "error" | "code" | "retryable"> }
> {
  try {
    if (pool.getRefreshedInventory) {
      const { stats, deviceIds } = await pool.getRefreshedInventory();
      return { ok: true, stats, deviceIds };
    }
    return {
      ok: true,
      stats: pool.getRefreshedStats ? await pool.getRefreshedStats() : pool.getStats(),
    };
  } catch (error) {
    logger.warn(`[Daemon] Could not refresh device ownership: ${errorMessage(error)}`, error);
    return {
      ok: false,
      refusal: {
        success: false,
        error: `Could not determine which devices are available: ${errorMessage(error)}. Resolve the cause and retry.`,
        // The count is unknown, not zero: keep the typed, retryable refusal on the wire (#11605).
        ...(error instanceof BootedDeviceDiscoveryIncompleteError
          ? { code: error.code, retryable: error.retryable }
          : {}),
      },
    };
  }
}

async function handleRefreshDevices(
  request: DaemonRequest,
  state: DaemonStateAccess,
  context: DaemonRequestContext,
): Promise<DaemonMethodResult> {
  const refusal = brokerConnectionHostMutationRefusal({
    binding: state.getBrokerConnectionScopes?.().get(context.socketSessionId),
    action: request.method,
  });
  if (refusal) {
    return { success: false, code: refusal.code, error: refusal.message };
  }
  const pool = state.getDevicePool();
  const outcome = pool.refreshDevicesWithOutcome
    ? await pool.refreshDevicesWithOutcome()
    : { addedCount: await pool.refreshDevices() };
  if (outcome.failure !== undefined) {
    return {
      success: false,
      error: `Could not refresh device list: ${outcome.failure}. Resolve the cause and retry.`,
    };
  }
  const refreshed = await refreshedPoolStats(pool);
  if (!refreshed.ok) {
    return refreshed.refusal;
  }
  const stats = refreshed.stats;
  return {
    success: true,
    result: {
      addedDevices: outcome.addedCount,
      totalDevices: stats.total,
      availableDevices: stats.idle,
      stats,
    },
  };
}

async function handleAvailableDevices(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const pool = state.getDevicePool();
  const refreshed = await refreshedPoolStats(pool);
  if (!refreshed.ok) {
    return refreshed.refusal;
  }
  const stats = refreshed.stats;
  const recoveryPolicy = pool.getRecoveryPolicy?.();
  // List only the devices the counts cover, so a phantom entry is neither counted nor listed.
  const devices = pool
    .getAllDevices?.()
    .filter((device) => !refreshed.deviceIds || refreshed.deviceIds.has(device.id))
    .map((device) => ({
      deviceId: device.id,
      platform: device.platform,
      recoveryEligibility: pool.getRecoveryEligibility?.(device.id),
      ...(pool.getDeviceHealthMarker?.(device.id)
        ? { unhealthy: pool.getDeviceHealthMarker(device.id) }
        : {}),
    }));
  return {
    success: true,
    result: {
      availableDevices: stats.idle,
      totalDevices: stats.total,
      assignedDevices: stats.assigned,
      errorDevices: stats.error,
      stats,
      ...(recoveryPolicy ? { recoveryPolicy } : {}),
      ...(devices ? { devices } : {}),
    },
  };
}

/** Per-session in-flight execution count for the hold diagnostics (#10671). */
export interface SessionExecutionCounter {
  getActiveDeviceSessionExecutionCount(sessionUuid: string): number;
}

export async function handleSessionInfo(
  request: DaemonRequest,
  state: Pick<DaemonStateAccess, "getSessionManager">,
  executions: SessionExecutionCounter = executionTracker,
): Promise<DaemonMethodResult> {
  const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error: "sessionId parameter required",
    };
  }
  const manager = state.getSessionManager();
  const session = sessionForIngress(manager, sessionId);
  if (!session) {
    return sessionNotFoundResult(manager, sessionId);
  }
  return {
    success: true,
    result: {
      sessionId: session.sessionId,
      assignedDevice: session.assignedDevice,
      ...sessionDeviceInfo(session),
      platform: session.platform,
      // Wall-clock epoch ms, like the hold diagnostics beside them (#11243).
      createdAt: reportedWallClock(manager, session.createdAt),
      lastUsedAt: reportedWallClock(manager, session.lastUsedAt),
      expiresAt: reportedWallClock(manager, session.expiresAt),
      cacheSize: JSON.stringify(session.cacheData).length,
      ...sessionHoldDiagnostics(
        session,
        executions.getActiveDeviceSessionExecutionCount(sessionId),
        manager.getIdleReleaseExecutionVeto?.(sessionId),
        (ms) => reportedWallClock(manager, ms),
        manager.getSessionLeaseState?.(sessionId)?.phase,
      ),
      ...livenessInfo(manager.getSessionLeaseState?.(sessionId)),
      ...(isSessionReleasing(manager, sessionId, session) ? { releasing: true } : {}),
    },
  };
}

/**
 * Additive `liveness` field for `session-info` (#10051): `state` is `live`, or
 * `suspect` while the owner's lease has expired and the session is held for its
 * grace window; `remainingMs` counts down the lease (live) or the grace (suspect).
 */
function livenessInfo(
  lease: LivenessLeaseState | undefined,
): { liveness: { state: LivenessLeasePhase; remainingMs: number } } | Record<string, never> {
  return lease ? { liveness: { state: lease.phase, remainingMs: lease.remainingMs } } : {};
}

export async function handleActiveSessions(
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions: SessionExecutionCounter & { getActiveExecutionCount(): number } = executionTracker,
): Promise<DaemonMethodResult> {
  const manager = state.getSessionManager();
  const sessions = manager.getAllSessions?.() ?? [];
  const releasingSessions = sessions.filter((session) =>
    isSessionReleasing(manager, session.sessionId, session),
  ).length;
  // Who holds which device and why (#10671). Opt-in, so the counts-only reply busy checks poll
  // stays as small as it was.
  const includeSessions =
    (request.params as { includeSessions?: unknown } | undefined)?.includeSessions === true;
  return {
    success: true,
    result: {
      activeSessions: sessions.length,
      activeExecutions: executions.getActiveExecutionCount(),
      ...(releasingSessions > 0 ? { releasingSessions } : {}),
      ...(includeSessions
        ? {
            sessions: sessions.map((session) => ({
              sessionId: session.sessionId,
              assignedDevice: session.assignedDevice,
              ...sessionDeviceInfo(session),
              platform: session.platform,
              ...sessionHoldDiagnostics(
                session,
                executions.getActiveDeviceSessionExecutionCount(session.sessionId),
                manager.getIdleReleaseExecutionVeto?.(session.sessionId),
                (ms) => reportedWallClock(manager, ms),
                manager.getSessionLeaseState?.(session.sessionId)?.phase,
              ),
              ...(isSessionReleasing(manager, session.sessionId, session)
                ? { releasing: true }
                : {}),
            })),
          }
        : {}),
    },
  };
}

/**
 * The refusal for a lifecycle request from a connection bound to broker bindings (#11178, #11596):
 * it ends only its own binding sessions and gives up only its own binding devices. Undefined for a
 * generic connection, and for a request that carries no socket (the daemon's own callers).
 */
function brokerConnectionLifecycleRefusal(
  state: DaemonStateAccess,
  context: DaemonRequestContext,
  action: string,
  target: { sessionUuid?: string; deviceId?: string },
): DaemonMethodResult | undefined {
  const manager = state.getSessionManager();
  const refusal = brokerConnectionControlRefusal({
    binding: state.getBrokerConnectionScopes?.().get(context.socketSessionId),
    action,
    // Binding sessions hold the pooled canonical id; the request may name the device by an alias.
    deviceId:
      target.deviceId === undefined
        ? undefined
        : canonicalFrameDeviceId(state.getDevicePool(), target.deviceId),
    requesterSessionUuid: target.sessionUuid,
    grantedDeviceOf: (sessionUuid) => manager.getSession(sessionUuid)?.assignedDevice ?? undefined,
  });
  return refusal ? { success: false, code: refusal.code, error: refusal.message } : undefined;
}

/**
 * Release a session by id. Any ordinary connection may release any session (owner contract); a
 * connection bound to broker bindings is confined to its own binding sessions.
 */
async function handleReleaseSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
  executions?: ReleaseCutExecutions,
  context: DaemonRequestContext = {},
): Promise<DaemonMethodResult> {
  const params = request.params as
    | { sessionId?: string; requireKnown?: boolean; livenessOwnerToken?: string }
    | undefined;
  const sessionId = params?.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error: "sessionId parameter required",
    };
  }
  const refusal = brokerConnectionLifecycleRefusal(state, context, DAEMON_RELEASE_SESSION_METHOD, {
    sessionUuid: sessionId,
  });
  if (refusal) {
    return refusal;
  }
  const manager = state.getSessionManager();
  const ownerRefusal = releaseSessionOwnerRefusal(manager, sessionId, params?.livenessOwnerToken);
  if (ownerRefusal) {
    return ownerRefusal;
  }
  const session = manager.getSession(sessionId) ?? manager.getReleasingSession?.(sessionId);
  if (!session && !manager.hasSession(sessionId)) {
    return await releaseSessionWithoutDevice(
      state,
      sessionId,
      params?.requireKnown === true,
      executions,
    );
  }
  return releaseBoundSession(state, manager, sessionId, { session, executions });
}

/** An owner-scoped release is refused before any lookup that can stamp clocks or expire a session. */
function releaseSessionOwnerRefusal(
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  token: string | undefined,
): DaemonMethodResult | undefined {
  if (typeof token !== "string" || token.length === 0) {
    return undefined;
  }
  if (!manager.hasSession(sessionId) && !manager.getReleasingSession?.(sessionId)) {
    return undefined;
  }
  const owner = manager.getSessionLivenessOwnerToken
    ? manager.getSessionLivenessOwnerToken(sessionId)
    : (manager.getSession(sessionId) ?? manager.getReleasingSession?.(sessionId))
        ?.livenessOwnerToken;
  if (owner === token) {
    return undefined;
  }
  return {
    success: false,
    code: DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE,
    error: `Session ${sessionId} can only be released by its current liveness owner; nothing changed.`,
  };
}

/** Release an id with no device session behind it: an observer session, or an unknown id. */
async function releaseSessionWithoutDevice(
  state: DaemonStateAccess,
  sessionId: string,
  requireKnown: boolean,
  executions: ReleaseCutExecutions | undefined,
): Promise<DaemonMethodResult> {
  if (typeof sessionId === "string" && state.getObserverSessionRegistry?.()?.release(sessionId)) {
    return {
      success: true,
      result: {
        message: `Session ${sessionId} released`,
        alreadyReleased: false,
      },
    };
  }
  return await releaseUnknownSession(state, state.getSessionManager(), sessionId, {
    requireKnown,
    executions,
  });
}

/** Restores a release reports in its result: keep-awake settings, the session's screen lock and power state. */
async function releaseRestoreReports(
  state: DaemonStateAccess,
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
) {
  const keepAwakeRestore = manager.getKeepAwakeRestoreReport?.(sessionId);
  const reports = {
    ...(keepAwakeRestore ? { keepAwakeRestore } : {}),
    ...(await screenLockRestoreResult(sessionId, { registry: state.getScreenLockRegistry?.() })),
    ...(await powerRestoreResult(sessionId, { registry: state.getPowerRegistry?.() })),
  };
  const cleanup = releaseCleanupStatus(reports);
  return { ...reports, ...(cleanup ? { cleanup } : {}) };
}

/**
 * An unknown id stays idempotent for programmatic callers (the desktop releases sessions a
 * restarted daemon forgot). A caller that sets `requireKnown` (the `--daemon release-session`
 * CLI) is told when the daemon never issued the UUID, so a typo is not reported as success
 * (#11148). A session this daemon issued and already released stays idempotent either way.
 */
async function releaseUnknownSession(
  state: DaemonStateAccess,
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  { requireKnown, executions }: { requireKnown: boolean; executions?: ReleaseCutExecutions },
): Promise<DaemonMethodResult> {
  // Not in the session map is not the same as released (#11461): a restart handoff this daemon has
  // not recovered yet, or a session still being created, would come back after an "already
  // released" answer. The manager's release path ends those terminally; it resolves null when
  // there was nothing to release. A UUID already fenced terminal needs no second release.
  if (!manager.getTerminalReleaseSnapshot?.(sessionId)) {
    const deviceId = await manager.releaseSession(sessionId);
    // A recovery that won the race published the session meanwhile: release it like any held one.
    const published = manager.getSession(sessionId) ?? manager.getReleasingSession?.(sessionId);
    if (published || manager.hasSession(sessionId)) {
      return releaseBoundSession(state, manager, sessionId, { session: published, executions });
    }
    if (deviceId !== null && deviceId !== undefined) {
      const pool = state.getDevicePool();
      // The row no longer recovers, so its device is no longer held for it (#11294).
      pool.releaseRehydrationReservation?.(sessionId);
      // A session released while it was being created may already hold its device in the pool;
      // this frees it only if this session is the holder.
      await releasePoolDevice(pool, deviceId, sessionId);
      return {
        success: true,
        result: {
          message: `Session ${sessionId} released`,
          device: deviceId,
          alreadyReleased: false,
        },
      };
    }
  }
  return reportUnboundSessionRelease(state, manager, sessionId, requireKnown);
}

async function reportUnboundSessionRelease(
  state: DaemonStateAccess,
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  requireKnown: boolean,
): Promise<DaemonMethodResult> {
  const known =
    Boolean(manager.getTerminalReleaseSnapshot?.(sessionId)) ||
    (await lookupReleasedSessionReason(manager, sessionId)) !== undefined;
  if (requireKnown && !known) {
    return {
      success: false,
      error:
        `Session ${sessionId} is not a known session (never issued by this daemon, or its release ` +
        "record has expired). Run --daemon active-sessions to list held sessions.",
      code: DAEMON_SESSION_NOT_FOUND_CODE,
    };
  }
  const reports = await releaseRestoreReports(state, manager, sessionId);
  const cleanupMessage =
    reports.cleanup === "failed"
      ? "; cleanup failed"
      : reports.cleanup === "pending"
        ? "; cleanup still pending"
        : "";
  return {
    success: true,
    result: {
      message: known
        ? `Session ${sessionId} already released${cleanupMessage}`
        : `Session ${sessionId} is not known to this daemon (never issued, or its release record expired); nothing was released`,
      alreadyReleased: known,
      known,
      ...reports,
    },
  };
}

async function releaseBoundSession(
  state: DaemonStateAccess,
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  {
    session,
    executions = executionTracker,
  }: { session: Session | null | undefined; executions?: ReleaseCutExecutions },
): Promise<DaemonMethodResult> {
  const pool = state.getDevicePool();
  // A failed terminal write hides routing identity while retaining ownership.
  let deviceId =
    session?.assignedDevice ?? manager.getTerminalReleaseSnapshot?.(sessionId)?.deviceId ?? null;
  // An explicit release is terminal and immediate (docs/using/device-ownership.md): it waits for
  // no call, so every call it cuts is told the session is gone, as a call arriving after the
  // release is (#11393). It cuts through the routine every other release uses, so an implicit
  // (autolock) call is aborted too rather than left driving the freed device. The requester is a
  // daemon request, never a tracked execution, so it is not cut. The aborts are signalled
  // synchronously: with or without work in flight, the release starts in this turn.
  cancelExecutionsCutBySessionRelease(
    executions,
    {
      sessionId,
      baseSessionId: resolveToolSelectionBaseSessionUuid(sessionId, manager),
      deviceId,
    },
    new SessionReleasedDuringCallError(sessionId, "explicit-release"),
  ).catch((error: unknown) => {
    logger.warn(
      `Failed to cancel executions of explicitly released session ${sessionId}: ${errorMessage(error)}`,
      error,
    );
  });
  await releaseSessionAndDevice(manager, pool, deviceId, sessionId, {
    release: async () => {
      deviceId = await manager.releaseSession(sessionId);
      return deviceId;
    },
  });
  return {
    success: true,
    result: {
      message: `Session ${sessionId} released`,
      device: deviceId,
      alreadyReleased: false,
      ...(await releaseRestoreReports(state, manager, sessionId)),
    },
  };
}

async function handleListDeviceSessions(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const registry = state.getDeviceSessionRegistry();
  const pool = state.getDevicePool();
  const deviceSessions: ListedDeviceSessionRecord[] = registry.list().map((record) => ({
    deviceSessionUuid: record.deviceSessionUuid,
    deviceId: record.deviceId,
    platform: record.platform,
    epochStartedAt: record.epochStartedAt,
    ...(pool.getDeviceHealthMarker?.(record.deviceId)
      ? { unhealthy: pool.getDeviceHealthMarker(record.deviceId) }
      : {}),
    ...(pool.isPooledIdentityUnresolved?.(record.deviceId) === true
      ? { identityUnresolved: true as const }
      : {}),
  }));
  return {
    success: true,
    result: {
      deviceSessions,
      totalDeviceSessions: deviceSessions.length,
    },
  };
}

/**
 * The session that holds a device here, for a lease-status or relinquish answer. A device the pool
 * assigned (and claimed) is in use even before its session is published to the session manager,
 * which happens only after the session row persists (#11158): answering "no session" in that
 * window would let a peer take over the allocation claim and assign the same device.
 */
function deviceLeaseActivitySourcesFor(state: DaemonStateAccess): DeviceLeaseActivitySources {
  const pool = state.getDevicePool();
  const override = state.getDeviceLeaseActivitySources?.();
  if (override) {
    return withShutdownActivity(override, pool);
  }
  const manager = state.getSessionManager();
  return withShutdownActivity(
    daemonDeviceLeaseActivitySources(
      (id) => manager.getSessionForDevice?.(id) ?? holderOf(pool.getDevice?.(id)) ?? null,
    ),
    pool,
  );
}

/**
 * A device this daemon is stopping (killDevice, deleteDevice) is in use here even with no session
 * on it: the stop published an allocation claim (#11200), and answering "idle" would let a peer
 * take the claim over and bind the device while it is being killed.
 */
function withShutdownActivity(
  sources: DeviceLeaseActivitySources,
  pool: ReturnType<DaemonStateAccess["getDevicePool"]>,
): DeviceLeaseActivitySources {
  return {
    ...sources,
    activeExecutionCount: (id) =>
      sources.activeExecutionCount(id) + (pool.isUnderShutdownReservation?.(id) ? 1 : 0),
  };
}

/**
 * Report whether this daemon still uses a device, so another AutoMobile process
 * can decide whether to take over its CtrlProxy forwarding lease (#10497).
 */
async function handleDeviceLeaseStatus(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const parsed = z.object({ deviceId: z.string().min(1) }).safeParse(request.params);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid deviceLeaseStatus parameters: ${parsed.error.message}`,
    };
  }
  const { deviceId } = parsed.data;
  const sources = deviceLeaseActivitySourcesFor(state);
  return {
    success: true,
    result: {
      pid: process.pid,
      deviceId,
      ...readDeviceLeaseActivity(sources, deviceId),
    },
  };
}

/**
 * Give up this daemon's CtrlProxy forwarding lease on a device when it no longer
 * uses it, so another AutoMobile process can take it (#10497). The use check and
 * the release start in one synchronous step, so a tool call or CtrlProxy request
 * this daemon begins afterwards cannot lose the lease to the requester; it builds
 * a fresh client that competes for the lease again (#10506 review).
 */
async function handleRelinquishDeviceLease(
  request: DaemonRequest,
  state: DaemonStateAccess,
  { context }: InitializedDaemonMethodOptions,
): Promise<DaemonMethodResult> {
  const parsed = z.object({ deviceId: z.string().min(1) }).safeParse(request.params);
  if (!parsed.success) {
    return {
      success: false,
      error: `Invalid relinquishDeviceLease parameters: ${parsed.error.message}`,
    };
  }
  const { deviceId } = parsed.data;
  const refusal = brokerConnectionLifecycleRefusal(
    state,
    context,
    DAEMON_RELINQUISH_DEVICE_LEASE_METHOD,
    { deviceId },
  );
  if (refusal) {
    return refusal;
  }
  const sources = deviceLeaseActivitySourcesFor(state);
  const port = state.getDeviceLeaseRelinquishPort?.() ?? daemonDeviceLeaseRelinquishPort();
  const status = { pid: process.pid, deviceId, ...readDeviceLeaseActivity(sources, deviceId) };
  const decision = decideOwnerRelinquish(status, port.idleMs);
  if (!decision.release) {
    return {
      success: true,
      result: {
        ...status,
        released: false,
        reason: decision.reason,
        ...(decision.transient ? { transient: true } : {}),
      },
    };
  }
  // No await between the use check above and this call: release evicts the
  // device's client synchronously before its first await.
  await port.release(deviceId);
  return { success: true, result: { ...status, released: true, reason: decision.reason } };
}

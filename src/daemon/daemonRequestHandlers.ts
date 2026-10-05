import { isSessionReleasing } from "./sessionReleaseState";
import { releaseSessionAndDevice } from "./releaseSessionAndDevice";
import type { DeviceHealthMarker } from "./deviceHealthMarkers";
import { z } from "zod";
import {
  MAX_OBSERVER_CLIENT_NAME_LENGTH,
  MAX_OBSERVER_SESSION_ID_LENGTH,
  type ObserverSessionStore,
} from "./observerSessionRegistry";
import {
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_SESSION_NOT_FOUND_CODE,
  DaemonRequest,
} from "./types";
import { DeviceLabelMap, Session, type SessionReleaseSnapshot } from "./sessionManager";
import type { DeviceRecoveryEligibility, DeviceRecoveryPolicy, PooledDevice } from "./devicePool";
import type { DeviceSessionRecord, RetiredDeviceSession } from "./deviceSessionRegistry";
import type { BootedDevice } from "../models";
import {
  CLI_SESSION_LIVENESS_POLICY,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_REGISTER_SESSION_METHOD,
  DAEMON_LIST_DEVICE_SESSIONS_METHOD,
  SESSION_RELEASE_DRAIN_TIMEOUT_MS,
} from "./constants";
import { executionTracker } from "../server/executionTracker";

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

export interface DaemonStateAccess {
  isInitialized(): boolean;
  getObserverSessionRegistry?(): ObserverSessionStore | undefined;
  getSessionManager(): {
    hasSession(sessionId: string): boolean;
    getSession(sessionId: string): Session | null;
    getReleasingSession?(sessionId: string): Session | null;
    waitForSessionReleaseWithin?(sessionId: string, timeoutMs: number): Promise<boolean>;
    getAllSessions?(): Session[];
    getTerminalReleaseSnapshot?(sessionId: string): SessionReleaseSnapshot | undefined;
    recordHeartbeat?(sessionId: string): void;
    /** Claim the token permitted to refresh this session's liveness. */
    claimLivenessOwnership?(sessionId: string, ownerToken: string): Promise<boolean>;
    /** Verify that a keeper still owns the token permitted to refresh liveness. */
    hasLivenessOwnership?(sessionId: string, ownerToken: string): boolean;
    /** Recover daemon-local ownership only when no token is currently recorded. */
    claimUnownedLivenessOwnership?(sessionId: string, ownerToken: string): boolean;
    /** Opt a one-shot `--cli`-owned session out of the heartbeat contract (#6870). */
    adoptCliLivenessPolicy?(sessionId: string, idleTimeoutMs?: number): boolean;
    /** Put a CLI-adopted session back on the strict heartbeat contract (#6870). */
    restoreHeartbeatLivenessPolicy?(sessionId: string): boolean;
    getSessionForDevice?(deviceId: string): string | null;
    getDeviceLabels(sessionId: string): DeviceLabelMap | undefined;
    releaseSession(sessionId: string): Promise<string | null>;
  };
  getDevicePool(): {
    isShutdownReserved?(deviceId: string): Promise<boolean>;
    restoreAutolockSessionsForMcpSession?(
      sessionIds: readonly string[],
      mcpSessionId: string,
    ): Promise<void>;
    restoreOwnedDeviceSessionsForMcpSession?(
      sessionIds: readonly string[],
      mcpSessionId: string,
    ): Promise<void>;
    releaseMcpSessionBindings?(mcpSessionId: string): void;
    refreshDevices(): Promise<number>;
    refreshDevicesWithOutcome?(): Promise<import("./devicePoolRefresh").DevicePoolRefreshResult>;
    getStats(): DevicePoolStats;
    releaseDevice(deviceId: string, expectedSessionId: string): Promise<void>;
    getAllDevices?(): PooledDevice[];
    isPooledIdentityUnresolved?(deviceId: string): boolean;
    getRecoveryPolicy?(): DeviceRecoveryPolicy;
    getDeviceHealthMarker?(deviceId: string): DeviceHealthMarker | undefined;
    getRecoveryEligibility?(deviceId: string): DeviceRecoveryEligibility;
    assertSessionReadyForAutomation?(sessionId: string): void;
    /**
     * FUNNEL 2 — the device-addressed admission gate. Optional only so the
     * daemon-state fakes in older suites keep compiling; the real pool always
     * has it ([#6863](https://github.com/kaeawc/auto-mobile/pull/6863) review).
     */
    assertDeviceActionable?(deviceId: string, purpose: string): void;
    /** FUNNEL 1 — fold a discovery observation into pooled identity. */
    reconcileDiscoveryObservation?(devices: readonly BootedDevice[], source: string): Promise<void>;
    resolveAutolockSessionForMcpSession?(
      mcpSessionId: string | undefined,
      platform?: "android" | "ios",
    ): string | undefined;
  };
  getDeviceSessionRegistry(): {
    list(): DeviceSessionRecord[];
    getRetiredByUuid?(uuid: string): RetiredDeviceSession | undefined;
  };
}

export type DevicePoolStats = {
  total: number;
  idle: number;
  assigned: number;
  error: number;
  avgAssignments?: number;
};

export type DaemonMethodResult = {
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  code?: typeof DAEMON_SESSION_NOT_FOUND_CODE | typeof DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE;
};

/** Device-session listing entry; a quarantined UUID cannot be subscribed to until identity resolves. */
export interface ListedDeviceSessionRecord extends DeviceSessionRecord {
  identityUnresolved?: true;
  unhealthy?: DeviceHealthMarker;
}

const registerSessionParams = z.object({
  sessionId: z.string().max(MAX_OBSERVER_SESSION_ID_LENGTH).uuid(),
  clientName: z.string().max(MAX_OBSERVER_CLIENT_NAME_LENGTH).trim().min(1),
});

async function handleRegisterSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const params: unknown = request.params;
  const parsed = registerSessionParams.safeParse(params);
  if (!parsed.success) {
    return { success: false, error: `Invalid registerSession parameters: ${parsed.error.message}` };
  }
  const { sessionId, clientName } = parsed.data;
  const manager = state.getSessionManager();
  if (
    (await manager.waitForSessionReleaseWithin?.(sessionId, SESSION_RELEASE_DRAIN_TIMEOUT_MS)) ===
    false
  ) {
    return {
      success: false,
      error: `Session ${sessionId} release is still in progress after ${SESSION_RELEASE_DRAIN_TIMEOUT_MS}ms; retry registration`,
    };
  }
  const session = manager.getSession(sessionId);
  if (session) {
    return {
      success: true,
      result: {
        accepted: true,
        heartbeatTimeoutMs: session.heartbeatTimeoutMs,
        expiresAtMs: session.lastHeartbeat + session.heartbeatTimeoutMs,
      },
    };
  }
  const registry = state.getObserverSessionRegistry?.();
  if (!registry) {
    return { success: false, error: "Observer session registration is unavailable" };
  }
  const registration = registry.register(sessionId, clientName);
  return registration.accepted
    ? { success: true, result: { ...registration } }
    : { success: false, error: registration.error };
}

export async function handleDaemonRequest(
  request: DaemonRequest,
  state: DaemonStateAccess,
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

  switch (request.method) {
    case DAEMON_REGISTER_SESSION_METHOD:
      return handleRegisterSession(request, state);
    case DAEMON_HEARTBEAT_METHOD:
      return handleHeartbeat(request, state);
    case "daemon/refreshDevices":
      return handleRefreshDevices(request, state);
    case "daemon/availableDevices":
      return handleAvailableDevices(request, state);
    case "daemon/sessionInfo":
      return handleSessionInfo(request, state);
    case "daemon/activeSessions":
      return handleActiveSessions(request, state);
    case "daemon/releaseSession":
      return handleReleaseSession(request, state);
    case DAEMON_LIST_DEVICE_SESSIONS_METHOD:
      return handleListDeviceSessions(request, state);
    default:
      return {
        success: false,
        error: `Unsupported daemon method: ${request.method}`,
      };
  }
}

async function handleHeartbeat(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const heartbeatParams = request.params as
    | {
        sessionId?: string;
        livenessPolicy?: string;
        idleTimeoutMs?: number;
        livenessOwnerToken?: string;
        claimLivenessOwnership?: boolean;
      }
    | undefined;
  const sessionId = heartbeatParams?.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error: "sessionId parameter required",
    };
  }
  const manager = state.getSessionManager();
  const session = manager.getSession(sessionId);
  if (!session || isSessionReleasing(manager, sessionId, session)) {
    if (
      typeof sessionId === "string" &&
      state.getObserverSessionRegistry?.()?.heartbeat(sessionId)
    ) {
      return { success: true, result: { sessionId } };
    }
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
      code: DAEMON_SESSION_NOT_FOUND_CODE,
    };
  }
  const livenessOwnerToken =
    typeof heartbeatParams?.livenessOwnerToken === "string" &&
    heartbeatParams.livenessOwnerToken.length > 0
      ? heartbeatParams.livenessOwnerToken
      : undefined;
  const claimsLivenessOwnership = heartbeatParams?.claimLivenessOwnership === true;
  if (!livenessOwnerToken && session.livenessOwnerToken !== undefined) {
    // Tokenless clients predate liveness ownership. Keep them compatible
    // only until a token-bearing owner has claimed this session; afterward
    // they are stale by definition and must not change policy or deadlines.
    return { success: true, result: { sessionId } };
  }
  if (livenessOwnerToken) {
    const ownsLiveness = claimsLivenessOwnership
      ? ((await manager.claimLivenessOwnership?.(sessionId, livenessOwnerToken)) ?? false)
      : (manager.hasLivenessOwnership?.(sessionId, livenessOwnerToken) ?? false) ||
        (manager.claimUnownedLivenessOwnership?.(sessionId, livenessOwnerToken) ?? false);
    // A claim can yield while release ends admission or replaces this UUID.
    // Keep the request bound to the device session admitted above.
    const currentSession = manager.getSession(sessionId);
    if (
      !currentSession ||
      currentSession !== session ||
      isSessionReleasing(manager, sessionId, currentSession)
    ) {
      return {
        success: false,
        error: `Session not found: ${sessionId}`,
        code: DAEMON_SESSION_NOT_FOUND_CODE,
      };
    }
    if (!ownsLiveness) {
      // A stale reconnect must be a complete liveness no-op: it cannot
      // restore a policy or extend lastUsedAt/lastHeartbeat/expiresAt.
      return claimsLivenessOwnership
        ? { success: true, result: { sessionId } }
        : {
            success: false,
            code: DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
            error: `The token no longer owns session ${sessionId}'s liveness. Re-claim with a fresh token and --claim-liveness-ownership, or stop the keeper.`,
          };
    }
    if (!claimsLivenessOwnership) {
      // A verified keeper proves only that its current owner is still
      // alive. Policy changes are explicit claims, never recurring ticks.
      manager.recordHeartbeat?.(sessionId);
      return { success: true, result: { sessionId } };
    }
  }
  // A one-shot `--cli` client declares itself here (issue #6870) so the
  // daemon stops holding its session to the 10 s heartbeat contract no
  // one-shot process can keep. An unmarked Desktop heartbeat restores that
  // strict contract when a prior CLI invocation widened the same session.
  if (heartbeatParams?.livenessPolicy === CLI_SESSION_LIVENESS_POLICY) {
    // The invocation carries its own resolved idle timeout: it reuses a
    // running daemon, whose process env was read at startup and cannot
    // reflect this invocation's override (issue #6870 review). The manager
    // re-validates and bounds it.
    manager.adoptCliLivenessPolicy?.(sessionId, heartbeatParams.idleTimeoutMs);
    return {
      success: true,
      result: {
        sessionId,
        livenessPolicy: "cli-idle",
        idleTimeoutMs: manager.getSession(sessionId)?.heartbeatTimeoutMs,
      },
    };
  }
  if (
    heartbeatParams?.livenessPolicy === HEARTBEAT_SESSION_LIVENESS_POLICY ||
    heartbeatParams?.livenessPolicy === undefined
  ) {
    // A long-lived stdio/HTTP proxy CAN keep the strict contract and says so
    // on every heartbeat, so a session a previous `--cli` invocation moved
    // onto the minutes-long idle window goes back to it (issue #6870
    // review) instead of holding its device for that window after this
    // client disconnects.
    // `restoreHeartbeatLivenessPolicy` records the heartbeat itself as part
    // of re-stamping the deadlines off the restored timeouts.
    if (manager.restoreHeartbeatLivenessPolicy?.(sessionId)) {
      return {
        success: true,
        result: { sessionId, livenessPolicy: HEARTBEAT_SESSION_LIVENESS_POLICY },
      };
    }
  }
  manager.recordHeartbeat?.(sessionId);
  return { success: true, result: { sessionId } };
}

async function handleRefreshDevices(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
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
  const stats = pool.getStats();
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
  const stats = pool.getStats();
  const recoveryPolicy = pool.getRecoveryPolicy?.();
  const devices = pool.getAllDevices?.().map((device) => ({
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

async function handleSessionInfo(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error: "sessionId parameter required",
    };
  }
  const manager = state.getSessionManager();
  const session = manager.getSession(sessionId);
  if (!session) {
    return {
      success: false,
      error: `Session not found: ${sessionId}`,
      code: DAEMON_SESSION_NOT_FOUND_CODE,
    };
  }
  return {
    success: true,
    result: {
      sessionId: session.sessionId,
      assignedDevice: session.assignedDevice,
      platform: session.platform,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      cacheSize: JSON.stringify(session.cacheData).length,
      ...(isSessionReleasing(manager, sessionId, session) ? { releasing: true } : {}),
    },
  };
}

async function handleActiveSessions(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const manager = state.getSessionManager();
  const sessions = manager.getAllSessions?.() ?? [];
  const releasingSessions = sessions.filter((session) =>
    isSessionReleasing(manager, session.sessionId, session),
  ).length;
  return {
    success: true,
    result: {
      activeSessions: sessions.length,
      activeExecutions: executionTracker.getActiveExecutionCount(),
      ...(releasingSessions > 0 ? { releasingSessions } : {}),
    },
  };
}

async function handleReleaseSession(
  request: DaemonRequest,
  state: DaemonStateAccess,
): Promise<DaemonMethodResult> {
  const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
  if (!sessionId) {
    return {
      success: false,
      error: "sessionId parameter required",
    };
  }
  const manager = state.getSessionManager();
  const session = manager.getSession(sessionId) ?? manager.getReleasingSession?.(sessionId);
  if (!session && !manager.hasSession(sessionId)) {
    if (typeof sessionId === "string" && state.getObserverSessionRegistry?.()?.release(sessionId)) {
      return {
        success: true,
        result: {
          message: `Session ${sessionId} released`,
          alreadyReleased: false,
        },
      };
    }
    // Session doesn't exist - treat as already released (idempotent)
    // This happens when daemon auto-releases after executePlan completes
    return {
      success: true,
      result: {
        message: `Session ${sessionId} already released or never existed`,
        alreadyReleased: true,
      },
    };
  }
  return releaseBoundSession(state, manager, sessionId, session);
}

async function releaseBoundSession(
  state: DaemonStateAccess,
  manager: ReturnType<DaemonStateAccess["getSessionManager"]>,
  sessionId: string,
  session: Session | null | undefined,
): Promise<DaemonMethodResult> {
  const pool = state.getDevicePool();
  // A failed terminal write hides routing identity while retaining ownership.
  let deviceId =
    session?.assignedDevice ?? manager.getTerminalReleaseSnapshot?.(sessionId)?.deviceId ?? null;
  await releaseSessionAndDevice(manager, pool, deviceId, sessionId, undefined, {
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

import { DaemonRequest } from "./types";
import { DeviceLabelMap, Session, type SessionReleaseSnapshot } from "./sessionManager";
import type { DeviceRecoveryEligibility, DeviceRecoveryPolicy, PooledDevice } from "./devicePool";
import type { DeviceSessionRecord } from "./deviceSessionRegistry";
import type { BootedDevice } from "../models";
import {
  CLI_SESSION_LIVENESS_POLICY,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_LIST_DEVICE_SESSIONS_METHOD,
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
  getSessionManager(): {
    getSession(sessionId: string): Session | null;
    getAllSessions?(): Session[];
    getTerminalReleaseSnapshot?(sessionId: string): SessionReleaseSnapshot | undefined;
    recordHeartbeat?(sessionId: string): void;
    /** Claim the token permitted to refresh this session's liveness. */
    claimLivenessOwnership?(sessionId: string, ownerToken: string): boolean;
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
    restoreAutolockSessionsForMcpSession?(
      sessionIds: readonly string[],
      mcpSessionId: string,
    ): Promise<void>;
    refreshDevices(): Promise<number>;
    getStats(): DevicePoolStats;
    releaseDevice(deviceId: string, expectedSessionId: string): Promise<void>;
    getAllDevices?(): PooledDevice[];
    getRecoveryPolicy?(): DeviceRecoveryPolicy;
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
};

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
        capabilities: [INPUT_TYPE_TEXT_APPEND_CAPABILITY, INPUT_GESTURE_STREAM_CAPABILITY],
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
    case DAEMON_HEARTBEAT_METHOD: {
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
      if (!manager.getSession(sessionId)) {
        return {
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }
      const livenessOwnerToken =
        typeof heartbeatParams?.livenessOwnerToken === "string" &&
        heartbeatParams.livenessOwnerToken.length > 0
          ? heartbeatParams.livenessOwnerToken
          : undefined;
      const claimsLivenessOwnership = heartbeatParams?.claimLivenessOwnership === true;
      if (livenessOwnerToken) {
        const ownsLiveness = claimsLivenessOwnership
          ? (manager.claimLivenessOwnership?.(sessionId, livenessOwnerToken) ?? false)
          : (manager.hasLivenessOwnership?.(sessionId, livenessOwnerToken) ?? false) ||
            (manager.claimUnownedLivenessOwnership?.(sessionId, livenessOwnerToken) ?? false);
        if (!ownsLiveness) {
          // A stale reconnect must be a complete liveness no-op: it cannot
          // restore a policy or extend lastUsedAt/lastHeartbeat/expiresAt.
          return { success: true, result: { sessionId } };
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
    case "daemon/refreshDevices": {
      const pool = state.getDevicePool();
      const addedCount = await pool.refreshDevices();
      const stats = pool.getStats();
      return {
        success: true,
        result: {
          addedDevices: addedCount,
          totalDevices: stats.total,
          availableDevices: stats.idle,
          stats,
        },
      };
    }
    case "daemon/availableDevices": {
      const pool = state.getDevicePool();
      const stats = pool.getStats();
      const recoveryPolicy = pool.getRecoveryPolicy?.();
      const devices = pool.getAllDevices?.().map((device) => ({
        deviceId: device.id,
        platform: device.platform,
        recoveryEligibility: pool.getRecoveryEligibility?.(device.id),
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
    case "daemon/sessionInfo": {
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
        },
      };
    }
    case "daemon/activeSessions": {
      const sessions = state.getSessionManager().getAllSessions?.() ?? [];
      return {
        success: true,
        result: {
          activeSessions: sessions.length,
          activeExecutions: executionTracker.getActiveExecutionCount(),
        },
      };
    }
    case "daemon/releaseSession": {
      const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) {
        return {
          success: false,
          error: "sessionId parameter required",
        };
      }
      const manager = state.getSessionManager();
      const pool = state.getDevicePool();
      const session = manager.getSession(sessionId);
      if (!session) {
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
      const deviceId = session.assignedDevice;
      await manager.releaseSession(sessionId);
      await pool.releaseDevice(deviceId, sessionId);
      return {
        success: true,
        result: {
          message: `Session ${sessionId} released`,
          device: deviceId,
          alreadyReleased: false,
        },
      };
    }
    case DAEMON_LIST_DEVICE_SESSIONS_METHOD: {
      const registry = state.getDeviceSessionRegistry();
      const deviceSessions = registry.list().map((record) => ({
        deviceSessionUuid: record.deviceSessionUuid,
        deviceId: record.deviceId,
        platform: record.platform,
        epochStartedAt: record.epochStartedAt,
      }));
      return {
        success: true,
        result: {
          deviceSessions,
          totalDeviceSessions: deviceSessions.length,
        },
      };
    }
    default:
      return {
        success: false,
        error: `Unsupported daemon method: ${request.method}`,
      };
  }
}

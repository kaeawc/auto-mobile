import { DaemonRequest } from "./types";
import { DeviceLabelMap, Session } from "./sessionManager";
import type {
  DeviceRecoveryEligibility,
  DeviceRecoveryPolicy,
  PooledDevice,
} from "./devicePool";
import type { DeviceSessionRecord } from "./deviceSessionRegistry";
import { DAEMON_LIST_DEVICE_SESSIONS_METHOD } from "./constants";

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
    recordHeartbeat?(sessionId: string): void;
    getSessionForDevice?(deviceId: string): string | null;
    getDeviceLabels(sessionId: string): DeviceLabelMap | undefined;
    releaseSession(sessionId: string): Promise<string | null>;
  };
  getDevicePool(): {
    refreshDevices(): Promise<number>;
    getStats(): DevicePoolStats;
    releaseDevice(deviceId: string, expectedSessionId: string): Promise<void>;
    getAllDevices?(): PooledDevice[];
    getRecoveryPolicy?(): DeviceRecoveryPolicy;
    getRecoveryEligibility?(deviceId: string): DeviceRecoveryEligibility;
    assertSessionReadyForAutomation?(sessionId: string): void;
    resolveAutolockSessionForMcpSession?(
      mcpSessionId: string | undefined,
      platform?: "android" | "ios"
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
  state: DaemonStateAccess
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
    case "daemon/heartbeat": {
      const sessionId = (request.params as { sessionId?: string } | undefined)?.sessionId;
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
      const devices = pool.getAllDevices?.().map(device => ({
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
      const deviceSessions = registry.list().map(record => ({
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

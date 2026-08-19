import { logger } from "../utils/logger";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { PushSubscriptionSocketServer, getSocketPath } from "./socketServer/index";
import { PERFORMANCE_PUSH_SOCKET_CONFIG } from "./daemonFiles";
import { type DeviceSessionResolver, nullDeviceSessionResolver } from "./deviceSessionResolver";

/**
 * Performance thresholds for health status calculation
 */
export interface PerformanceThresholds {
  fpsWarning: number;
  fpsCritical: number;
  frameTimeWarning: number;
  frameTimeCritical: number;
  jankWarning: number;
  jankCritical: number;
  touchLatencyWarning: number;
  touchLatencyCritical: number;
  ttffWarning: number;
  ttffCritical: number;
  ttiWarning: number;
  ttiCritical: number;
}

/**
 * Default thresholds
 */
export const DEFAULT_THRESHOLDS: PerformanceThresholds = {
  fpsWarning: 55,
  fpsCritical: 45,
  frameTimeWarning: 18, // 16.67ms is 60fps, 18ms allows some margin
  frameTimeCritical: 33, // 33ms is 30fps
  jankWarning: 5,
  jankCritical: 10,
  touchLatencyWarning: 100,
  touchLatencyCritical: 200,
  ttffWarning: 500,
  ttffCritical: 1000,
  ttiWarning: 700,
  ttiCritical: 1500,
};

/**
 * Health status
 */
export type HealthStatus = "healthy" | "warning" | "critical";

/**
 * Live performance data pushed to clients
 */
export interface LivePerformanceData {
  deviceId: string;
  /**
   * Stable device-session routing key for this device's current epoch (epic #5256,
   * item 3). Resolved by the push server from `deviceId`; `null` when no live epoch
   * maps to the serial. Callers may leave it `null` — the server (re)resolves it.
   */
  deviceSessionUuid: string | null;
  packageName: string;
  timestamp: number;
  nodeId: number | null;
  screenName: string | null;
  metrics: {
    fps: number | null;
    frameTimeMs: number | null;
    jankFrames: number | null;
    touchLatencyMs: number | null;
    ttffMs: number | null;
    ttiMs: number | null;
    cpuUsagePercent: number | null;
    memoryUsageMb: number | null;
  };
  thresholds: PerformanceThresholds;
  health: HealthStatus;
}

/**
 * Filter for performance push subscriptions.
 */
interface PerformanceFilter {
  deviceSessionUuid: string | null;
  packageName: string | null;
}

/**
 * Push message format.
 */
interface PerformancePushMessage {
  type: "performance_push";
  timestamp: number;
  data: LivePerformanceData;
  subscriptionId: string;
}

/**
 * Socket server that pushes live performance data to connected IDE plugins.
 *
 * Protocol:
 * - Client sends: {"id": "1", "command": "subscribe", "deviceId": "emulator-5554", "packageName": "com.example.app"}
 * - Server responds: {"id": "1", "type": "subscription_response", "success": true, "subscriptionId": "performancepush-1"}
 * - Server pushes: {"type": "performance_push", "subscriptionId": "performancepush-1", "data": {...}}
 * - Server sends ping every 10s: {"type": "ping", "timestamp": 123}
 * - Client responds: {"id": "x", "command": "pong"}
 */
export class PerformancePushSocketServer extends PushSubscriptionSocketServer<
  PerformanceFilter,
  LivePerformanceData
> {
  private deviceSessionResolver: DeviceSessionResolver = nullDeviceSessionResolver;

  constructor(
    socketPath: string = getSocketPath(PERFORMANCE_PUSH_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
  ) {
    super(socketPath, timer, "PerformancePush");
  }

  /** Wire the serial↔`deviceSessionUuid` resolver used to stamp pushed frames. */
  setDeviceSessionResolver(resolver: DeviceSessionResolver): void {
    this.deviceSessionResolver = resolver;
  }

  /**
   * Push live performance data to all interested subscribers. `deviceSessionUuid`
   * is (re)resolved here from `deviceId` so the routing key reflects the device's
   * current epoch regardless of what the caller supplied.
   */
  pushPerformanceData(data: LivePerformanceData): void {
    const deviceSessionUuid = data.deviceId
      ? this.deviceSessionResolver.resolveUuid(data.deviceId)
      : null;
    const sentCount = this.pushToSubscribers({ ...data, deviceSessionUuid });
    if (sentCount > 0) {
      logger.debug(`[PerformancePush] Pushed data to ${sentCount} subscribers`);
    }
  }

  /**
   * Calculate health status from metrics
   */
  static calculateHealth(
    metrics: LivePerformanceData["metrics"],
    thresholds: PerformanceThresholds,
  ): HealthStatus {
    // Check FPS (lower is worse)
    if (metrics.fps !== null) {
      if (metrics.fps < thresholds.fpsCritical) {
        return "critical";
      }
      if (metrics.fps < thresholds.fpsWarning) {
        return "warning";
      }
    }

    // Check frame time (higher is worse)
    if (metrics.frameTimeMs !== null) {
      if (metrics.frameTimeMs > thresholds.frameTimeCritical) {
        return "critical";
      }
      if (metrics.frameTimeMs > thresholds.frameTimeWarning) {
        return "warning";
      }
    }

    // Check jank frames (higher is worse)
    if (metrics.jankFrames !== null) {
      if (metrics.jankFrames > thresholds.jankCritical) {
        return "critical";
      }
      if (metrics.jankFrames > thresholds.jankWarning) {
        return "warning";
      }
    }

    // Check touch latency (higher is worse)
    if (metrics.touchLatencyMs !== null) {
      if (metrics.touchLatencyMs > thresholds.touchLatencyCritical) {
        return "critical";
      }
      if (metrics.touchLatencyMs > thresholds.touchLatencyWarning) {
        return "warning";
      }
    }

    // Check TTFF (higher is worse)
    if (metrics.ttffMs !== null) {
      if (metrics.ttffMs > thresholds.ttffCritical) {
        return "critical";
      }
      if (metrics.ttffMs > thresholds.ttffWarning) {
        return "warning";
      }
    }

    // Check TTI (higher is worse)
    if (metrics.ttiMs !== null) {
      if (metrics.ttiMs > thresholds.ttiCritical) {
        return "critical";
      }
      if (metrics.ttiMs > thresholds.ttiWarning) {
        return "warning";
      }
    }

    return "healthy";
  }

  protected parseSubscriptionFilter(request: Record<string, unknown>): PerformanceFilter {
    return {
      deviceSessionUuid: (request.deviceSessionUuid as string) ?? null,
      packageName: (request.packageName as string) ?? null,
    };
  }

  protected matchesFilter(filter: PerformanceFilter, data: LivePerformanceData): boolean {
    const matchesDevice =
      filter.deviceSessionUuid === null || filter.deviceSessionUuid === data.deviceSessionUuid;
    const matchesPackage = filter.packageName === null || filter.packageName === data.packageName;
    return matchesDevice && matchesPackage;
  }

  protected createPushMessage(
    data: LivePerformanceData,
    subscriptionId: string,
  ): PerformancePushMessage {
    return {
      type: "performance_push",
      timestamp: this.timer.now(),
      data,
      subscriptionId,
    };
  }
}

// Singleton instance
let socketServer: PerformancePushSocketServer | null = null;

export function getPerformancePushServer(): PerformancePushSocketServer | null {
  return socketServer;
}

export function getPerformancePushSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(PERFORMANCE_PUSH_SOCKET_CONFIG);
}

export async function startPerformancePushSocketServer(): Promise<PerformancePushSocketServer> {
  if (!socketServer) {
    socketServer = new PerformancePushSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
  return socketServer;
}

export async function stopPerformancePushSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}

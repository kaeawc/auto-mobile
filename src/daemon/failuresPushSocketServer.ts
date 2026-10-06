import {
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import { logger } from "../utils/logger";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import {
  PushSubscriptionSocketServer,
  getSocketPath,
  matchesDeviceRouting,
} from "./socketServer/index";
import type { FailureType, FailureSeverity } from "../server/failuresResources";
import { FAILURES_PUSH_SOCKET_CONFIG } from "./daemonFiles";
import {
  type DeviceSessionResolver,
  nullDeviceSessionResolver,
  SuspendedDeviceRoutingLog,
} from "./deviceSessionResolver";

/**
 * Failure notification data pushed to clients.
 *
 * `deviceId` and `deviceSessionUuid` are the device attribution added in epic
 * #5256, item 3 — failures previously carried no device dimension at all. The
 * caller supplies `deviceId` (the originating serial/UDID, or `null` for a
 * genuinely device-less failure); the server resolves `deviceSessionUuid` from it
 * at push time so subscribers can filter on the stable epoch key.
 */
export interface FailureNotificationPush {
  occurrenceId: string;
  groupId: string;
  type: FailureType;
  severity: FailureSeverity;
  title: string;
  message: string;
  timestamp: number;
  deviceId: string | null;
  deviceSessionUuid: string | null;
}

/**
 * Filter for failure push subscriptions. `deviceSessionUuid` is the primary
 * device routing key (epic #5256); `null` matches every device.
 */
interface FailureFilter {
  type: FailureType | null;
  severity: FailureSeverity | null;
  deviceSessionUuid: string | null;
  /** Serial named by a `deviceId`-only subscription; the live key when no uuid is given (#10143). */
  deviceId?: string | null;
}

/**
 * Push message format.
 */
interface FailurePushMessage {
  type: "failure_push";
  timestamp: number;
  data: FailureNotificationPush;
  subscriptionId: string;
}

/**
 * Socket server that pushes live failure notifications to connected IDE plugins.
 *
 * Protocol:
 * - Client sends: {"id": "1", "command": "subscribe", "type": "crash", "severity": "high"}
 * - Server responds: {"id": "1", "type": "subscription_response", "success": true, "subscriptionId": "failurespush-1"}
 * - Server pushes: {"type": "failure_push", "subscriptionId": "failurespush-1", "timestamp": 123, "data": {...}}
 * - Server sends ping every 10s: {"type": "ping", "timestamp": 123}
 * - Client responds: {"id": "x", "command": "pong"}
 */
export class FailuresPushSocketServer extends PushSubscriptionSocketServer<
  FailureFilter,
  FailureNotificationPush
> {
  protected override deviceSessionResolver: DeviceSessionResolver = nullDeviceSessionResolver;
  private readonly suspendedRoutingLog = new SuspendedDeviceRoutingLog();

  constructor(
    socketPath: string = getSocketPath(FAILURES_PUSH_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    options: { authenticator?: StreamSocketAuthenticator } = {},
  ) {
    super(socketPath, timer, "FailuresPush");
    this.authenticator =
      options.authenticator ??
      createDefaultStreamSocketAuthenticator("failuresPush", { allowObserverSessions: true });
  }

  private readonly authenticator: StreamSocketAuthenticator;

  protected override authorizeSubscription(request: Record<string, unknown>): void {
    this.authenticator.authorize({
      sessionUuid: typeof request.sessionUuid === "string" ? request.sessionUuid : undefined,
    });
  }

  /** Wire the serial↔`deviceSessionUuid` resolver used to stamp pushed frames. */
  setDeviceSessionResolver(resolver: DeviceSessionResolver): void {
    this.deviceSessionResolver = resolver;
  }

  /**
   * Push a failure notification to all interested subscribers. The caller sets
   * `deviceId`; `deviceSessionUuid` is (re)resolved here from the live registry so
   * the routing key reflects the device's current epoch.
   */
  pushFailure(data: FailureNotificationPush): void {
    if (
      data.deviceId &&
      this.suspendedRoutingLog.shouldDropFrame(
        this.deviceSessionResolver,
        data.deviceId,
        "FailuresPush",
      )
    ) {
      // Quarantined pooled identity: see pushTelemetryEvent (#6863 review).
      return;
    }
    const deviceSessionUuid = data.deviceId
      ? this.deviceSessionResolver.resolveUuid(data.deviceId)
      : null;
    const enriched: FailureNotificationPush = { ...data, deviceSessionUuid };
    logger.info(
      `[FailuresPush] Pushing failure: ${enriched.type} - ${enriched.title} (subscribers: ${this.getSubscriberCount()})`,
    );
    const sentCount = this.pushToSubscribers(enriched);
    logger.info(`[FailuresPush] Pushed failure to ${sentCount} subscribers: ${enriched.title}`);
  }

  protected parseSubscriptionFilter(request: Record<string, unknown>): FailureFilter {
    // Validated, not cast: a blank/non-string key would otherwise become a filter that
    // matches nothing while the subscribe call still acks success (#6676).
    const { deviceSessionUuid, deviceId } = this.parseDeviceFilterKeys(request);
    return {
      type: (request.type as FailureType) ?? null,
      severity: (request.severity as FailureSeverity) ?? null,
      deviceSessionUuid,
      deviceId,
    };
  }

  protected override describeEffectiveFilter(filter: FailureFilter): Record<string, unknown> {
    return {
      type: filter.type,
      severity: filter.severity,
      deviceSessionUuid: filter.deviceSessionUuid,
      deviceId: filter.deviceId ?? null,
    };
  }

  protected matchesFilter(filter: FailureFilter, data: FailureNotificationPush): boolean {
    const matchesType = filter.type === null || filter.type === data.type;
    const matchesSeverity = filter.severity === null || filter.severity === data.severity;
    return matchesType && matchesSeverity && matchesDeviceRouting(filter, data);
  }

  protected createPushMessage(
    data: FailureNotificationPush,
    subscriptionId: string,
  ): FailurePushMessage {
    return {
      type: "failure_push",
      timestamp: this.timer.now(),
      data,
      subscriptionId,
    };
  }
}

// Singleton instance
let socketServer: FailuresPushSocketServer | null = null;

export function getFailuresPushServer(): FailuresPushSocketServer | null {
  return socketServer;
}

export function getFailuresPushSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(FAILURES_PUSH_SOCKET_CONFIG);
}

export async function startFailuresPushSocketServer(): Promise<FailuresPushSocketServer> {
  if (!socketServer) {
    socketServer = new FailuresPushSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
  return socketServer;
}

export async function stopFailuresPushSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}

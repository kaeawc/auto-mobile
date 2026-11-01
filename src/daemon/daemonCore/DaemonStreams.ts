import { isAndroidOrIosPlatform } from "../../models/Platform";
import type { DaemonCoreServices, DaemonLifecycleState } from "./DaemonCoreState";
import { DefaultObservationInitialFrameCoordinator } from "../observationInitialFrameCoordinator";
import { logger } from "../../utils/logger";
import { IOSCtrlProxyManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import { getPerformancePushServer } from "../performancePushSocketServer";
import { getDeviceDataStreamServer } from "../deviceDataStreamSocketServer";
import { getFailuresPushServer } from "../failuresPushSocketServer";
import { getTelemetryPushServer } from "../telemetryPushSocketServer";
import { createRegistryDeviceSessionResolver } from "../deviceSessionResolver";
import { AndroidCtrlProxyClient } from "../../features/observe/android";
import {
  type StorageSubscriptionRequest,
  applyStorageSubscriptionRequest,
} from "../daemonStreamRouting";
import { configureObservationStreamCallbacks } from "../daemonObservationStreamCallbacks";
import { errorMessage } from "../../utils/describeUnknownError";

export type DeviceSessionRoutingTargets = {
  deviceDataStream: ReturnType<typeof getDeviceDataStreamServer>;
  performancePush: ReturnType<typeof getPerformancePushServer>;
  failuresPush: ReturnType<typeof getFailuresPushServer>;
  telemetryPush: ReturnType<typeof getTelemetryPushServer>;
};

export interface DaemonStreamsHost {
  services: Pick<
    DaemonCoreServices,
    "sessionManager" | "devicePool" | "deviceSessionRegistry" | "timer" | "passiveWorkPolicy"
  >;
  lifecycle: Pick<
    DaemonLifecycleState,
    | "socketServer"
    | "deviceDataStreamServer"
    | "setDeviceDataStreamServer"
    | "navigationGraphBridge"
  >;
  setupDeviceDataStreamCallback: DaemonStreams["setupDeviceDataStreamCallback"];
  getDeviceSessionRoutingTargets: DaemonStreams["getDeviceSessionRoutingTargets"];
  setupNavigationGraphStreamListener: DaemonStreams["setupNavigationGraphStreamListener"];
}

/** Wires device-session routing, observation delivery and navigation stream callbacks. */
export class DaemonStreams {
  private readonly initialFrameCoordinators = new WeakMap<
    NonNullable<ReturnType<typeof getDeviceDataStreamServer>>,
    DefaultObservationInitialFrameCoordinator
  >();
  constructor(private readonly host: DaemonStreamsHost) {}

  /**
   * Device-ready callback wired into {@link DevicePool}. Mints (or refreshes)
   * the device-session epoch for the connected device and preserves the
   * pre-existing input-cache eviction. The pool fires this on the refresh,
   * addDevice, and bind/autolock paths; startup-booted devices are minted
   * directly in {@link initializeDevicePool}. The mint is keyed on the pooled
   * device's monotonic `incarnation` — a repeat ready-signal for the same epoch
   * is idempotent, while a same-serial restart (new incarnation) mints a fresh
   * `deviceSessionUuid` (epic #5256).
   */
  onDeviceReadyForSessionRegistry(deviceId: string): void {
    this.host.lifecycle.socketServer()?.evictDeviceInputCache(deviceId);
    const pooled = this.host.services.devicePool().getDevice(deviceId);
    // The device-session wire is Android and iOS; watches get no epoch yet (#14908).
    if (!pooled || !isAndroidOrIosPlatform(pooled.platform)) {
      return;
    }
    if (pooled.platform === "ios") {
      const manager = IOSCtrlProxyManager.getExistingInstance(deviceId);
      void manager?.rearmAfterDeviceReappearance().catch((error) => {
        logger.warn(
          `[Daemon] Failed to rearm iOS CtrlProxy for ${deviceId}: ${errorMessage(error)}`,
        );
      });
    }
    if (pooled.platform === "android") {
      AndroidCtrlProxyClient.noteDeviceOnline(deviceId);
    }
    this.host.services.deviceSessionRegistry().onDeviceConnected({
      deviceId: pooled.id,
      platform: pooled.platform,
      incarnation: pooled.incarnation,
    });
  }

  /**
   * Set up callback for observation stream to trigger device WebSocket connections.
   * When an IDE plugin subscribes to the observation stream, we need to ensure
   * the WebSocket connections to Android devices are established so that
   * hierarchy updates can flow continuously.
   */
  /**
   * Give every push socket server the serial↔`deviceSessionUuid` resolver so it can
   * stamp the epoch key on outgoing frames and route subscriptions on it, and wire
   * the registry's connect/disconnect transitions to `device_session_started` /
   * `device_session_ended` frames on the observation stream (epic #5256, item 3).
   */
  getDeviceSessionRoutingTargets(): DeviceSessionRoutingTargets {
    return {
      deviceDataStream: getDeviceDataStreamServer(),
      performancePush: getPerformancePushServer(),
      failuresPush: getFailuresPushServer(),
      telemetryPush: getTelemetryPushServer(),
    };
  }

  configureDeviceDataStreamServer(): void {
    // The stream singleton can be replaced by health recovery. Route it before
    // registering request callbacks so every handler observes the current epoch.
    this.setupDeviceSessionRouting();
    this.host.setupDeviceDataStreamCallback();
  }

  setupDeviceSessionRouting(): void {
    // The pool's unresolved-identity quarantine is the second input: while it
    // holds for a serial, the registry record stays put but the resolver withholds
    // it in both directions and every push server drops that serial's frames, so a
    // possible replacement AVD's passive events cannot reach the previous AVD's
    // subscribers (#6863 review).
    const resolver = createRegistryDeviceSessionResolver(
      this.host.services.deviceSessionRegistry(),
      this.host.services.devicePool(),
    );
    const { deviceDataStream, performancePush, failuresPush, telemetryPush } =
      this.host.getDeviceSessionRoutingTargets();
    this.host.lifecycle.setDeviceDataStreamServer(deviceDataStream);
    deviceDataStream?.setDeviceSessionResolver(resolver);
    performancePush?.setDeviceSessionResolver(resolver);
    failuresPush?.setDeviceSessionResolver(resolver);
    telemetryPush?.setDeviceSessionResolver(resolver);

    if (deviceDataStream) {
      this.host.services.deviceSessionRegistry().setLifecycleListener({
        onSessionStarted: (record) => deviceDataStream.pushDeviceSessionStarted(record),
        onSessionEnded: (record, options) =>
          deviceDataStream.pushDeviceSessionEnded(record, options),
      });
    }
  }

  private getInitialFrameCoordinator(
    server: NonNullable<ReturnType<typeof getDeviceDataStreamServer>>,
  ) {
    let coordinator = this.initialFrameCoordinators.get(server);
    if (!coordinator) {
      coordinator = new DefaultObservationInitialFrameCoordinator(
        this.host.services.timer(),
        undefined,
        (id) => server.getLiveFrameGeneration(id),
        (id) => server.getDeviceSessionUuid(id),
      );
      this.initialFrameCoordinators.set(server, coordinator);
    }
    return coordinator;
  }

  setupDeviceDataStreamCallback(): void {
    const server = this.host.lifecycle.deviceDataStreamServer() ?? getDeviceDataStreamServer();
    if (!server) {
      logger.warn("[Daemon] Observation stream server not available for callback setup");
      return;
    }

    configureObservationStreamCallbacks(server, this.getInitialFrameCoordinator(server), {
      devicePool: () => this.host.services.devicePool(),
      passiveWorkPolicy: () => this.host.services.passiveWorkPolicy(),
      timer: () => this.host.services.timer(),
      sessionManager: () => this.host.services.sessionManager(),
      applyStorageSubscriptionRequest: (request) => this.applyStorageSubscriptionRequest(request),
    });
    logger.info("[Daemon] Observation stream callback configured");

    // Wire up navigation graph updates to stream to IDE plugins
    this.host.setupNavigationGraphStreamListener(server);
  }

  applyStorageSubscriptionRequest(request: StorageSubscriptionRequest): Promise<void> {
    return applyStorageSubscriptionRequest(
      { devicePool: this.host.services.devicePool() },
      request,
    );
  }

  setupNavigationGraphStreamListener(server: ReturnType<typeof getDeviceDataStreamServer>): void {
    this.host.lifecycle.navigationGraphBridge().listen(server);
  }

  get testHooks() {
    return {
      deviceDataStreamServer: (): ReturnType<typeof getDeviceDataStreamServer> =>
        this.host.lifecycle.deviceDataStreamServer(),
      setupDeviceSessionRouting: (): void => this.setupDeviceSessionRouting(),
      setupDeviceDataStreamCallback: (): void => this.host.setupDeviceDataStreamCallback(),
      setupNavigationGraphStreamListener: (
        server: ReturnType<typeof getDeviceDataStreamServer>,
      ): void => this.host.setupNavigationGraphStreamListener(server),
      applyStorageSubscriptionRequest: (request: StorageSubscriptionRequest): Promise<void> =>
        this.applyStorageSubscriptionRequest(request),
    } as const;
  }
}

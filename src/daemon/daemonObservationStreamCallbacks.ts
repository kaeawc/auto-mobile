import { isAndroidOrIosPlatform } from "../models/Platform";
import type { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { DevicePool, PooledDevice } from "./devicePool";
import type { PassiveWorkPolicy } from "./PassiveWorkPolicy";
import type { SessionManager } from "./sessionManager";
import { getDeviceDataStreamServer } from "./deviceDataStreamSocketServer";
import type { DefaultObservationInitialFrameCoordinator } from "./observationInitialFrameCoordinator";
import {
  pushInitialObservationFramesForSubscriber,
  selectObservationStreamDevices,
} from "./observationInitialFrame";
import {
  OBSERVATION_BATCH_HEADROOM_MS,
  PER_DEVICE_OBSERVATION_TIMEOUT_MS,
  createPooledObservationExecutor,
  runObservationRequestBatch,
} from "./observationRequestBatch";
import { createDefaultStreamSocketAuthenticator } from "./streamSocketAuth";
import {
  type StorageSubscriptionRequest,
  createObservationStreamIosClient,
  isHeldByAnotherOwner,
  logSkippedObservationStreamDevice,
} from "./daemonStreamRouting";

function toBootedDevice(pooledDevice: PooledDevice): BootedDevice {
  return {
    deviceId: pooledDevice.id,
    name: pooledDevice.name,
    platform: pooledDevice.platform,
    iosVersion: pooledDevice.iosVersion,
  };
}

/**
 * Per-device step of the pooled observation batch. An Android floor is read from the device's
 * own clock (host fallback inside the adb client, as the action paths do); iOS keeps the host
 * floor (issue #9895).
 */
function createDaemonObservationExecutor(
  requestStart: number,
  isViewerRead: (pooledDevice: PooledDevice) => boolean | Promise<boolean>,
) {
  return createPooledObservationExecutor({
    hostRequestStartMs: requestStart,
    readAndroidDeviceClockMs: async (pooledDevice: PooledDevice, signal: AbortSignal) =>
      (
        await defaultAdbClientFactory
          .create(toBootedDevice(pooledDevice))
          .getDeviceTimestampMsWithSource(undefined, signal)
      ).timestampMs,
    observe: (pooledDevice: PooledDevice, { minTimestamp, signal }) =>
      new RealObserveScreen(toBootedDevice(pooledDevice)).execute({
        skipWaitForFresh: false,
        minTimestamp,
        signal,
      }),
    // A watcher of a held device gets the `observe` tool's deviceId read (#10967): connect-only,
    // never the session pipeline's service rebind or CtrlProxy setup on the holder's device.
    viewerRead: {
      applies: isViewerRead,
      observe: (pooledDevice: PooledDevice, signal: AbortSignal) =>
        new RealObserveScreen(toBootedDevice(pooledDevice), undefined, {
          deviceReadOnly: true,
        }).executeDeviceRead(signal, "none"),
    },
  });
}

/** The daemon state the observation stream callbacks read, as thunks so reassignment is observed. */
export interface ObservationStreamCallbackDeps {
  devicePool(): DevicePool;
  passiveWorkPolicy(): PassiveWorkPolicy;
  timer(): Timer;
  sessionManager(): SessionManager;
  applyStorageSubscriptionRequest(request: StorageSubscriptionRequest): Promise<void>;
}

/** Installs the observation stream server's subscriber, cadence, storage and observation callbacks. */
export function configureObservationStreamCallbacks(
  server: NonNullable<ReturnType<typeof getDeviceDataStreamServer>>,
  coordinator: DefaultObservationInitialFrameCoordinator,
  deps: ObservationStreamCallbackDeps,
): void {
  server.setOnSubscriberConnected((deviceId: string | null, subscriber) => {
    logger.info(
      `[Daemon] IDE plugin subscribed to observation stream (device: ${deviceId ?? "all"}), ensuring WebSocket connections...`,
    );

    // A stream subscription does not acquire devices. Initial frames can
    // connect a CtrlProxy client, so both platforms need passive-work scope.
    const pooledDevices = deps.devicePool().getAllDevices();
    const allDevices = selectObservationStreamDevices(
      pooledDevices,
      deps.passiveWorkPolicy(),
      (device) => logSkippedObservationStreamDevice(device.platform, device.id, "connect"),
    );

    pushInitialObservationFramesForSubscriber(deviceId, allDevices, {
      streamServer: server,
      coordinator,
      subscriber,
      isDeviceAllowed: (id) => {
        const device = deps
          .devicePool()
          .getAllDevices()
          .find((candidate) => candidate.id === id);
        return (
          !!device && deps.passiveWorkPolicy().allows(device.platform, "observation-stream", id)
        );
      },
      androidClientFactory: (device) =>
        AndroidCtrlProxyClient.getInstance(device, defaultAdbClientFactory),
      iosClientFactory: (device) =>
        createObservationStreamIosClient(device, getDeviceDataStreamServer),
    }).catch((error) => {
      logger.warn(`[Daemon] Error pushing initial observation frame: ${error}`);
    });

    if (pooledDevices.length === 0) {
      logger.info("[Daemon] No devices in pool to connect");
    }
  });

  server.setOnScreenshotCadenceChanged((deviceId: string | null) => {
    const devices = deps
      .devicePool()
      .getAllDevices()
      .filter((device) => deviceId === null || device.id === deviceId);

    for (const device of devices) {
      if (device.platform === "android") {
        if (!deps.passiveWorkPolicy().allows("android", "observation-stream", device.id)) {
          logSkippedObservationStreamDevice("android", device.id, "screenshot cadence");
          continue;
        }
        AndroidCtrlProxyClient.getExistingInstance(
          device.id,
        )?.refreshObservationStreamScreenshotCadence();
      } else if (device.platform === "ios") {
        if (!deps.passiveWorkPolicy().allows("ios", "observation-stream", device.id)) {
          logSkippedObservationStreamDevice("ios", device.id, "screenshot cadence");
          continue;
        }
        IOSCtrlProxyClient.getExistingInstance(
          device.id,
        )?.refreshObservationStreamScreenshotCadence();
      }
    }
  });

  server.setOnHierarchyCadenceChanged((deviceId: string | null) => {
    const devices = deps
      .devicePool()
      .getAllDevices()
      .filter((device) => deviceId === null || device.id === deviceId);

    for (const device of devices) {
      if (device.platform === "android") {
        if (!deps.passiveWorkPolicy().allows("android", "observation-stream", device.id)) {
          logSkippedObservationStreamDevice("android", device.id, "hierarchy cadence");
          continue;
        }
        AndroidCtrlProxyClient.getExistingInstance(
          device.id,
        )?.refreshObservationStreamHierarchyCadence();
      } else if (device.platform === "ios") {
        if (!deps.passiveWorkPolicy().allows("ios", "observation-stream", device.id)) {
          logSkippedObservationStreamDevice("ios", device.id, "hierarchy cadence");
          continue;
        }
        const client = IOSCtrlProxyClient.getExistingInstance(device.id);
        if (!client) {
          continue;
        }

        const intervalMs = server.getHierarchyIntervalMsForDevice(device.id);
        void client
          .ensureConnected()
          .then((connected) => {
            if (connected) {
              client.refreshObservationStreamHierarchyCadence(intervalMs);
            }
          })
          .catch((error) => {
            logger.warn(
              `[Daemon] Failed to refresh iOS hierarchy cadence for ${device.id}: ${error}`,
            );
          });
      }
    }
  });

  // Register/release a device-side content observer for one key/value store so external writes
  // emit storage_update frames to the pane (issue #4709). Only Android exposes storage content
  // observers today; a storage pane is always device-scoped, so target the resolved device and
  // skip when no live CtrlProxy client exists. The device-side subscriptionId is deterministic
  // ("packageName:fileName"), so unsubscribe reconstructs it without daemon-side bookkeeping.
  server.setOnStorageSubscriptionRequested((request) =>
    deps.applyStorageSubscriptionRequest(request),
  );

  server.setOnObservationRequested(async ({ deviceId, sessionUuid, signal }) => {
    const authenticator = createDefaultStreamSocketAuthenticator("observationStream", {
      allowObserverSessions: true,
    });
    const pooledDevices = deviceId
      ? [deps.devicePool().getDevice(deviceId)].filter((device) => device !== null)
      : // An all-device request means every observable device; watches have no hierarchy yet.
        deps
          .devicePool()
          .getAllDevices()
          .filter((device) => isAndroidOrIosPlatform(device.platform));

    if (pooledDevices.length === 0) {
      throw new Error(
        deviceId ? `Device ${deviceId} is not available` : "No devices are available",
      );
    }

    if (signal.aborted) {
      throw new Error("Observation request was aborted");
    }

    const requestStart = deps.timer().now();
    return runObservationRequestBatch(
      pooledDevices,
      createDaemonObservationExecutor(requestStart, (pooledDevice) =>
        isHeldByAnotherOwner(
          { sessionManager: deps.sessionManager(), devicePool: deps.devicePool() },
          pooledDevice,
          sessionUuid,
        ),
      ),
      {
        timer: deps.timer(),
        signal,
        assertDeviceActionable: (pooledDevice) => {
          deps.devicePool().assertDeviceActionable(pooledDevice.id, "to observe");
          // Watching: a held device admits any live identity read-only (#10830).
          authenticator.authorize({ sessionUuid, deviceId: pooledDevice.id, admitViewer: true });
        },
      },
    );
  }, PER_DEVICE_OBSERVATION_TIMEOUT_MS + OBSERVATION_BATCH_HEADROOM_MS);
}

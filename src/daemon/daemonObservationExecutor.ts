import type { BootedDevice } from "../models";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import type { PooledDevice } from "./devicePool";
import { createPooledObservationExecutor } from "./observationRequestBatch";

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
export function createDaemonObservationExecutor(
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

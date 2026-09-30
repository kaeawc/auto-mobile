import { DevicePool, type DevicePoolDependencies } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { createDevicePoolDependencies } from "./devicePoolDependencies";

/** Mirror the daemon's pool ready/removed registry listeners for unit tests. */
export function createRegistryWiredDevicePool(
  sessionManager: DevicePoolDependencies["sessionManager"],
  timer: DevicePoolDependencies["timer"],
  installedAppsRepository: DevicePoolDependencies["installedAppsRepository"],
  deviceManager: DevicePoolDependencies["deviceManager"],
  retryExecutor: DevicePoolDependencies["retryExecutor"],
  deviceSessionRepository: DevicePoolDependencies["deviceSessionRepository"],
  PoolClass: typeof DevicePool = DevicePool,
): { pool: DevicePool; registry: DeviceSessionRegistry } {
  const registry = new DeviceSessionRegistry(timer);
  const pool = new PoolClass(
    createDevicePoolDependencies(sessionManager, "daemon-session", {
      timer,
      installedAppsRepository,
      deviceManager,
      retryExecutor,
      deviceSessionRepository,
      onDeviceReady: (deviceId) => {
        const pooled = pool.getDevice(deviceId);
        if (pooled) {
          registry.onDeviceConnected({
            deviceId: pooled.id,
            platform: pooled.platform,
            incarnation: pooled.incarnation,
          });
        }
      },
      onDeviceRemoved: (deviceId) => registry.onDeviceDisconnected(deviceId),
    }),
  );
  return { pool, registry };
}

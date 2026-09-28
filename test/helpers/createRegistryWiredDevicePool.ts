import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";

type PoolArguments = ConstructorParameters<typeof DevicePool>;

/** Mirror the daemon's pool ready/removed registry listeners for unit tests. */
export function createRegistryWiredDevicePool(
  sessionManager: PoolArguments[0],
  timer: PoolArguments[2],
  installedAppsRepository: PoolArguments[3],
  deviceManager: PoolArguments[4],
  retryExecutor: PoolArguments[5],
  deviceSessionRepository: PoolArguments[6],
  PoolClass: typeof DevicePool = DevicePool,
): { pool: DevicePool; registry: DeviceSessionRegistry } {
  const registry = new DeviceSessionRegistry(timer);
  const pool = new PoolClass(
    sessionManager,
    "daemon-session",
    timer,
    installedAppsRepository,
    deviceManager,
    retryExecutor,
    deviceSessionRepository,
    undefined,
    undefined,
    (deviceId) => {
      const pooled = pool.getDevice(deviceId);
      if (pooled) {
        registry.onDeviceConnected({
          deviceId: pooled.id,
          platform: pooled.platform,
          incarnation: pooled.incarnation,
        });
      }
    },
    undefined,
    undefined,
    (deviceId) => registry.onDeviceDisconnected(deviceId),
  );
  return { pool, registry };
}

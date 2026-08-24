import { Timer, defaultTimer } from "../utils/SystemTimer";
import { ConfigSocketServer, getSocketPath } from "./socketServer/index";
import {
  getDeviceSnapshotConfig,
  updateDeviceSnapshotConfig,
} from "../server/deviceSnapshotManager";
import { DEVICE_SNAPSHOT_SOCKET_CONFIG } from "./daemonFiles";
import type { DeviceSnapshotConfig, DeviceSnapshotConfigInput } from "../models";

interface DeviceSnapshotSocketServerDependencies {
  getConfig: () => Promise<DeviceSnapshotConfig>;
  updateConfig: (update: DeviceSnapshotConfigInput | null) => Promise<{
    config: DeviceSnapshotConfig;
    evictedSnapshotNames: string[];
  }>;
}

const defaultDependencies: DeviceSnapshotSocketServerDependencies = {
  getConfig: getDeviceSnapshotConfig,
  updateConfig: updateDeviceSnapshotConfig,
};

/**
 * Socket server for device snapshot configuration.
 * Handles config/get and config/set requests.
 */
export class DeviceSnapshotSocketServer extends ConfigSocketServer<
  DeviceSnapshotConfig,
  DeviceSnapshotConfigInput,
  "device_snapshot_request",
  "device_snapshot_response",
  "evictedSnapshotNames"
> {
  constructor(
    socketPath: string = getSocketPath(DEVICE_SNAPSHOT_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    dependencies: DeviceSnapshotSocketServerDependencies = defaultDependencies,
  ) {
    super({
      socketPath,
      timer,
      serverName: "DeviceSnapshot",
      responseType: "device_snapshot_response",
      evictedKey: "evictedSnapshotNames",
      methodLabel: "device snapshot",
      getConfig: dependencies.getConfig,
      updateConfig: async (update) => {
        const { config, evictedSnapshotNames } = await dependencies.updateConfig(update);
        return { config, evictedItems: evictedSnapshotNames };
      },
    });
  }
}

let socketServer: DeviceSnapshotSocketServer | null = null;

export function getDeviceSnapshotSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(DEVICE_SNAPSHOT_SOCKET_CONFIG);
}

export async function startDeviceSnapshotSocketServer(): Promise<void> {
  if (!socketServer) {
    socketServer = new DeviceSnapshotSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
}

export async function stopDeviceSnapshotSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}

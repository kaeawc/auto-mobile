import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "./devicePoolDependencies";

/** Real pool/registry wiring with no device, persistence, or daemon lifecycle I/O. */
export async function createDeviceRestoreEpochHarness(device: BootedDevice, timer: FakeTimer) {
  const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const registry = new DeviceSessionRegistry(
    timer,
    new FakeIdGenerator(["epoch-old", "epoch-new"]),
  );
  const pool = new DevicePool(
    createDevicePoolDependencies(sessionManager, "test-daemon", {
      timer,
      deviceManager: new FakeDeviceManager(),
      installedAppsRepository: new FakeInstalledAppsRepository(),
      idGenerator: new FakeIdGenerator(),
    }),
  );
  await pool.initializeWithDevices([device]);
  const incarnation = pool.getDeviceIncarnation(device.deviceId)!;
  registry.onDeviceConnected({ ...device, incarnation });
  DaemonState.getInstance().initialize(sessionManager, pool, registry);
  return { pool, registry, sessionManager, incarnation };
}

import type { BootedDevice } from "../../src/models";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { createDevicePoolDependencies } from "./devicePoolDependencies";

export async function observationServiceStartHarness(platform: "android" | "ios" = "android") {
  const timer = new FakeTimer();
  const device: BootedDevice = {
    deviceId: platform === "android" ? "emulator-8621" : "ios-8621",
    name: "Read device",
    platform,
  };
  const sessions = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  const manager = new FakeDeviceManager();
  manager.bootedDevices = [device];
  const lifecycle = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
  const pool = new DevicePool(
    createDevicePoolDependencies(sessions, "read-test", {
      timer,
      deviceManager: manager,
      lifecycleCoordinator: lifecycle,
      installedAppsRepository: new FakeInstalledAppsRepository(),
    }),
  );
  await pool.initializeWithDevices([device]);
  DaemonState.getInstance().initialize(sessions, pool);
  return {
    timer,
    device,
    sessions,
    pool,
    lifecycle,
    close() {
      sessions.stopCleanupTimer();
      DaemonState.getInstance().reset();
    },
  };
}

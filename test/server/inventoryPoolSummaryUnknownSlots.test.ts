import { afterEach, describe, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceManager,
} from "../../src/server/bootedDeviceResources";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// Inventory contract: unknown never fails open. When the managed-slot registry is unreadable and no
// snapshot was ever loaded, `availableDevices` (getRefreshedStats) refuses, and the booted resource
// drops the platform's devices as a failed observation. But the resource's pool summary then falls
// back to the pool's own entries WITHOUT refreshing ownership, so a device a slot may hold is
// summed into `poolStatus.idle`.

const SIM = "SIM-UNKNOWN-SLOTS";
const sim: BootedDevice = { deviceId: SIM, name: SIM, platform: "ios" };

const unreadableSlots: ManagedSlotExclusion = {
  refresh: async () => {
    throw new Error("slot registry unreadable");
  },
  holderOf: () => undefined,
  stableIdsFor: () => new Set(),
};

describe("pool summary when managed-slot ownership is unknown", () => {
  let sessions: SessionManager | undefined;

  afterEach(() => {
    DaemonState.getInstance().reset();
    sessions?.stopCleanupTimer();
    resetBootedDevicesResourceCache();
    setDeviceManager(null);
  });

  test("the booted resource does not count the device idle while available-devices refuses", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("ios", [sim]);
    manager.setBootedDevices("android", []);
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "hunt-unknown-slots", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        managedSlotExclusion: unreadableSlots,
      }),
    );
    await pool.initializeWithDevices([sim]);
    DaemonState.getInstance().initialize(sessions, pool);
    setDeviceManager(manager);

    // available-devices: refuses rather than report the device free.
    await expect(pool.getRefreshedStats()).rejects.toThrow();

    const resource = await getBootedDevicesForPlatforms(["ios"], timer);
    expect(resource.poolStatus?.idle).toBe(0);
  });
});

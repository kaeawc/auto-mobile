import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { listDevicePayloads } from "../../src/server/deviceTools";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { assignManagedSlotDevice } from "../daemon/managedSlots/managedSlotFixtures";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });

describe("listDevices reports ownership allocation enforces", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  beforeEach(() => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  });
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  const makePool = async (
    devices: BootedDevice[],
    extra: Partial<Parameters<typeof createDevicePoolDependencies>[2]>,
  ) => {
    const manager = new FakeDeviceManager();
    manager.bootedDevices = devices;
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "listing-ownership", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        ...extra,
      }),
    );
    await pool.initializeWithDevices(devices);
    return pool;
  };

  test("a managed-slot device is assigned/held, a free device stays idle", async () => {
    const registry = new FakeSlotRegistry(timer);
    await assignManagedSlotDevice(registry, "ios", "SIM-SLOT");
    const devices = [ios("SIM-SLOT"), ios("SIM-FREE")];
    const pool = await makePool(devices, {
      managedSlotExclusion: new RegistryManagedSlotExclusion(async () => registry, timer),
    });
    await pool.managedSlotStableIds("ios");

    const [slot, free] = listDevicePayloads(devices, pool, new Map());
    expect(slot.runtime.poolStatus).toBe("assigned");
    expect(slot.runtime.heldBy).toBe("managed_slot");
    expect(slot.runtime.session).toBeNull();
    expect(free.runtime.poolStatus).toBe("idle");
    expect(free.runtime.heldBy).toBeUndefined();
  });

  test("a device another daemon drives is assigned/held", async () => {
    const ownership: ForeignDeviceOwnership = {
      async refresh() {},
      foreignOwnerPid: (id) => (id === "SIM-FOREIGN" ? 4242 : undefined),
      claim: async () => true,
      release() {},
    };
    const devices = [ios("SIM-FOREIGN"), ios("SIM-FREE")];
    const pool = await makePool(devices, { iosForeignDeviceOwnership: ownership });

    const [foreign, free] = listDevicePayloads(devices, pool, new Map());
    expect(foreign.runtime.poolStatus).toBe("assigned");
    expect(foreign.runtime.heldBy).toBe("other_daemon");
    expect(free.runtime.poolStatus).toBe("idle");
    expect(free.runtime.heldBy).toBeUndefined();
  });
});

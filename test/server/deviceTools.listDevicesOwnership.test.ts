import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { RegistryBindingExclusion } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { listDevicePayloads } from "../../src/server/deviceTools";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { assignBindingDevice } from "../daemon/sessionBroker/provisioning/bindingFixtures";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeBindingRegistry } from "../fakes/FakeBindingRegistry";
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

  test("a binding device is assigned/held, a free device stays idle", async () => {
    const registry = new FakeBindingRegistry(timer);
    await assignBindingDevice(registry, "ios", "SIM-SLOT");
    const devices = [ios("SIM-SLOT"), ios("SIM-FREE")];
    const pool = await makePool(devices, {
      bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
    });
    await pool.bindingStableIds("ios");

    const [binding, free] = listDevicePayloads(devices, pool, new Map());
    expect(binding.runtime.poolStatus).toBe("assigned");
    expect(binding.runtime.heldBy).toBe("session_broker");
    expect(binding.runtime.session).toBeNull();
    expect(free.runtime.poolStatus).toBe("idle");
    expect(free.runtime.heldBy).toBeUndefined();
  });

  test("a broker-bound device the pool does not list is still reported held (#15233)", async () => {
    const registry = new FakeBindingRegistry(timer);
    await assignBindingDevice(registry, "ios", "SIM-SLOT");
    // The erase reset shut SIM-SLOT down, so the pool dropped it; the platform lists it booted again.
    const pool = await makePool([ios("SIM-FREE")], {
      bindingExclusion: new RegistryBindingExclusion(async () => registry, timer),
    });
    await pool.bindingStableIds("ios");

    const [unpooled, free] = listDevicePayloads(
      [ios("SIM-SLOT"), ios("SIM-FREE")],
      pool,
      new Map(),
    );

    expect(unpooled.runtime.heldBy).toBe("session_broker");
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
  test("a shutdown-reserved idle device is assigned (no heldBy), matching getStats", async () => {
    const devices = [ios("SIM-KILL"), ios("SIM-FREE")];
    const pool = await makePool(devices, {});
    const reservation = await pool.reserveDeviceForShutdown("SIM-KILL");
    expect(reservation).toBeDefined();

    const [killed, free] = listDevicePayloads(devices, pool, new Map());
    expect(killed.runtime.poolStatus).toBe("assigned");
    expect(killed.runtime.heldBy).toBeUndefined();
    expect(killed.runtime.session).toBeNull();
    expect(free.runtime.poolStatus).toBe("idle");
    expect(pool.getStats()).toMatchObject({ idle: 1, assigned: 1 });
  });

  test("a readiness-reserved idle device is assigned until released", async () => {
    const devices = [ios("SIM-BOOT"), ios("SIM-FREE")];
    const pool = await makePool(devices, {});
    const release = await pool.reserveDeviceForReadiness("SIM-BOOT", devices[0]);

    const [booting] = listDevicePayloads(devices, pool, new Map());
    expect(booting.runtime.poolStatus).toBe("assigned");
    expect(pool.getStats()).toMatchObject({ idle: 1, assigned: 1 });

    await release();
    expect(listDevicePayloads(devices, pool, new Map())[0].runtime.poolStatus).toBe("idle");
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { DevicePool } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import { RegistryManagedSlotExclusion } from "../../src/daemon/managedSlots/managedSlotExclusion";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { DaemonRequest } from "../../src/daemon/types";
import type { BootedDevice } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeSlotRegistry } from "../fakes/FakeSlotRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { assignManagedSlotDevice } from "./managedSlots/managedSlotFixtures";

// #11305: availableDevices means "allocation can lend it", so the handlers must refresh the
// managed-slot snapshot and foreign ownership before counting, not answer from a stale cache.

const ios = (deviceId: string): BootedDevice => ({ deviceId, name: deviceId, platform: "ios" });
const request = (method: string): DaemonRequest => ({
  id: "r",
  type: "daemon_request",
  method,
  params: {},
});

describe("daemon availableDevices and refreshDevices refresh ownership before counting", () => {
  let timer: FakeTimer;
  let sessions: SessionManager;
  let registry: FakeSlotRegistry;
  const devices = [ios("SIM-SLOT"), ios("SIM-FREE")];

  const makePool = async (extra: Partial<Parameters<typeof createDevicePoolDependencies>[2]>) => {
    const manager = new FakeDeviceManager();
    manager.bootedDevices = devices;
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "handler-ownership", {
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

  const stateFor = (pool: DevicePool): DaemonStateAccess => ({
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: () => false,
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => pool,
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  });

  const slotExclusion = () => new RegistryManagedSlotExclusion(async () => registry, timer);

  beforeEach(() => {
    timer = new FakeTimer();
    sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    registry = new FakeSlotRegistry(timer);
  });
  afterEach(() => {
    sessions.stopCleanupTimer();
    timer.reset();
  });

  test("a stale snapshot: a slot took the device since the last refresh", async () => {
    const pool = await makePool({ managedSlotExclusion: slotExclusion() });
    await pool.managedSlotStableIds("ios");
    await assignManagedSlotDevice(registry, "ios", "SIM-SLOT");

    const response = await handleDaemonRequest(request("daemon/availableDevices"), stateFor(pool));

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({ availableDevices: 1, assignedDevices: 1 });
  });

  test("a never-loaded snapshot does not read a slot's device as free", async () => {
    await assignManagedSlotDevice(registry, "ios", "SIM-SLOT");
    const pool = await makePool({ managedSlotExclusion: slotExclusion() });

    const response = await handleDaemonRequest(request("daemon/refreshDevices"), stateFor(pool));

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({ availableDevices: 1, totalDevices: 2 });
  });

  test("another daemon's claim is picked up by refreshing foreign ownership", async () => {
    let owned = false;
    const ownership: ForeignDeviceOwnership = {
      async refresh() {
        owned = true;
      },
      foreignOwnerPid: (id) => (owned && id === "SIM-SLOT" ? 4242 : undefined),
      claim: async () => true,
      release() {},
    };
    const pool = await makePool({ iosForeignDeviceOwnership: ownership });

    const response = await handleDaemonRequest(request("daemon/availableDevices"), stateFor(pool));

    expect(response.result).toMatchObject({ availableDevices: 1, assignedDevices: 1 });
  });

  test("an unreadable slot registry fails the call instead of reporting devices idle", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const pool = await makePool({
        managedSlotExclusion: new RegistryManagedSlotExclusion(async () => {
          throw new Error("registry locked");
        }, timer),
      });

      for (const method of ["daemon/availableDevices", "daemon/refreshDevices"]) {
        const response = await handleDaemonRequest(request(method), stateFor(pool));
        expect(response.success).toBe(false);
        expect(response.result).toBeUndefined();
        expect(response.error).toContain("registry locked");
      }
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { makePool } from "../helpers/makePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { discoverAndReconcile } from "../../src/daemon/deviceLossDiscovery";
import type { BootedDevice } from "../../src/models";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import { MISSING_DEVICE_MISS_THRESHOLD } from "../../src/daemon/missingDeviceLiveness";

// The pool's own refresh and loss monitor sweep Apple Watch simulators beside Android and iOS, under
// the watch source only: a failed watch sweep never prunes a watch, and a watch never counts toward
// "either" capacity (#14908).

useSessionIdleWindowForSuite();

const IPHONE: BootedDevice = {
  deviceId: "11111111-2222-4333-8444-555555555555",
  name: "iPhone 16",
  platform: "ios",
};
const WATCH: BootedDevice = {
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  name: "Apple Watch Series 10 (46mm)",
  platform: "watchos",
};

function poolOver(utils: FakeDeviceUtils) {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  return makePool(manager, "watch-discovery-daemon", { timer, deviceManager: utils });
}

function hostWithWatch(): FakeDeviceUtils {
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("ios", [IPHONE]);
  utils.setBootedDevices("watchos", [WATCH]);
  return utils;
}

describe("pool discovery of Apple Watch simulators", () => {
  test("a refresh pools a booted watch as watchos", async () => {
    const utils = hostWithWatch();
    const pool = poolOver(utils);

    await pool.refreshDevices();

    expect(pool.getDevice(WATCH.deviceId)?.platform).toBe("watchos");
    expect(pool.getDevice(IPHONE.deviceId)?.platform).toBe("ios");
    expect(
      utils.getBootedDevicesDetailedCalls().map(({ options }) => options.includeWatchOs),
    ).toEqual([true]);
  });

  test("a failed watch sweep keeps a pooled watch", async () => {
    const utils = hostWithWatch();
    const pool = poolOver(utils);
    await pool.refreshDevices();
    utils.setBootedDevices("watchos", []);
    utils.failedPlatforms.add("watchos");

    for (let refresh = 0; refresh < MISSING_DEVICE_MISS_THRESHOLD; refresh++) {
      await pool.refreshDevices();
    }

    expect(pool.getDevice(WATCH.deviceId)?.platform).toBe("watchos");
  });

  test("a complete watch sweep without the watch removes it", async () => {
    const utils = hostWithWatch();
    const pool = poolOver(utils);
    await pool.refreshDevices();
    utils.setBootedDevices("watchos", []);

    for (let refresh = 0; refresh < MISSING_DEVICE_MISS_THRESHOLD; refresh++) {
      await pool.refreshDevices();
    }

    expect(pool.getDevice(WATCH.deviceId)).toBeNull();
    expect(pool.getDevice(IPHONE.deviceId)?.platform).toBe("ios");
  });

  test("pool totals count Android and iOS devices only", async () => {
    const pool = poolOver(hostWithWatch());
    await pool.refreshDevices();

    const stats = pool.getStats();

    expect(stats.total).toBe(stats.idle + stats.assigned + stats.error);
    expect(stats.total).toBe(1);
  });

  test("the loss monitor's either sweep includes watches on every read", async () => {
    const utils = hostWithWatch();
    const pool = poolOver(utils);
    await pool.refreshDevices();
    const before = utils.getBootedDevicesDetailedCalls().length;

    await discoverAndReconcile(pool, utils, {});

    const reads = utils.getBootedDevicesDetailedCalls().slice(before);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(({ options }) => options.includeWatchOs === true)).toBe(true);
  });
});

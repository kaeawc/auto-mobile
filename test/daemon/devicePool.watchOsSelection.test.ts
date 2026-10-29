import { describe, expect, test } from "bun:test";
import { makePool } from "../helpers/makePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import { settleByFakeEvents } from "../helpers/fakeTimerStepping";

// A pooled Apple Watch is reached only by a request that names watchOS. "Either" (no platform)
// means Android or iOS, and an iOS sweep never lists watches, so it cannot prove one gone (#14908).

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

/** A pool holding an iPhone and a watch; each test builds its own so mutations never leak. */
async function poolWithWatch() {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("ios", [IPHONE]);
  const pool = makePool(manager, "watch-daemon", { timer, deviceManager: utils });
  await pool.initializeWithDevices([IPHONE, WATCH]);
  return { timer, pool };
}

describe("DevicePool with an Apple Watch", () => {
  test("a complete iOS refresh does not remove a pooled watch", async () => {
    const { pool } = await poolWithWatch();

    await pool.refreshDevices();

    expect(pool.getDevice(WATCH.deviceId)?.platform).toBe("watchos");
    expect(pool.getDevice(IPHONE.deviceId)?.platform).toBe("ios");
  });

  test("an allocation that names no platform never takes the watch", async () => {
    const { pool, timer } = await poolWithWatch();

    expect(await pool.assignDeviceToSession("either-1")).toBe(IPHONE.deviceId);
    const second = pool.assignDeviceToSession("either-2").then(
      (deviceId) => deviceId,
      (error: unknown) => error,
    );
    const outcome = await settleByFakeEvents(timer, second, { description: "either-2" });
    expect(outcome).toBeInstanceOf(Error);

    expect(pool.getDevice(WATCH.deviceId)?.sessionId).toBeNull();
  });

  test("a watch request takes the watch", async () => {
    const { pool } = await poolWithWatch();

    expect(await pool.assignDeviceToSession("watch-1", "watchos")).toBe(WATCH.deviceId);
  });

  test("auto-start never boots watches as pool capacity", async () => {
    const started = await pool.testHooks.startAdditionalDevices(1, timer.now() + 1_000, "watchos");

    expect(started).toBe(0);
    expect(utils.getListDeviceImagesCalls()).toEqual([]);
    expect(utils.getGetDeviceImagesDetailedCalls()).toEqual([]);
  });
});

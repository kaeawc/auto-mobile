import { describe, expect, test } from "bun:test";
import { makePool } from "../helpers/makePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { discoverAndReconcile } from "../../src/daemon/deviceLossDiscovery";
import { bootedSweepsFor } from "../../src/devices/bootedDiscoveryAppend";
import type { BootedDevice } from "../../src/models";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import { MISSING_DEVICE_MISS_THRESHOLD } from "../../src/daemon/deviceLossMisses";
import { BootedDeviceDiscoveryIncompleteError } from "../../src/models/BootedDeviceDiscoveryIncompleteError";

// The pool's own refresh and loss reads sweep the Apple TV and Vision Pro simulator families it
// tracks, so a pooled headset that shuts down is released; a family it does not track is never
// swept, and a failed sweep never prunes.

useSessionIdleWindowForSuite();

const IPHONE: BootedDevice = {
  deviceId: "11111111-2222-4333-8444-555555555555",
  name: "iPhone 16",
  platform: "ios",
};
const HEADSET: BootedDevice = {
  deviceId: "C0FFEE00-0000-4000-8000-000000000099",
  name: "Fake Vision Pro",
  platform: "visionos",
};

async function poolOver(utils: FakeDeviceUtils, pooled: BootedDevice[]) {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  manager.stopCleanupTimer();
  const pool = makePool(manager, "apple-sweep-daemon", { timer, deviceManager: utils });
  await pool.initializeWithDevices(pooled);
  return pool;
}

function hostWithHeadset(): FakeDeviceUtils {
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("ios", [IPHONE]);
  utils.setBootedDevices("visionos", [HEADSET]);
  return utils;
}

describe("pool sweeps of tracked Apple TV and Vision Pro simulators", () => {
  test("an either read sweeps only the families a caller opts into", () => {
    expect(bootedSweepsFor("either", {})).toMatchObject({ tvos: false, visionos: false });
    expect(
      bootedSweepsFor("either", { includeAppleSimulatorPlatforms: ["visionos"] }),
    ).toMatchObject({ tvos: false, visionos: true, android: true, ios: true });
    expect(bootedSweepsFor("ios", { includeAppleSimulatorPlatforms: ["tvos"] }).tvos).toBe(false);
  });

  test("a refresh sweeps visionOS only while the pool tracks a headset", async () => {
    const withHeadset = hostWithHeadset();
    await (await poolOver(withHeadset, [IPHONE, HEADSET])).refreshDevices();
    const withoutHeadset = hostWithHeadset();
    await (await poolOver(withoutHeadset, [IPHONE])).refreshDevices();

    expect(
      withHeadset
        .getBootedDevicesDetailedCalls()
        .map(({ options }) => options.includeAppleSimulatorPlatforms),
    ).toEqual([["visionos"]]);
    expect(
      withoutHeadset
        .getBootedDevicesDetailedCalls()
        .map(({ options }) => options.includeAppleSimulatorPlatforms),
    ).toEqual([undefined]);
  });

  test("a pooled headset that shuts down is removed by complete refreshes", async () => {
    const utils = hostWithHeadset();
    const pool = await poolOver(utils, [IPHONE, HEADSET]);
    utils.setBootedDevices("visionos", []);

    for (let refresh = 0; refresh < MISSING_DEVICE_MISS_THRESHOLD; refresh++) {
      await pool.refreshDevices();
    }

    expect(pool.getDevice(HEADSET.deviceId)).toBeNull();
    expect(pool.getDevice(IPHONE.deviceId)?.platform).toBe("ios");
  });

  test("a failed visionOS sweep keeps a pooled headset", async () => {
    const utils = hostWithHeadset();
    const pool = await poolOver(utils, [IPHONE, HEADSET]);
    utils.setBootedDevices("visionos", []);
    utils.failedPlatforms.add("visionos");

    for (let refresh = 0; refresh < MISSING_DEVICE_MISS_THRESHOLD; refresh++) {
      await pool.refreshDevices();
    }

    expect(pool.getDevice(HEADSET.deviceId)?.platform).toBe("visionos");
  });

  test("the loss monitor sweeps a held headset's family on every read", async () => {
    const utils = hostWithHeadset();
    const pool = await poolOver(utils, [IPHONE]);
    const before = utils.getBootedDevicesDetailedCalls().length;

    await discoverAndReconcile(pool, utils, {
      heldDevices: [{ platform: "visionos", assignedDevice: HEADSET.deviceId }],
    });

    const reads = utils.getBootedDevicesDetailedCalls().slice(before);
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every(({ options }) => options.includeAppleSimulatorPlatforms?.includes("visionos")),
    ).toBe(true);
  });

  test("the refreshed inventory lists a live pooled headset; totals stay Android and iOS", async () => {
    const pool = await poolOver(hostWithHeadset(), [IPHONE, HEADSET]);

    const { stats, deviceIds } = await pool.getRefreshedInventory();

    expect([...deviceIds].toSorted()).toEqual([IPHONE.deviceId, HEADSET.deviceId].toSorted());
    expect(stats.total).toBe(1);
  });

  test("a failed visionOS listing makes the refreshed inventory unknown, not short", async () => {
    const utils = hostWithHeadset();
    const pool = await poolOver(utils, [IPHONE, HEADSET]);
    utils.failedPlatforms.add("visionos");

    const error = await pool.getRefreshedInventory().then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
  });
});

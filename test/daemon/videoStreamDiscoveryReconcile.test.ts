import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { resolveVideoStreamDevice } from "../../src/daemon/videoStreamSocketServer";
import type { BootedDevice } from "../../src/models";

/**
 * FUNNEL 1 for the raw H.264 video-stream resolver, which runs its OWN fresh
 * discovery through `PlatformDeviceManager.getBootedDevices("either")`. Without
 * folding that observation into the pool, BOTH admission checks in
 * `handleSubscribe` -- the one on the named serial and the one on the resolved
 * device -- read pool state from BEFORE this discovery, so a capture is started
 * on a runtime the pool can no longer identify
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 */
describe("resolveVideoStreamDevice folds its discovery into the pool", () => {
  const SERIAL = "emulator-5554";

  afterEach(() => {
    DaemonState.getInstance().reset();
  });

  async function livePool(): Promise<DevicePool> {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const utils = new FakeDeviceUtils();
    const device: BootedDevice = { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" };
    utils.setBootedDevices("android", [device]);
    const pool = new DevicePool(manager, "daemon-test", timer, undefined, utils);
    DaemonState.getInstance().initialize(manager, pool);
    await pool.initializeWithDevices([device]);
    return pool;
  }

  const discovering = (devices: BootedDevice[]) => ({
    getBootedDevices: async (): Promise<BootedDevice[]> => devices,
  });

  test("keeps an AVD-resolved pooled emulator live when ADB reports its raw serial", async () => {
    const pool = await livePool();
    const resolved = { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" } as const;

    const device = await resolveVideoStreamDevice(
      {
        // This is the production split: DeviceSessionManager's ADB scan has
        // the raw serial while PlatformDeviceManager resolves the AVD name.
        detectConnectedPlatforms: async (): Promise<BootedDevice[]> => [
          { deviceId: SERIAL, name: SERIAL, platform: "android" },
        ],
        getBootedDevices: async (): Promise<BootedDevice[]> => [resolved],
      },
      SERIAL,
    );

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(false);
    expect(device).toEqual(resolved);
  });

  test("quarantines the pooled entry when its discovery reads the placeholder", async () => {
    const pool = await livePool();

    await resolveVideoStreamDevice(
      discovering([{ deviceId: SERIAL, name: `Unknown (${SERIAL})`, platform: "android" }]),
      SERIAL,
    );

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });

  test("quarantines the pooled entry when its discovery names a different AVD", async () => {
    const pool = await livePool();

    await resolveVideoStreamDevice(
      discovering([{ deviceId: SERIAL, name: "Pixel_7_API_34", platform: "android" }]),
      SERIAL,
    );

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });

  test("leaves a pooled entry alone when its discovery agrees", async () => {
    const pool = await livePool();

    const device = await resolveVideoStreamDevice(
      discovering([{ deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" }]),
      SERIAL,
    );

    expect(device.deviceId).toBe(SERIAL);
    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(false);
  });

  test("reconciles before refusing an unknown serial, so the observation is never lost", async () => {
    const pool = await livePool();

    await expect(
      resolveVideoStreamDevice(
        discovering([{ deviceId: SERIAL, name: `Unknown (${SERIAL})`, platform: "android" }]),
        "emulator-5556",
      ),
    ).rejects.toThrow("No connected device with id emulator-5556");

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });
});

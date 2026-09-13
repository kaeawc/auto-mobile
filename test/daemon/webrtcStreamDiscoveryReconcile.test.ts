import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { resolveWebRtcStreamDevice } from "../../src/daemon/webrtcStreamSocketServer";
import type { BootedDevice } from "../../src/models";

/**
 * FUNNEL 1 for the WebRTC stream resolver: it runs its OWN fresh discovery, so it
 * can be the first path to see the `Unknown (<serial>)` placeholder or a
 * different AVD on a reused serial. Folding that observation into the pool before
 * returning is what makes the admission gate in `handleStart` read the state this
 * discovery just established rather than the state from before it
 * ([#6888](https://github.com/kaeawc/auto-mobile/pull/6888) review).
 */
describe("resolveWebRtcStreamDevice folds its discovery into the pool", () => {
  const SERIAL = "emulator-5554";

  afterEach(() => {
    DaemonState.getInstance().reset();
  });

  function livePool(): DevicePool {
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const utils = new FakeDeviceUtils();
    const device: BootedDevice = { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" };
    utils.setBootedDevices("android", [device]);
    const pool = new DevicePool(manager, "daemon-test", timer, undefined, utils);
    DaemonState.getInstance().initialize(manager, pool);
    return pool;
  }

  test("quarantines the pooled entry when its discovery reads the placeholder", async () => {
    const pool = livePool();
    await pool.initializeWithDevices([
      { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" },
    ]);

    await resolveWebRtcStreamDevice(
      {
        getBootedDevices: async () => [
          { deviceId: SERIAL, name: `Unknown (${SERIAL})`, platform: "android" } as BootedDevice,
        ],
      },
      SERIAL,
      "android",
    );

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });

  test("quarantines the pooled entry when its discovery names a different AVD", async () => {
    const pool = livePool();
    await pool.initializeWithDevices([
      { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" },
    ]);

    await resolveWebRtcStreamDevice(
      {
        getBootedDevices: async () => [
          { deviceId: SERIAL, name: "Pixel_7_API_34", platform: "android" } as BootedDevice,
        ],
      },
      SERIAL,
      "android",
    );

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });

  test("leaves a pooled entry alone when its discovery agrees", async () => {
    const pool = livePool();
    await pool.initializeWithDevices([
      { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" },
    ]);

    const device = await resolveWebRtcStreamDevice(
      {
        getBootedDevices: async () => [
          { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" } as BootedDevice,
        ],
      },
      SERIAL,
      "android",
    );

    expect(device.deviceId).toBe(SERIAL);
    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(false);
  });
});

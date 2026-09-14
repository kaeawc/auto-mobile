import { afterEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { resolveTestRecordingDevice } from "../../src/daemon/testRecordingSocketServer";
import type { BootedDevice, SomePlatform } from "../../src/models";

/**
 * FUNNEL 1 for the test-recording resolver (#6923). It used to discover through
 * `DeviceSessionManager.detectConnectedPlatforms` and never fold the observation
 * into the pool, so the admission gate in `handleRequest` re-read pool state
 * from BEFORE that discovery — the same gap the video-stream and WebRTC
 * resolvers closed in #6888. Selection here is discovery + reconcile + match
 * only; readiness (runner setup) is a separate step the gate runs before.
 */
describe("resolveTestRecordingDevice folds its discovery into the pool (#6923)", () => {
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

  const discovering = (devices: BootedDevice[], requested: SomePlatform[] = []) => ({
    getBootedDevices: async (platform: SomePlatform): Promise<BootedDevice[]> => {
      requested.push(platform);
      return devices;
    },
  });

  test("leaves a labelled pooled entry untouched when discovery reports its raw serial", async () => {
    const pool = await livePool();
    const raw: BootedDevice = { deviceId: SERIAL, name: SERIAL, platform: "android" };

    const device = await resolveTestRecordingDevice(discovering([raw]), SERIAL);

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(false);
    expect(device).toEqual(raw);
  });

  test("quarantines the pooled entry when its discovery reads the placeholder", async () => {
    const pool = await livePool();

    await resolveTestRecordingDevice(
      discovering([{ deviceId: SERIAL, name: `Unknown (${SERIAL})`, platform: "android" }]),
      SERIAL,
    );

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });

  test("quarantines the pooled entry when its discovery names a different AVD", async () => {
    const pool = await livePool();

    await resolveTestRecordingDevice(
      discovering([{ deviceId: SERIAL, name: "Pixel_7_API_34", platform: "android" }]),
      SERIAL,
    );

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });

  test("reconciles before refusing an unknown serial, so the observation is never lost", async () => {
    const pool = await livePool();

    await expect(
      resolveTestRecordingDevice(
        discovering([{ deviceId: SERIAL, name: `Unknown (${SERIAL})`, platform: "android" }]),
        "emulator-5556",
      ),
    ).rejects.toThrow("Device emulator-5556 not found among connected devices");

    expect(pool.isPooledIdentityUnresolved(SERIAL)).toBe(true);
  });

  test("scopes discovery to the requested platform and to both when none is named", async () => {
    const requested: SomePlatform[] = [];
    const device: BootedDevice = { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" };

    await resolveTestRecordingDevice(discovering([device], requested), SERIAL, "android");
    await resolveTestRecordingDevice(discovering([device], requested), SERIAL);

    expect(requested).toEqual(["android", "either"]);
  });

  test("refuses a device whose platform differs from the one requested", async () => {
    const ios: BootedDevice = { deviceId: "SIM-1", name: "iPhone 16", platform: "ios" };

    await expect(
      resolveTestRecordingDevice(discovering([ios]), "SIM-1", "android"),
    ).rejects.toThrow("Device SIM-1 not found among connected android devices");
  });

  test("with no serial named, a single connected device is the target", async () => {
    const device: BootedDevice = { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" };

    await expect(resolveTestRecordingDevice(discovering([device]))).resolves.toEqual(device);
  });

  test("with no serial named, several connected devices resolve to the current one", async () => {
    const first: BootedDevice = { deviceId: SERIAL, name: "Pixel_8_API_35", platform: "android" };
    const second: BootedDevice = {
      deviceId: "emulator-5556",
      name: "Pixel_7",
      platform: "android",
    };

    await expect(
      resolveTestRecordingDevice(discovering([first, second]), undefined, undefined, () => second),
    ).resolves.toEqual(second);
    await expect(
      resolveTestRecordingDevice(
        discovering([first, second]),
        undefined,
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow(/Multiple connected devices; specify deviceId/);
  });

  test("with no serial named and nothing connected, refuses", async () => {
    await expect(resolveTestRecordingDevice(discovering([]))).rejects.toThrow(
      "No connected devices found",
    );
  });
});

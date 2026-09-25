import { describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

function makePool(timer: FakeTimer): DevicePool {
  return new DevicePool(
    new SessionManager(timer, new FakeDeviceSessionPersistence()),
    "daemon-session",
    timer,
    new FakeInstalledAppsRepository(),
    new FakeDeviceManager(),
    new DefaultRetryExecutor(timer),
  );
}

const device: BootedDevice = {
  platform: "android",
  name: "Pixel_8_API_35",
  deviceId: "emulator-5554",
};

/**
 * Public wrapper the disconnect monitor's in-session offline recovery
 * (#7536) uses to skip a serial that AndroidEmulatorClient's own
 * fresh-provision readiness wait already owns recovery for. Mirrors the same
 * `isLeasedForAndroidStartup` check `detachAdbServerResetCohort` already uses
 * to defer process-wide ADB-reset recovery on an in-flight startup.
 */
describe("DevicePool.isDeviceLeasedForAndroidStartup", () => {
  test("is false for a pooled device with no in-flight startup lease", async () => {
    const timer = new FakeTimer();
    const pool = makePool(timer);
    await pool.addDevice(device, {
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    });

    expect(pool.isDeviceLeasedForAndroidStartup(device.deviceId)).toBe(false);
  });

  test("is true while a matching named startup lease is held", async () => {
    const timer = new FakeTimer();
    const pool = makePool(timer);
    await pool.addDevice(device, {
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    });

    const release = await pool.reserveAndroidStartupLease(device.name, true);
    try {
      expect(pool.isDeviceLeasedForAndroidStartup(device.deviceId)).toBe(true);
    } finally {
      await release();
    }
  });

  test("returns to false once the startup lease releases", async () => {
    const timer = new FakeTimer();
    const pool = makePool(timer);
    await pool.addDevice(device, {
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    });

    const release = await pool.reserveAndroidStartupLease(device.name, true);
    await release();

    expect(pool.isDeviceLeasedForAndroidStartup(device.deviceId)).toBe(false);
  });

  test("is false for an untracked serial", () => {
    const timer = new FakeTimer();
    const pool = makePool(timer);

    expect(pool.isDeviceLeasedForAndroidStartup("emulator-9999")).toBe(false);
  });

  test("does not match an unrelated AVD's startup lease", async () => {
    const timer = new FakeTimer();
    const pool = makePool(timer);
    await pool.addDevice(device, {
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    });

    const release = await pool.reserveAndroidStartupLease("Pixel_9_API_36", true);
    try {
      expect(pool.isDeviceLeasedForAndroidStartup(device.deviceId)).toBe(false);
    } finally {
      await release();
    }
  });
});

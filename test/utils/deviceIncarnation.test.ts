import { afterEach, describe, expect, test } from "bun:test";
import {
  deviceIncarnationToken,
  setDeviceIncarnationResolver,
} from "../../src/utils/deviceIncarnation";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import type { BootedDevice } from "../../src/models";

describe("deviceIncarnationToken", () => {
  afterEach(() => {
    setDeviceIncarnationResolver(undefined);
  });

  test("is undefined with no resolver registered", () => {
    setDeviceIncarnationResolver(undefined);
    expect(deviceIncarnationToken("emulator-5554")).toBeUndefined();
  });

  test("stringifies whatever the registered resolver answers", () => {
    setDeviceIncarnationResolver((deviceId) => (deviceId === "emulator-5554" ? 3 : undefined));
    expect(deviceIncarnationToken("emulator-5554")).toBe("3");
    expect(deviceIncarnationToken("emulator-5556")).toBeUndefined();
  });

  test("follows the pool's incarnation once the daemon publishes its pool", async () => {
    const timer = new FakeTimer();
    const deviceManager = new FakeDeviceManager();
    const sessionManager = new SessionManager(timer);
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceManager,
      new DefaultRetryExecutor(timer),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    const device: BootedDevice = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    };
    deviceManager.bootedDevices = [device];
    await pool.initializeWithDevices([device]);

    const first = deviceIncarnationToken(device.deviceId);
    expect(first).toBeDefined();

    // A new pooled connection is a new epoch, and the published token must move
    // with it — it is the only thing a per-device cache can key on.
    await pool.removeDevice(device.deviceId);
    expect(deviceIncarnationToken(device.deviceId)).toBeUndefined();
    await pool.refreshDevices();
    expect(deviceIncarnationToken(device.deviceId)).not.toBe(first);
  });
});

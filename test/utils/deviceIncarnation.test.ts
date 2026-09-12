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
  // Reset the whole singleton, not just the resolver: a test that fails after
  // initializing a pool would otherwise leave DaemonState holding that pool and
  // session manager, and bun shares singleton state across test files, so a
  // later file would observe it. `reset` clears the resolver too.
  afterEach(() => {
    DaemonState.getInstance().reset();
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

  // The resolver is a module global closed over ONE pool. A daemon-state reset
  // (shutdown, or a test moving on) retires that pool, and leaving the closure
  // installed would keep the retired pool alive and keep answering direct-mode
  // callers with its epochs (#6863 review).
  test("stops answering after the daemon state that installed it is reset", async () => {
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
    const device: BootedDevice = {
      name: "Pixel 8",
      platform: "android",
      deviceId: "emulator-5554",
    };
    deviceManager.bootedDevices = [device];
    DaemonState.getInstance().initialize(sessionManager, pool);
    await pool.initializeWithDevices([device]);
    expect(deviceIncarnationToken(device.deviceId)).toBeDefined();

    DaemonState.getInstance().reset();

    expect(deviceIncarnationToken(device.deviceId)).toBeUndefined();

    // A fresh initialize installs a resolver for the NEW pool.
    const replacementPool = new DevicePool(
      sessionManager,
      "daemon-session-2",
      timer,
      new FakeInstalledAppsRepository(),
      deviceManager,
      new DefaultRetryExecutor(timer),
    );
    DaemonState.getInstance().initialize(sessionManager, replacementPool);
    await replacementPool.initializeWithDevices([device]);
    expect(deviceIncarnationToken(device.deviceId)).toBeDefined();
    DaemonState.getInstance().reset();
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

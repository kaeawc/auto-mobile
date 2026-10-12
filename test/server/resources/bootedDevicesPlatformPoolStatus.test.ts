import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeOrientationReader } from "../../fakes/FakeOrientationReader";
import type { BootedDevice } from "../../../src/models";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import {
  getBootedDevicesForPlatforms,
  resetBootedDevicesResourceCache,
  setDeviceLockProbe,
  setDeviceManager,
  setIosLockStateProbe,
  setOrientationReaderFactory,
} from "../../../src/server/bootedDeviceResources";

const ios: BootedDevice = {
  name: "iPhone 15 Pro",
  platform: "ios",
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  source: "local",
};
const android: BootedDevice = {
  name: "Pixel_7_API_34",
  platform: "android",
  deviceId: "PHYSICAL-ANDROID-1",
  source: "local",
};

describe("per-platform booted resource pool summary", () => {
  let utils: FakeDeviceUtils;

  beforeEach(() => {
    resetBootedDevicesResourceCache();
    utils = new FakeDeviceUtils();
    setDeviceManager(utils);
    setDeviceLockProbe(async () => ({ locked: false, keyguardShowing: false }));
    setIosLockStateProbe(async () => undefined);
    setOrientationReaderFactory(() => new FakeOrientationReader());
  });

  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
    setDeviceLockProbe(null);
    setIosLockStateProbe(null);
    setOrientationReaderFactory(null);
    setDeviceManager(null);
    resetBootedDevicesResourceCache();
  });

  test("automobile:devices/booted/ios poolStatus does not count the pool's android devices", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
    utils.setBootedDevices("ios", [ios]);
    utils.setBootedDevices("android", [android]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "platform-summary", {
        timer,
        deviceManager: utils,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    await pool.initializeWithDevices([ios, android]);
    DaemonState.getInstance().initialize(sessions, pool);
    try {
      const result = await getBootedDevicesForPlatforms(["ios"], timer);
      expect(result.devices.map((device) => device.runtime.deviceId)).toEqual([ios.deviceId]);
      // The resource lists one iOS device; its pool summary must describe that platform only.
      expect(result.poolStatus?.total).toBe(1);
    } finally {
      sessions.stopCleanupTimer();
    }
  });
});

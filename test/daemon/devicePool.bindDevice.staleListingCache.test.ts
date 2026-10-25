import { describe, expect, test } from "bun:test";
import type { BootedDevice, SomePlatform } from "../../src/models";
import type {
  BootedDeviceDiscovery,
  BootedDeviceDiscoveryOptions,
} from "../../src/devices/deviceUtils";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { useSessionIdleWindowForSuite } from "../helpers/sessionIdleWindowEnv";
import {
  createBootedDevice,
  createDevicePoolFor,
  createDevicePoolSuite,
} from "../helpers/devicePoolSuite";

useSessionIdleWindowForSuite();

/**
 * A device manager whose iOS listing is served from a short-lived snapshot (as
 * `SimCtlInventory`'s 5 s deviceListCache is) unless the caller opts out with
 * `bypassIosDeviceListCache`. `snapshot` is what the cache captured before the boot.
 */
class SnapshotCachedIosManager extends FakeDeviceManager {
  snapshot: BootedDevice[] | undefined;
  readonly iosOptions: Array<BootedDeviceDiscoveryOptions | undefined> = [];

  override async getBootedDevicesDetailed(
    platform: SomePlatform,
    options?: BootedDeviceDiscoveryOptions,
  ): Promise<BootedDeviceDiscovery> {
    if (platform !== "ios") {
      return super.getBootedDevicesDetailed(platform);
    }
    this.iosOptions.push(options);
    if (options?.bypassIosDeviceListCache || this.snapshot === undefined) {
      return super.getBootedDevicesDetailed(platform);
    }
    const live = this.bootedDevices;
    this.bootedDevices = this.snapshot;
    try {
      return await super.getBootedDevicesDetailed(platform);
    } finally {
      this.bootedDevices = live;
    }
  }
}

function setup() {
  const suite = createDevicePoolSuite();
  const manager = new SnapshotCachedIosManager();
  const devicePool = createDevicePoolFor({
    sessionManager: suite.sessionManager,
    fakeTimer: suite.fakeTimer,
    fakeAppsRepo: suite.fakeAppsRepo,
    fakeDeviceManager: manager,
  });
  return { devicePool, manager, sessionManager: suite.sessionManager };
}

describe("DevicePool bind of a just-booted iOS simulator (#15295)", () => {
  test("binds a clone that booted inside the simulator-list cache window", async () => {
    const { devicePool, manager, sessionManager } = setup();
    try {
      const clone = createBootedDevice("clone-udid", "ios", "r6a2-clone-2");
      // The mapped listing taken before the boot saw the clone Shutdown, and is still cached
      // when a fast (1.5 s) boot finishes; the live simulator list now reports it Booted.
      manager.snapshot = [];
      manager.bootedDevices = [clone];

      const sessionId = await devicePool.bindOrReuseDeviceSession({
        sessionId: "session-1",
        deviceId: "clone-udid",
        platform: "ios",
      });

      expect(sessionId).toBe("session-1");
      expect(devicePool.getDevice("clone-udid")?.sessionId).toBe("session-1");
      expect(
        manager.iosOptions.every((options) => options?.bypassIosDeviceListCache === true),
      ).toBe(true);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });
});

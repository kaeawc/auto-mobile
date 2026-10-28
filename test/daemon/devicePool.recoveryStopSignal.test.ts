import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import type {
  VirtualDeviceLifecycleCoordinator,
  VirtualDeviceLifecycleLease,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { BootedDevice, DeviceInfo, SomePlatform } from "../../src/models";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { makePool } from "../helpers/makePool";

// #15671: the recovery lease's signal reaches the emulator-shutdown confirmation through
// explicit parameters (coordinator -> pool port -> recovery part -> emulator lifecycle). A
// lease cancelled while that shutdown is being confirmed must stop the recovery before it
// relaunches the AVD.

const original: BootedDevice = {
  name: "Pixel_8_API_35",
  platform: "android",
  deviceId: "emulator-5554",
};
const image: DeviceInfo = {
  name: original.name,
  platform: "android",
  isRunning: true,
  source: "local",
};

/** One recovery lease whose signal the test owns. */
class ControlledLifecycleCoordinator implements VirtualDeviceLifecycleCoordinator {
  readonly controller = new AbortController();

  isReserved(): boolean {
    return false;
  }

  async reserve(
    identity: VirtualDeviceLifecycleLease["identity"],
  ): Promise<VirtualDeviceLifecycleLease> {
    return {
      signal: this.controller.signal,
      identity,
      bindCanonicalIdentity: async () => {},
      transitionToTeardown: () => {},
      release: () => {},
    };
  }
}

class RecoveryManager extends FakeDeviceManager {
  /** Runs inside each uncached discovery, i.e. while the shutdown is being confirmed. */
  onUncachedDiscovery: (() => void) | undefined;

  override async getBootedDevicesDetailed(
    platform: SomePlatform,
    options?: { bypassAndroidDeviceListCache?: boolean },
  ): Promise<BootedDeviceDiscovery> {
    if (options?.bypassAndroidDeviceListCache) {
      this.onUncachedDiscovery?.();
    }
    return super.getBootedDevicesDetailed(platform);
  }

  override async startDevice(device: DeviceInfo): Promise<ChildProcess> {
    this.startedDevices.push(device);
    this.bootedDevices = [original];
    return new FakeChildProcess();
  }

  override async waitForDeviceReady(): Promise<BootedDevice> {
    return original;
  }
}

async function recoverAfterLoss(cancelDuringShutdown: boolean) {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  const manager = new RecoveryManager();
  const lifecycle = new ControlledLifecycleCoordinator();
  const pool = makePool(sessions, "daemon", {
    timer,
    deviceManager: manager,
    lifecycleCoordinator: lifecycle,
    recoveryPolicy: { onLoss: true, maxAttempts: 1 },
  });
  try {
    manager.bootedDevices = [original];
    await pool.addDevice(original, image);
    await pool.bindOrReuseDeviceSession({
      sessionId: "session",
      deviceId: original.deviceId,
      platform: "android",
      sourceImage: image,
      expectedIdentity: original,
    });
    const captured = pool.getDevice(original.deviceId)!;
    // The tracked launcher already exited, so recovery confirms the AVD's shutdown by discovery.
    const exited = new FakeChildProcess();
    exited.exitCode = 1;
    pool.testHooks.startedDeviceProcesses.set(original.deviceId, exited);
    manager.bootedDevices = [];
    if (cancelDuringShutdown) {
      manager.onUncachedDiscovery = () =>
        lifecycle.controller.abort(new Error("recovery cancelled"));
    }

    const outcome = await pool
      .recoverSessionBoundAndroidDeviceAfterLoss(original.deviceId, undefined, captured)
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error: error instanceof Error ? error.name : String(error) }),
      );
    return { outcome, relaunches: manager.startedDevices.map((device) => device.name) };
  } finally {
    sessions.stopCleanupTimer();
  }
}

test("a recovery cancelled while confirming the AVD shutdown does not relaunch it", async () => {
  // The unconfirmed shutdown quarantines the AVD: recovery defers instead of relaunching.
  expect(await recoverAfterLoss(true)).toEqual({
    outcome: { result: "deferred" },
    relaunches: [],
  });
});

test("an uncancelled recovery confirms the shutdown and relaunches as before", async () => {
  expect(await recoverAfterLoss(false)).toEqual({
    outcome: { result: "recovered" },
    relaunches: [original.name],
  });
});

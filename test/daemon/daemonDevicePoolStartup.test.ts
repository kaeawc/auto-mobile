import { afterEach, describe, expect, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { BootedDevice, SomePlatform } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeTimer } from "../fakes/FakeTimer";

interface DaemonStartupInternals {
  devicePool: DevicePool;
  initializeDevicePoolWithTimeout(timeoutMs: number): Promise<void>;
}

class DeferredDiscoveryDeviceManager extends FakeDeviceManager {
  private discoveryStarted = false;
  private readonly started = Promise.withResolvers<void>();
  private readonly release = Promise.withResolvers<void>();

  override async getBootedDevicesDetailed(platform: SomePlatform) {
    this.discoveryStarted = true;
    this.started.resolve();
    await this.release.promise;
    return await super.getBootedDevicesDetailed(platform);
  }

  waitForDiscoveryStart(): Promise<void> {
    return this.started.promise;
  }

  hasStartedDiscovery(): boolean {
    return this.discoveryStarted;
  }

  releaseDiscovery(): void {
    this.release.resolve();
  }

}

class FakeDeviceSessionRepository extends DeviceSessionRepository {
  override async upsertActiveSession(): Promise<void> {}
}

function buildDaemon(timer: FakeTimer): Daemon {
  return new Daemon(
    {},
    new FakeInstalledAppsRepository(),
    timer,
    new FakeDeviceSessionRepository(),
    new CountingIdGenerator("daemon-session"),
    new FakeDatabaseInitializer(),
    new FakeStartupFailureTracker(),
  );
}

describe("Daemon startup device discovery", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("does not overwrite a live assignment when timed-out discovery finishes later", async () => {
    const timer = new FakeTimer();
    const daemon = buildDaemon(timer);
    const internals = daemon as unknown as DaemonStartupInternals;
    const manager = new DeferredDiscoveryDeviceManager();
    const device: BootedDevice = { deviceId: "android-device-1", name: "Pixel 8", platform: "android" };
    const lateDevice: BootedDevice = { deviceId: "android-device-2", name: "Pixel 9", platform: "android" };
    manager.bootedDevices = [device, lateDevice];
    (internals.devicePool as unknown as { deviceManager: DeferredDiscoveryDeviceManager }).deviceManager = manager;
    const refreshCompleted = Promise.withResolvers<void>();
    const originalRefresh = internals.devicePool.refreshDevices.bind(internals.devicePool);
    internals.devicePool.refreshDevices = async () => {
      const added = await originalRefresh();
      refreshCompleted.resolve();
      return added;
    };

    const startup = internals.initializeDevicePoolWithTimeout(5_000);
    await Promise.resolve();
    expect(manager.hasStartedDiscovery()).toBe(true);
    await manager.waitForDiscoveryStart();

    timer.advanceTime(5_000);
    await startup;

    await internals.devicePool.initializeWithDevices([device]);
    const assignedBeforeLateDiscovery = internals.devicePool.getDevice(device.deviceId);
    if (!assignedBeforeLateDiscovery) {
      throw new Error("expected startup device in pool");
    }
    await internals.devicePool.assignDeviceToSession("live-session", "android");
    expect(assignedBeforeLateDiscovery).toMatchObject({
      sessionId: "live-session",
      status: "busy",
    });
    const incarnation = assignedBeforeLateDiscovery?.incarnation;

    manager.releaseDiscovery();
    await refreshCompleted.promise;

    expect(internals.devicePool.getDevice(device.deviceId)).toMatchObject({
      sessionId: "live-session",
      status: "busy",
      incarnation,
    });
    expect(internals.devicePool.getDevice(lateDevice.deviceId)).toMatchObject({
      sessionId: null,
      status: "idle",
    });
  });
});

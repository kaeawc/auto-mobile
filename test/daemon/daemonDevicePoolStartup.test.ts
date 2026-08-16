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
  private readonly completed = Promise.withResolvers<void>();

  override async getBootedDevicesDetailed(platform: SomePlatform) {
    this.discoveryStarted = true;
    this.started.resolve();
    await this.release.promise;
    const discovery = await super.getBootedDevicesDetailed(platform);
    this.completed.resolve();
    return discovery;
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

  waitForDiscoveryCompletion(): Promise<void> {
    return this.completed.promise;
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
    manager.bootedDevices = [device];
    (internals.devicePool as unknown as { deviceManager: DeferredDiscoveryDeviceManager }).deviceManager = manager;

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
    await manager.waitForDiscoveryCompletion();
    await Promise.resolve();
    await Promise.resolve();

    expect(internals.devicePool.getDevice(device.deviceId)).toMatchObject({
      sessionId: "live-session",
      status: "busy",
      incarnation,
    });
  });
});

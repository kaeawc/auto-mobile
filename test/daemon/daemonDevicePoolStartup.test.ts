import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV } from "../../src/daemon/liveAcceptanceCapability";
import type { BootedDevice, SomePlatform } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { DeviceSessionManager } from "../../src/utils/DeviceSessionManager";
import { IosCtrlProxyBuilder } from "../../src/utils/IosCtrlProxyBuilder";
import { IOSCtrlProxyManager } from "../../src/utils/IOSCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeTimer } from "../fakes/FakeTimer";

interface DaemonStartupInternals {
  devicePool: DevicePool;
  initializeDevicePoolWithTimeout(timeoutMs: number): Promise<void>;
  initializeIosServices(): Promise<void>;
}

class DeferredDiscoveryDeviceManager extends FakeDeviceManager {
  private discoveryStarted = false;
  private readonly started = Promise.withResolvers<void>();
  private readonly release = Promise.withResolvers<void>();

  private discoveryCount = 0;

  override async getBootedDevicesDetailed(platform: SomePlatform) {
    this.discoveryStarted = true;
    this.started.resolve();
    this.discoveryCount++;
    // Only the FIRST discovery is the deferred startup one. Later callers (the
    // pool re-proving an idle entry present before it is assigned) must not be
    // parked behind it, the way a real adb would not be.
    if (this.discoveryCount === 1) {
      await this.release.promise;
    }
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

  test("iOS pool removal suspends and stops its manager; reappearance rearms lazily", async () => {
    const timer = new FakeTimer();
    const daemon = buildDaemon(timer);
    const pool = (daemon as unknown as DaemonStartupInternals).devicePool;
    const manager = new FakeIOSCtrlProxyManager(timer);
    const managerLookup = spyOn(IOSCtrlProxyManager, "getExistingInstance").mockReturnValue(
      manager as unknown as IOSCtrlProxyManager,
    );
    const device: BootedDevice = {
      deviceId: "00000000-0000-0000-0000-000000007676",
      name: "iPhone",
      platform: "ios",
    };
    try {
      await pool.initializeWithDevices([device]);
      await pool.removeDevice(device.deviceId);
      await Promise.resolve();
      expect(manager.getForcedRestartBudget().snapshot().state).toBe("suspended");
      expect(manager.getCallCount("suspendForDeviceRemoval")).toBe(1);
      expect(manager.getCallCount("stop")).toBe(1);

      await pool.addDevice(device);
      await Promise.resolve();
      expect(manager.getForcedRestartBudget().snapshot().state).toBe("idle");
      expect(manager.getCallCount("rearmAfterDeviceReappearance")).toBeGreaterThanOrEqual(1);
      expect(manager.getCallCount("start")).toBe(0);
    } finally {
      managerLookup.mockRestore();
    }
  });

  test("does not overwrite a live assignment when timed-out discovery finishes later", async () => {
    const timer = new FakeTimer();
    const daemon = buildDaemon(timer);
    const internals = daemon as unknown as DaemonStartupInternals;
    const manager = new DeferredDiscoveryDeviceManager();
    const device: BootedDevice = {
      deviceId: "android-device-1",
      name: "Pixel 8",
      platform: "android",
    };
    const lateDevice: BootedDevice = {
      deviceId: "android-device-2",
      name: "Pixel 9",
      platform: "android",
    };
    manager.bootedDevices = [device, lateDevice];
    (
      internals.devicePool as unknown as { deviceManager: DeferredDiscoveryDeviceManager }
    ).deviceManager = manager;
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

  test("a configured acceptance secret skips pool-wide iOS CtrlProxy warm-up", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const getInstanceSpy = spyOn(DeviceSessionManager, "getInstance");
    try {
      for (const secret of ["live-acceptance-startup-secret-012345678901234567890", "short", ""]) {
        process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = secret;
        const daemon = buildDaemon(new FakeTimer());
        const internals = daemon as unknown as DaemonStartupInternals;
        await internals.devicePool.initializeWithDevices([
          {
            deviceId: "unrelated-simulator",
            name: "Unrelated iPhone",
            platform: "ios",
          },
        ]);
        await internals.initializeIosServices();
      }
      expect(getInstanceSpy).not.toHaveBeenCalled();
    } finally {
      getInstanceSpy.mockRestore();
      if (previousSecret === undefined) {
        delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
      } else {
        process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = previousSecret;
      }
    }
  });

  test("iOS startup warm-up respects the explicit device allowlist", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const previousAllowlist = process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
    delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const verifiedDeviceIds: string[] = [];
    const getInstanceSpy = spyOn(DeviceSessionManager, "getInstance").mockReturnValue({
      verifyIosDevice: async (deviceId: string) => {
        verifiedDeviceIds.push(deviceId);
      },
    } as unknown as DeviceSessionManager);
    const pendingPrefetchSpy = spyOn(IosCtrlProxyBuilder, "pendingPrefetch").mockReturnValue(null);
    try {
      for (const allowlist of [" sim-a, missing, sim-a ", ""]) {
        process.env.AUTOMOBILE_IOS_WARMUP_DEVICES = allowlist;
        const daemon = buildDaemon(new FakeTimer());
        const internals = daemon as unknown as DaemonStartupInternals;
        await internals.devicePool.initializeWithDevices([
          { deviceId: "sim-a", name: "First iPhone", platform: "ios" },
          { deviceId: "sim-b", name: "Second iPhone", platform: "ios" },
          { deviceId: "android-a", name: "Pixel", platform: "android" },
        ]);
        await internals.initializeIosServices();
      }
      expect(verifiedDeviceIds).toEqual(["sim-a"]);
    } finally {
      pendingPrefetchSpy.mockRestore();
      getInstanceSpy.mockRestore();
      if (previousSecret === undefined) {
        delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
      } else {
        process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = previousSecret;
      }
      if (previousAllowlist === undefined) {
        delete process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
      } else {
        process.env.AUTOMOBILE_IOS_WARMUP_DEVICES = previousAllowlist;
      }
    }
  });

  test("ordinary daemon startup still warms discovered iOS devices", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const verifiedDeviceIds: string[] = [];
    const getInstanceSpy = spyOn(DeviceSessionManager, "getInstance").mockReturnValue({
      verifyIosDevice: async (deviceId: string) => {
        verifiedDeviceIds.push(deviceId);
      },
    } as unknown as DeviceSessionManager);
    const pendingPrefetchSpy = spyOn(IosCtrlProxyBuilder, "pendingPrefetch").mockReturnValue(null);
    try {
      const daemon = buildDaemon(new FakeTimer());
      const internals = daemon as unknown as DaemonStartupInternals;
      await internals.devicePool.initializeWithDevices([
        {
          deviceId: "ordinary-simulator",
          name: "Ordinary iPhone",
          platform: "ios",
        },
      ]);

      await internals.initializeIosServices();

      expect(verifiedDeviceIds).toEqual(["ordinary-simulator"]);
    } finally {
      pendingPrefetchSpy.mockRestore();
      getInstanceSpy.mockRestore();
      if (previousSecret === undefined) {
        delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
      } else {
        process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = previousSecret;
      }
    }
  });

  test("daemon shutdown stops warm-up before verifying the next iOS device", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const verifiedDeviceIds: string[] = [];
    let daemon: Daemon;
    const getInstanceSpy = spyOn(DeviceSessionManager, "getInstance").mockReturnValue({
      verifyIosDevice: async (deviceId: string) => {
        verifiedDeviceIds.push(deviceId);
        (daemon as unknown as { shutdownInProgress: boolean }).shutdownInProgress = true;
      },
    } as unknown as DeviceSessionManager);
    const pendingPrefetchSpy = spyOn(IosCtrlProxyBuilder, "pendingPrefetch").mockReturnValue(null);
    try {
      daemon = buildDaemon(new FakeTimer());
      const internals = daemon as unknown as DaemonStartupInternals;
      await internals.devicePool.initializeWithDevices([
        { deviceId: "first-simulator", name: "First iPhone", platform: "ios" },
        { deviceId: "second-simulator", name: "Second iPhone", platform: "ios" },
      ]);

      await internals.initializeIosServices();

      expect(verifiedDeviceIds).toEqual(["first-simulator"]);
    } finally {
      pendingPrefetchSpy.mockRestore();
      getInstanceSpy.mockRestore();
      if (previousSecret === undefined) {
        delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
      } else {
        process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = previousSecret;
      }
    }
  });
});

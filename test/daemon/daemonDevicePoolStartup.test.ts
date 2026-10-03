import { FakeDeviceSessionRepository } from "../fakes/FakeDeviceSessionRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { DevicePool } from "../../src/daemon/devicePool";
import { DaemonState } from "../../src/daemon/daemonState";
import { DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV } from "../../src/daemon/liveAcceptanceCapability";
import type { BootedDevice, SomePlatform } from "../../src/models";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { DeviceSessionManager } from "../../src/utils/DeviceSessionManager";
import { IosCtrlProxyBuilder } from "../../src/ctrlProxy/IosCtrlProxyBuilder";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeDatabaseInitializer } from "../fakes/FakeDatabaseInitializer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeStartupFailureTracker } from "../fakes/FakeStartupFailureTracker";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import * as appearanceSyncScheduler from "../../src/daemon/AppearanceSyncScheduler";

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

  test("an Android session syncs its device, and the iOS startup secret does not change that", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const previousSync = process.env.AUTOMOBILE_APPEARANCE_SYNC;
    const previousAllowlist = process.env.AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES;
    const sync = spyOn(appearanceSyncScheduler, "syncAppearanceForDevice").mockResolvedValue(
      undefined,
    );
    delete process.env.AUTOMOBILE_APPEARANCE_SYNC;
    delete process.env.AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES;
    try {
      for (const secret of [undefined, "live-acceptance-startup-secret-012345678901234567890"]) {
        if (secret === undefined) {
          delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
        } else {
          process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = secret;
        }
        const daemon = buildDaemon(new FakeTimer());
        const pool = (daemon as unknown as DaemonStartupInternals).devicePool;
        try {
          await pool.initializeWithDevices([
            { deviceId: "android-a", name: "Pixel A", platform: "android" },
            { deviceId: "android-b", name: "Pixel B", platform: "android" },
          ]);
          await daemon.getSessionManager().createSession("session-a", "android-a", "android");
          expect(sync).toHaveBeenCalledTimes(1);
          expect(sync.mock.calls[0]?.[0]).toMatchObject({ deviceId: "android-a" });
          expect(sync).not.toHaveBeenCalledWith(expect.objectContaining({ deviceId: "android-b" }));
        } finally {
          daemon.getSessionManager().stopCleanupTimer();
          sync.mockClear();
        }
      }
    } finally {
      sync.mockRestore();
      if (previousSecret === undefined) {
        delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
      } else {
        process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV] = previousSecret;
      }
      if (previousSync === undefined) {
        delete process.env.AUTOMOBILE_APPEARANCE_SYNC;
      } else {
        process.env.AUTOMOBILE_APPEARANCE_SYNC = previousSync;
      }
      if (previousAllowlist === undefined) {
        delete process.env.AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES;
      } else {
        process.env.AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES = previousAllowlist;
      }
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

  test("ordinary startup leaves unowned discovered iOS devices cold", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const previousAllowlist = process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
    delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    delete process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
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

      expect(verifiedDeviceIds).toEqual([]);
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

  test("rehydrated iOS session gets a runner after recovery without an allowlist", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const previousAllowlist = process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
    delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    delete process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    await persistence.upsertActiveSession({
      sessionUuid: "restored-ios-session",
      deviceId: "owned-simulator",
      stableDeviceId: "owned-simulator",
      platform: "ios",
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 60_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: true,
    });
    await persistence.markReleased("restored-ios-session", "released", 0, "daemon-restart");
    const verifiedDeviceIds: string[] = [];
    const getInstanceSpy = spyOn(DeviceSessionManager, "getInstance").mockReturnValue({
      verifyIosDevice: async (deviceId: string) => {
        verifiedDeviceIds.push(deviceId);
      },
    } as unknown as DeviceSessionManager);
    const pendingPrefetchSpy = spyOn(IosCtrlProxyBuilder, "pendingPrefetch").mockReturnValue(null);
    const daemon = new Daemon(
      {},
      new FakeInstalledAppsRepository(),
      timer,
      persistence as unknown as DeviceSessionRepository,
      new CountingIdGenerator("daemon-session"),
      new FakeDatabaseInitializer(),
      new FakeStartupFailureTracker(),
    );
    const internals = daemon as unknown as DaemonStartupInternals;
    const bootedDevices: BootedDevice[] = [
      { deviceId: "owned-simulator", name: "Owned iPhone", platform: "ios" },
      { deviceId: "foreign-simulator", name: "Foreign iPhone", platform: "ios" },
    ];
    try {
      await internals.devicePool.initializeWithDevices(bootedDevices);
      await internals.initializeIosServices();
      expect(verifiedDeviceIds).toEqual([]);

      const sessions = daemon.getSessionManager();
      const summary = await sessions.rehydratePersistedSessions({
        assignDeviceToSession: async (sessionId, _platform, target) => {
          const session = await sessions.createSession(
            sessionId,
            "owned-simulator",
            "ios",
            target?.liveness?.sessionTimeoutMs,
            target?.liveness?.heartbeatTimeoutMs,
            target?.stableDeviceId,
            target?.liveness,
            target?.initialOwnership,
          );
          return session.assignedDevice;
        },
      });
      expect(summary.rehydrated).toEqual(["restored-ios-session"]);
      await internals.initializeIosServices();
      expect(verifiedDeviceIds).toEqual(["owned-simulator"]);
    } finally {
      daemon.getSessionManager().stopCleanupTimer();
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

  test("daemon shutdown stops warm-up before verifying the next iOS device", async () => {
    const previousSecret = process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    const previousAllowlist = process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
    delete process.env[DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET_ENV];
    process.env.AUTOMOBILE_IOS_WARMUP_DEVICES = "first-simulator,second-simulator";
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
      if (previousAllowlist === undefined) {
        delete process.env.AUTOMOBILE_IOS_WARMUP_DEVICES;
      } else {
        process.env.AUTOMOBILE_IOS_WARMUP_DEVICES = previousAllowlist;
      }
    }
  });
});

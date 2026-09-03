import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { createToolExecutionContext } from "../../src/server/ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { KeepScreenAwakeManager } from "../../src/utils/KeepScreenAwakeManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";

describe("ToolExecutionContext", () => {
  let sessionManager: SessionManager;
  let devicePool: DevicePool;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeTimer: FakeTimer;
  let fakeDeviceManager: FakeDeviceManager;
  let originalGetInstance: typeof AndroidCtrlProxyManager.getInstance;
  let originalClientGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  const sessionOptions = { keepScreenAwake: false };
  const createBootedDevice = (deviceId: string): BootedDevice => ({
    name: deviceId,
    platform: "android",
    deviceId,
  });

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    fakeAppsRepo = new FakeInstalledAppsRepository();
    fakeDeviceManager = new FakeDeviceManager();
    devicePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      fakeAppsRepo,
      fakeDeviceManager,
    );
    await devicePool.initializeWithDevices([createBootedDevice("device-1")]);
    originalGetInstance = AndroidCtrlProxyManager.getInstance;
    originalClientGetInstance = AndroidCtrlProxyClient.getInstance;

    // Reset AndroidCtrlProxyClient instances for clean test state
    AndroidCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
    AndroidCtrlProxyManager.getInstance = originalGetInstance;
    AndroidCtrlProxyClient.getInstance = originalClientGetInstance;
    AndroidCtrlProxyClient.resetInstances();
  });

  test("should run accessibility setup when creating a new session", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    const clientCallArgs: unknown[] = [];
    AndroidCtrlProxyClient.getInstance = ((device: unknown) => {
      clientCallArgs.push(device);
      return {
        waitForConnection: async () => true,
        close: async () => {},
      };
    }) as any;

    const context = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(1);
    expect(clientCallArgs.length).toBeGreaterThan(0);
    const passed = clientCallArgs[0] as BootedDevice;
    expect(typeof passed).toBe("object");
    expect(passed.deviceId).toBe("device-1");
    expect(passed.platform).toBe("android");
  });

  test("does not run accessibility setup when a pooled emulator serial is stale", async () => {
    const staleDeviceManager = new FakeDeviceManager();
    const stalePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      fakeAppsRepo,
      staleDeviceManager,
    );
    await stalePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
    staleDeviceManager.bootedDevices = [];

    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    await expect(
      createToolExecutionContext("session-stale", sessionManager, stalePool, sessionOptions),
    ).rejects.toThrow(/No devices in pool|not available|disconnected/);
    expect(setupCalls).toBe(0);
    expect(stalePool.getDevice("emulator-5554")).toBeNull();
  });

  test("writes the keep-awake state to the typed keepScreenAwake slot on setup (#2973)", async () => {
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => ({ success: true, message: "ok" }),
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    // keepScreenAwake:false → apply() short-circuits to an applied:false state,
    // which ensureKeepScreenAwake must persist to the typed slot (not customData).
    await createToolExecutionContext("session-1", sessionManager, devicePool, sessionOptions);

    const state = sessionManager.getKeepScreenAwake("session-1");
    expect(state).toBeDefined();
    expect(state!.applied).toBe(false);
    expect(
      (sessionManager.getSessionCache("session-1") as Record<string, unknown>).customData,
    ).toBeUndefined();
  });

  test("should not run accessibility setup for existing sessions", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;

    await sessionManager.createSession("session-1", "device-1", "android");
    const context = await createToolExecutionContext(
      "session-1",
      sessionManager,
      devicePool,
      sessionOptions,
    );

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
  });

  test("does not recreate an admitted session released before setup", async () => {
    const admittedSession = await sessionManager.createSession("session-1", "device-1", "android");
    await sessionManager.releaseSession("session-1", "explicit-release");

    await expect(
      createToolExecutionContext(
        "session-1",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        admittedSession,
      ),
    ).rejects.toThrow("Session session-1 was released during setup");
    expect(sessionManager.getSession("session-1")).toBeNull();
  });

  test("quarantines preserved reset-cohort session routing until recovery settles", async () => {
    const first: BootedDevice = {
      name: "Pixel_8_API_35",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const second: BootedDevice = {
      name: "Pixel_9_API_36",
      platform: "android",
      deviceId: "emulator-5556",
    };
    const image = (device: BootedDevice): DeviceInfo => ({
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    });
    fakeDeviceManager.bootedDevices = [first, second];
    await devicePool.addDevice(first, image(first));
    await devicePool.addDevice(second, image(second));
    await devicePool.bindOrReuseDeviceSession(
      "reset-session-1",
      first.deviceId,
      "android",
      image(first),
    );
    await devicePool.bindOrReuseDeviceSession(
      "reset-session-2",
      second.deviceId,
      "android",
      image(second),
    );
    const detached = await devicePool.detachAdbServerResetCohort([
      devicePool.getDevice(first.deviceId)!,
      devicePool.getDevice(second.deviceId)!,
    ]);

    try {
      await expect(
        createToolExecutionContext("reset-session-2", sessionManager, devicePool, sessionOptions),
      ).rejects.toThrow(/device-disconnected:emulator-5556;incident=/);
    } finally {
      await devicePool.releaseAdbServerResetCohortReservations(detached.devices);
    }

    expect(() => devicePool.assertSessionReadyForAutomation("reset-session-2")).toThrow(
      /device-disconnected:emulator-5556;incident=/,
    );
    await sessionManager.releaseSession("reset-session-2", "explicit-release");
    expect(() => devicePool.assertSessionReadyForAutomation("reset-session-2")).not.toThrow();
  });

  test("retains an implicit autolock mapping while its reset cohort is quarantined", async () => {
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const device: BootedDevice = {
      name: "Pixel_8_API_35",
      platform: "android",
      deviceId: "emulator-5554",
    };
    const image: DeviceInfo = {
      name: device.name,
      platform: "android",
      isRunning: true,
      source: "local",
    };
    fakeDeviceManager.bootedDevices = [device];
    await devicePool.addDevice(device, image);
    const sessionId = await devicePool.autolockDevice(
      device.deviceId,
      "android",
      "mcp-session",
      image,
    );
    const detached = await devicePool.detachAdbServerResetCohort([
      devicePool.getDevice(device.deviceId)!,
    ]);

    try {
      expect(devicePool.resolveAutolockSessionForMcpSession("mcp-session", "android")).toBe(
        sessionId,
      );
      await expect(
        createToolExecutionContext(sessionId, sessionManager, devicePool, sessionOptions),
      ).rejects.toThrow(/device-disconnected:emulator-5554;incident=/);
      expect(devicePool.resolveAutolockSessionForMcpSession("mcp-session", "android")).toBe(
        sessionId,
      );
    } finally {
      await devicePool.releaseAdbServerResetCohortReservations(detached.devices);
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    }
  });

  test("runs first-session setup when a released UUID is recreated during context creation", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    const original = await sessionManager.createSession("session-recreated", "device-1", "android");
    let finishSetup!: () => void;
    const setup = sessionManager.trackSessionSetup(
      original,
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    );
    const release = sessionManager.releaseSession("session-recreated");
    await Promise.resolve();
    const context = createToolExecutionContext(
      "session-recreated",
      sessionManager,
      devicePool,
      sessionOptions,
    );
    finishSetup();
    await setup;
    await release;

    await expect(context).resolves.toMatchObject({ deviceId: "device-1" });
    expect(setupCalls).toBe(1);
  });

  test("rejects an admitted session once its release begins", async () => {
    const session = await sessionManager.createSession("session-releasing", "device-1", "android");
    let finishSetup!: () => void;
    const setup = sessionManager.trackSessionSetup(
      session,
      () =>
        new Promise<void>((resolve) => {
          finishSetup = resolve;
        }),
    );
    const release = sessionManager.releaseSession("session-releasing");
    await Promise.resolve();

    await expect(
      createToolExecutionContext(
        "session-releasing",
        sessionManager,
        devicePool,
        sessionOptions,
        undefined,
        session,
      ),
    ).rejects.toThrow("released during setup");

    finishSetup();
    await setup;
    await release;
  });

  test("rechecks admission after setup releases its session", async () => {
    const session = await sessionManager.createSession("session-releasing", "device-1", "android");
    const trackSetup = spyOn(sessionManager, "trackSessionSetup").mockImplementation(
      async (trackedSession, setup) => {
        await setup();
        await sessionManager.releaseSession(trackedSession.sessionId, "explicit-release");
      },
    );

    try {
      await expect(
        createToolExecutionContext(
          "session-releasing",
          sessionManager,
          devicePool,
          sessionOptions,
          undefined,
          session,
        ),
      ).rejects.toThrow("released during setup");
    } finally {
      trackSetup.mockRestore();
    }
  });

  test("does not apply keep-awake after a session is released during setup", async () => {
    let allowActivityWrite!: () => void;
    const activityWrite = new Promise<void>((resolve) => {
      allowActivityWrite = resolve;
    });
    let activityStarted!: () => void;
    const activityStartedPromise = new Promise<void>((resolve) => {
      activityStarted = resolve;
    });
    const repository = {
      async upsertActiveSession(): Promise<void> {},
      async recordActivity(): Promise<void> {
        activityStarted();
        await activityWrite;
      },
      async markReleased(): Promise<void> {},
      async markStaleActiveSessionsExpired(): Promise<void> {},
    };
    const manager = new SessionManager(fakeTimer, repository);
    const pool = new DevicePool(
      manager,
      "test-daemon-session-id",
      fakeTimer,
      fakeAppsRepo,
      new FakeDeviceManager(),
    );
    const applySpy = spyOn(KeepScreenAwakeManager.prototype, "apply").mockResolvedValue({
      applied: false,
      skipReason: "disabled",
    });

    try {
      await pool.initializeWithDevices([createBootedDevice("device-race")]);
      await manager.createSession("session-race", "device-race", "android");

      const context = createToolExecutionContext("session-race", manager, pool, sessionOptions);
      await activityStartedPromise;
      await manager.releaseSession("session-race");
      allowActivityWrite();

      await expect(context).rejects.toThrow("released during setup");
      expect(applySpy).not.toHaveBeenCalled();
    } finally {
      applySpy.mockRestore();
      manager.stopCleanupTimer();
    }
  });

  test("bounds accessibility setup and rejects it after the session releases", async () => {
    const boundedTimer = new FakeTimer();
    const boundedSessionManager = new SessionManager(boundedTimer, {
      async upsertActiveSession(): Promise<void> {},
      async recordActivity(): Promise<void> {},
      async markReleased(): Promise<void> {},
      async markStaleActiveSessionsExpired(): Promise<void> {},
    });
    const boundedPool = new DevicePool(
      boundedSessionManager,
      "test-daemon-session-id",
      boundedTimer,
      fakeAppsRepo,
      new FakeDeviceManager(),
    );
    await boundedPool.initializeWithDevices([createBootedDevice("device-1")]);
    let finishSetup!: () => void;
    const setupFinished = new Promise<void>((resolve) => {
      finishSetup = resolve;
    });
    let setupStarted!: () => void;
    const setupStartedPromise = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupStarted();
          await setupFinished;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    try {
      const context = createToolExecutionContext(
        "session-setup-race",
        boundedSessionManager,
        boundedPool,
        sessionOptions,
      );
      await setupStartedPromise;
      const release = boundedSessionManager.releaseSession("session-setup-race");
      for (
        let attempt = 0;
        attempt < 10 && !boundedTimer.getPendingTimeouts().includes(1_000);
        attempt++
      ) {
        await Promise.resolve();
      }
      expect(boundedTimer.getPendingTimeouts()).toContain(1_000);
      boundedTimer.advanceTime(1_000);
      let releasedDevice: string | null | undefined;
      void release.then((deviceId) => {
        releasedDevice = deviceId;
      });
      for (let attempt = 0; attempt < 10 && releasedDevice === undefined; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(releasedDevice).toBe("device-1");
      await boundedPool.releaseDevice("device-1", "session-setup-race");

      expect(boundedSessionManager.getSession("session-setup-race")).toBeNull();
      expect(boundedPool.getDevice("device-1")).toMatchObject({
        sessionId: "session-setup-race",
        status: "busy",
      });

      finishSetup();
      await expect(context).rejects.toThrow("released during setup");
      await Promise.resolve();
      expect(boundedPool.getDevice("device-1")).toMatchObject({
        sessionId: null,
        status: "idle",
      });
    } finally {
      boundedSessionManager.stopCleanupTimer();
    }
  });
});

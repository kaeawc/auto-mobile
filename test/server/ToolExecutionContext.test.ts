import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { createToolExecutionContext } from "../../src/server/ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { KeepScreenAwakeManager } from "../../src/utils/KeepScreenAwakeManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { BootedDevice } from "../../src/models";

describe("ToolExecutionContext", () => {
  let sessionManager: SessionManager;
  let devicePool: DevicePool;
  let fakeAppsRepo: FakeInstalledAppsRepository;
  let fakeTimer: FakeTimer;
  let originalGetInstance: typeof AndroidCtrlProxyManager.getInstance;
  let originalClientGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  const sessionOptions = { keepScreenAwake: false };
  const createBootedDevice = (deviceId: string): BootedDevice => ({
    name: deviceId,
    platform: "android",
    deviceId
  });

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    sessionManager = new SessionManager(fakeTimer);
    fakeAppsRepo = new FakeInstalledAppsRepository();
    const fakeDeviceManager = new FakeDeviceManager();
    devicePool = new DevicePool(sessionManager, "test-daemon-session-id", fakeTimer, fakeAppsRepo, fakeDeviceManager);
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
        }
      } as any);

    const clientCallArgs: unknown[] = [];
    AndroidCtrlProxyClient.getInstance = ((device: unknown) => {
      clientCallArgs.push(device);
      return {
        waitForConnection: async () => true,
        close: async () => {}
      };
    }) as any;

    const context = await createToolExecutionContext("session-1", sessionManager, devicePool, sessionOptions);

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
    const stalePool = new DevicePool(sessionManager, "test-daemon-session-id", fakeTimer, fakeAppsRepo, staleDeviceManager);
    await stalePool.initializeWithDevices([createBootedDevice("emulator-5554")]);
    staleDeviceManager.bootedDevices = [];

    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        }
      } as any);

    await expect(createToolExecutionContext("session-stale", sessionManager, stalePool, sessionOptions))
      .rejects.toThrow(/No devices in pool|not available|disconnected/);
    expect(setupCalls).toBe(0);
    expect(stalePool.getDevice("emulator-5554")).toBeNull();
  });

  test("writes the keep-awake state to the typed keepScreenAwake slot on setup (#2973)", async () => {
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => ({ success: true, message: "ok" }),
      } as any);
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
    expect((sessionManager.getSessionCache("session-1") as Record<string, unknown>).customData).toBeUndefined();
  });

  test("should not run accessibility setup for existing sessions", async () => {
    let setupCalls = 0;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        }
      } as any);

    await sessionManager.createSession("session-1", "device-1", "android");
    const context = await createToolExecutionContext("session-1", sessionManager, devicePool, sessionOptions);

    expect(context.deviceId).toBe("device-1");
    expect(setupCalls).toBe(0);
  });

  test("does not apply keep-awake after a session is released during setup", async () => {
    let allowActivityWrite!: () => void;
    const activityWrite = new Promise<void>(resolve => { allowActivityWrite = resolve; });
    let activityStarted!: () => void;
    const activityStartedPromise = new Promise<void>(resolve => { activityStarted = resolve; });
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
    const pool = new DevicePool(manager, "test-daemon-session-id", fakeTimer, fakeAppsRepo, new FakeDeviceManager());
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
    let finishSetup!: () => void;
    const setupFinished = new Promise<void>(resolve => { finishSetup = resolve; });
    let setupStarted!: () => void;
    const setupStartedPromise = new Promise<void>(resolve => { setupStarted = resolve; });
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupStarted();
          await setupFinished;
          return { success: true, message: "ok" };
        },
      } as any);
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;

    const context = createToolExecutionContext("session-setup-race", sessionManager, devicePool, sessionOptions);
    await setupStartedPromise;
    void sessionManager.releaseSession("session-setup-race");
    await Promise.resolve();
    fakeTimer.advanceTime(1_000);
    await fakeTimer.sleep(0);

    expect(sessionManager.getSession("session-setup-race")).toBeNull();

    finishSetup();
    await expect(context).rejects.toThrow("released during setup");
  });
});

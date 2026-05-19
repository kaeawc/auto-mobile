import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { createToolExecutionContext } from "../../src/server/ToolExecutionContext";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
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
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import {
  DeviceSessionManager,
  DefaultDeviceClientProvider,
} from "../../src/devices/DeviceSessionManager";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreenCache } from "../fakes/FakeObserveScreenCache";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceCreationGate } from "../fakes/FakeDeviceCreationGate";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { FakeWindow } from "../fakes/FakeWindow";
import { BootedDevice, AppearanceConfigInput, ExecResult } from "../../src/models";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../../src/utils/runnerReadinessConfig";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AndroidCtrlProxy } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import type { IOSCtrlProxy } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { getAbortSignal } from "../../src/utils/AbortContext";
import type { HostChildProcess } from "../../src/utils/HostCommandExecutor";
import { EmulatorLaunchCancelledError } from "../../src/models/EmulatorLaunchCancelledError";
import {
  resetDeviceCreationGate,
  setDeviceCreationGate,
} from "../../src/devices/deviceCreationGate";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

function createTestSessionManager(
  ...[provider, adbFactory, options]: Parameters<typeof DeviceSessionManager.createInstance>
): DeviceSessionManager {
  return DeviceSessionManager.createInstance(provider, adbFactory, {
    ...options,
    appearanceOnConnectDependencies: { isSyncEnabled: () => true },
  });
}

// Inline minimal AndroidCtrlProxy where each test sets only the methods it
// exercises — the Android fake lacks per-call `waitForConnection` /
// `verifyServiceReady` toggles needed to cover the cache-stale and
// "connected but not responsive" branches independently.
function ipaBytes(): Buffer {
  // A real CtrlProxy .ipa is a zip over 10KB; the override guard validates
  // magic + size (#4221 review), so a usable-override fixture must be genuine.
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(11_000)]);
}

function stubAndroidCtrlProxy(overrides: Partial<AndroidCtrlProxy>): AndroidCtrlProxy {
  // resetConnectionBudget() (issue #7538) and terminateStaleConnection()
  // (issue #7554) are required DeviceService methods that most of these
  // per-test overrides don't care about; default them to no-ops so a test
  // exercising the enable/setup paths doesn't have to stub them just to
  // avoid an unhandled-method crash.
  return {
    resetConnectionBudget: () => {},
    terminateStaleConnection: () => {},
    ...overrides,
  } as unknown as AndroidCtrlProxy;
}

function stubIOSCtrlProxy(overrides: Partial<IOSCtrlProxy>): IOSCtrlProxy {
  return {
    resetConnectionBudget: () => {},
    terminateStaleConnection: () => {},
    ...overrides,
  } as unknown as IOSCtrlProxy;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 30; turn++) {
    await Promise.resolve();
  }
}

function makeReadyWindow(): FakeWindow {
  const w = new FakeWindow();
  w.configureActiveWindow({
    appId: "com.example.app",
    activityName: "MainActivity",
    layoutSeqSum: 0,
  });
  return w;
}

describe("DeviceSessionManager", () => {
  const device: BootedDevice = {
    name: "device-1",
    deviceId: "device-1",
    platform: "android",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakeWindow: FakeWindow;
  let originalAppearanceDefaults: AppearanceConfigInput;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeAdb.setDevices([device]);
    fakeWindow = makeReadyWindow();

    originalAppearanceDefaults = serverConfig.getAppearanceDefaults();
    serverConfig.setAppearanceDefaults({
      ...originalAppearanceDefaults,
      applyOnConnect: false,
      syncWithHost: false,
      defaultMode: "light",
    });
  });

  afterEach(() => {
    serverConfig.setAppearanceDefaults(originalAppearanceDefaults);
  });

  test("should skip accessibility download when requested and not installed", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(false);
    accessibilityManager.setEnabled(false);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({ isConnected: () => false }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1", { skipCtrlProxyDownload: true });

    expect(accessibilityManager.wasMethodCalled("setup")).toBe(false);
    expect(accessibilityManager.wasMethodCalled("enable")).toBe(false);
  });

  test("should enable accessibility when installed but disabled even when download is skipped", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(false);
    accessibilityManager.setVersionCompatible(true);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1", { skipCtrlProxyDownload: true });

    expect(accessibilityManager.wasMethodCalled("enable")).toBe(true);
    expect(accessibilityManager.wasMethodCalled("isVersionCompatible")).toBe(true);
    expect(accessibilityManager.wasMethodCalled("setup")).toBe(false);
  });

  test("should verify compatibility when download is skipped and service enabled", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);
    accessibilityManager.setVersionCompatible(true);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1", { skipCtrlProxyDownload: true });

    expect(accessibilityManager.wasMethodCalled("isVersionCompatible")).toBe(true);
    expect(accessibilityManager.wasMethodCalled("setup")).toBe(false);
  });

  test("should error on incompatible accessibility version when download is skipped", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);
    accessibilityManager.setVersionCompatible(false);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    await expect(
      manager.ensureDeviceReady("android", "device-1", { skipCtrlProxyDownload: true }),
    ).rejects.toThrow("Accessibility service version mismatch");
  });

  test("should run accessibility setup by default", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(false);
    accessibilityManager.setEnabled(false);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
        verifyServiceReady: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1");

    expect(accessibilityManager.wasMethodCalled("setup")).toBe(true);
  });

  test("verifyAndroidDevice rejects a failed CtrlProxy setup result", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
        verifyServiceReady: () => Promise.resolve(true),
      }),
    });

    const manager = createTestSessionManager(provider);
    for (const { result, reason } of [
      {
        result: { success: false, message: "Setup already attempted" },
        reason: "Setup already attempted",
      },
      {
        result: { success: false, message: "Setup failed", error: "Permission denied" },
        reason: "Permission denied",
      },
    ]) {
      accessibilityManager.setup = async () => result;
      await expect(manager.verifyAndroidDevice(device.deviceId)).rejects.toThrow(reason);
    }
  });

  test("verifyAndroidDevice resolves after successful CtrlProxy setup", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
        verifyServiceReady: () => Promise.resolve(true),
      }),
    });

    await expect(
      createTestSessionManager(provider).verifyAndroidDevice(device.deviceId),
    ).resolves.toBeUndefined();
    expect(accessibilityManager.getCallCount("setup")).toBe(1);
  });

  test("concurrent verifyAndroidDevice calls serialize CtrlProxy setup for one device", async () => {
    const firstSetup = deferred();
    const firstSetupStarted = deferred();
    const accessibilityManager = new FakeCtrlProxyManager();
    let setupCount = 0;
    let activeSetups = 0;
    let maxActiveSetups = 0;
    const events: string[] = [];
    accessibilityManager.setup = async () => {
      const call = ++setupCount;
      activeSetups++;
      maxActiveSetups = Math.max(maxActiveSetups, activeSetups);
      events.push(`start:${call}`);
      if (call === 1) {
        firstSetupStarted.resolve();
        await firstSetup.promise;
      }
      events.push(`end:${call}`);
      activeSetups--;
      return { success: true, message: "ready" };
    };
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
        verifyServiceReady: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    const first = manager.verifyAndroidDevice(device.deviceId);
    await firstSetupStarted.promise;
    const second = manager.verifyAndroidDevice(device.deviceId);
    try {
      await drainMicrotasks();
      expect(setupCount).toBe(1);
      expect(maxActiveSetups).toBe(1);
    } finally {
      firstSetup.resolve();
      await Promise.all([first, second]);
    }
    expect(events).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  test("concurrent verifyAndroidDevice calls can set up different devices", async () => {
    const otherDevice: BootedDevice = {
      name: "device-2",
      deviceId: "device-2",
      platform: "android",
    };
    fakeAdb.setDevices([device, otherDevice]);
    const firstSetup = deferred();
    const firstSetupStarted = deferred();
    let secondSetupStarted = false;
    const firstManager = new FakeCtrlProxyManager();
    firstManager.setup = async () => {
      firstSetupStarted.resolve();
      await firstSetup.promise;
      return { success: true, message: "ready" };
    };
    const secondManager = new FakeCtrlProxyManager();
    secondManager.setup = async () => {
      secondSetupStarted = true;
      return { success: true, message: "ready" };
    };
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: firstManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
        verifyServiceReady: () => Promise.resolve(true),
      }),
    });
    provider.getAndroidCtrlProxyManager = (target) =>
      target.deviceId === device.deviceId ? firstManager : secondManager;
    const manager = createTestSessionManager(provider);
    const first = manager.verifyAndroidDevice(device.deviceId);
    await firstSetupStarted.promise;
    const second = manager.verifyAndroidDevice(otherDevice.deviceId);
    try {
      await drainMicrotasks();
      expect(secondSetupStarted).toBe(true);
    } finally {
      firstSetup.resolve();
      await Promise.all([first, second]);
    }
  });

  test("booted Android readiness verifies the active window without initializing CtrlProxy", async () => {
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
    });
    const manager = createTestSessionManager(provider);

    await expect(
      manager.verifyAndroidDevice(device.deviceId, { readiness: "booted" }),
    ).resolves.toBeUndefined();

    expect(fakeWindow.wasMethodCalled("getActive")).toBe(true);
  });

  test("booted Android readiness bypasses stale active-window cache", async () => {
    fakeWindow.configureCachedActiveWindow({
      appId: "com.example.previous",
      activityName: "PreviousActivity",
      layoutSeqSum: 0,
    });
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
    });
    const manager = createTestSessionManager(provider);

    await expect(
      manager.verifyAndroidDevice(device.deviceId, { readiness: "booted" }),
    ).resolves.toBeUndefined();

    expect(fakeWindow.getGetActiveForceRefreshes()).toEqual([true]);
  });

  test("readiness reuses a resolved Window, replaces it for a new AVD, and retains it for raw serial evidence", async () => {
    const resolvedA: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel_8_API_35",
      platform: "android",
    };
    const resolvedB: BootedDevice = { ...resolvedA, name: "Pixel_7_API_34" };
    const raw = { ...resolvedA, name: resolvedA.deviceId };
    const createdFor: string[] = [];
    const factory: AdbClientFactory = {
      create(target) {
        if (target) {
          createdFor.push(target.name);
        }
        return fakeAdb;
      },
    };
    const dumpsysOutput =
      "imeControlTarget in display# 0 Window{12345678 u0 com.example.app/com.example.app.MainActivity}";
    fakeAdb.setDefaultResponse({
      stdout: dumpsysOutput,
      stderr: "",
      toString: () => dumpsysOutput,
      trim: () => dumpsysOutput.trim(),
      includes: (value: string) => dumpsysOutput.includes(value),
    } as ExecResult);
    fakeAdb.setDevices([resolvedA]);
    const provider = new DefaultDeviceClientProvider(factory);
    const manager = createTestSessionManager(provider);

    await manager.verifyAndroidDevice(resolvedA.deviceId, { readiness: "booted" });
    await manager.verifyAndroidDevice(resolvedA.deviceId, { readiness: "booted" });
    fakeAdb.setDevices([raw]);
    await manager.verifyAndroidDevice(raw.deviceId, { readiness: "booted" });
    fakeAdb.setDevices([resolvedB]);
    await manager.verifyAndroidDevice(resolvedB.deviceId, { readiness: "booted" });

    expect(createdFor).toEqual([resolvedA.name, resolvedB.name]);
  });

  test("booted Android readiness rejects a device whose UI has not finished booting", async () => {
    const notReadyWindow = new FakeWindow();
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: notReadyWindow,
    });
    const manager = createTestSessionManager(provider);

    await expect(
      manager.verifyAndroidDevice(device.deviceId, { readiness: "booted" }),
    ).rejects.toThrow("Failed to verify Android device device-1 readiness");
  });

  test("should skip setup when accessibility is already enabled and WebSocket connects", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1");

    // When installed, enabled, and WebSocket connects - service is working, no need for setup
    expect(accessibilityManager.wasMethodCalled("setup")).toBe(false);
  });

  test("should run setup when accessibility cache is stale (WebSocket fails)", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(false), // WebSocket fails - cache is stale
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1");

    // Cache was stale (claimed installed but WebSocket failed), so setup should run
    expect(accessibilityManager.wasMethodCalled("resetSetupState")).toBe(true);
    expect(accessibilityManager.wasMethodCalled("setup")).toBe(true);
  });

  // Issue #7538: on the stale-cache path, the first waitForConnection(3, 200)
  // exhausts the client's connection-attempt budget. If verifyAndroidDevice's
  // post-setup waitForConnection() call is not preceded by a budget reset, it
  // is silently gated by the stale cooldown even though setup() just fixed
  // the underlying problem.
  test("resets the connection budget after setup on the stale-cache path", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);

    let waitForConnectionCalls = 0;
    let resetConnectionBudgetCalls = 0;
    let secondWaitSawPriorReset = false;

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => {
          waitForConnectionCalls++;
          if (waitForConnectionCalls === 1) {
            // Cache-stale probe: the runner is not listening yet.
            return Promise.resolve(false);
          }
          // Post-setup call: the runner is listening now (setup() just
          // completed), so it must only run after the budget reset.
          secondWaitSawPriorReset = resetConnectionBudgetCalls > 0;
          return Promise.resolve(true);
        },
        resetConnectionBudget: () => {
          resetConnectionBudgetCalls++;
        },
        verifyServiceReady: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1");

    expect(waitForConnectionCalls).toBe(2);
    expect(resetConnectionBudgetCalls).toBeGreaterThanOrEqual(1);
    expect(secondWaitSawPriorReset).toBe(true);
  });

  test("should skip accessibility checks when websocket is connected and service is responsive", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => true,
        verifyServiceReady: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1");

    expect(accessibilityManager.getExecutedOperations()).toEqual([]);
  });

  test("should fall through to normal flow when websocket connected but service not responsive", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);
    let terminateStaleConnectionCalls = 0;

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => true,
        verifyServiceReady: () => Promise.resolve(false), // Service not responsive
        waitForConnection: () => Promise.resolve(true),
        terminateStaleConnection: () => {
          terminateStaleConnectionCalls++;
        },
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1");

    // Issue #7554: a connected-but-unresponsive socket must be terminated
    // rather than reused by the waitForConnection() fallback below.
    expect(terminateStaleConnectionCalls).toBe(1);
    // Should have fallen through and checked status since service wasn't responsive
    expect(accessibilityManager.wasMethodCalled("isInstalled")).toBe(true);
  });

  test("CtrlProxy collaborators come from the provider, not static getInstance", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);

    let clientFromProvider = 0;
    const stubClient = stubAndroidCtrlProxy({
      isConnected: () => {
        clientFromProvider++;
        return true;
      },
      verifyServiceReady: () => Promise.resolve(true),
    });

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubClient,
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1");

    expect(clientFromProvider).toBeGreaterThan(0);
  });

  test("FakeDeviceClientProvider throws when collaborator fakes are not configured", () => {
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils);
    expect(() => provider.getAndroidCtrlProxyClient(device)).toThrow(
      /ctrlProxyClient fake not configured/,
    );
    expect(() => provider.getAndroidCtrlProxyManager(device)).toThrow(
      /ctrlProxyManager fake not configured/,
    );
    expect(() => provider.getIOSCtrlProxyManager(device)).toThrow(
      /iosCtrlProxyManager fake not configured/,
    );
    expect(() => provider.getIOSCtrlProxyClient(device, 8080)).toThrow(
      /iosCtrlProxyClient fake not configured/,
    );
    expect(() => provider.getWindow(device)).toThrow(/window fake not configured/);
  });

  test("Window comes from the provider, not from `new Window(device)`", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
      }),
    });
    const manager = createTestSessionManager(provider);
    await manager.ensureDeviceReady("android", "device-1");

    // Window.getActive must have been called exclusively on the injected fake.
    expect(fakeWindow.wasMethodCalled("getActive")).toBe(true);
  });
});

describe("DeviceSessionManager iOS push-update cache invalidation", () => {
  let fakeAdb: FakeAdbExecutor;
  let fakeDeviceUtils: FakeDeviceUtils;
  let originalAppearanceDefaults: AppearanceConfigInput;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeDeviceUtils = new FakeDeviceUtils();
    originalAppearanceDefaults = serverConfig.getAppearanceDefaults();
    serverConfig.setAppearanceDefaults({
      ...originalAppearanceDefaults,
      applyOnConnect: false,
      syncWithHost: false,
      defaultMode: "light",
    });
  });

  afterEach(() => {
    serverConfig.setAppearanceDefaults(originalAppearanceDefaults);
  });

  test("booted readiness does not initialize iOS CtrlProxy collaborators", async () => {
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-booted-only", {
      udid: "ios-booted-only",
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, fakeSimctl as any);
    const manager = createTestSessionManager(provider);

    await expect(
      manager.verifyIosDevice("ios-booted-only", { readiness: "booted" }),
    ).resolves.toBeUndefined();
  });

  test("push update fires clearForDevice on the injected ObserveScreenCache", async () => {
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-push-1", {
      udid: "ios-push-1",
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });

    const iosManager = new FakeIOSCtrlProxyManager();
    iosManager.setRunning(true);

    // Capture the push-update callback so the test can fire it on demand.
    let captured: (() => void) | null = null;
    const iosClient = stubIOSCtrlProxy({
      isConnected: () => true,
      verifyServiceReady: () => Promise.resolve(true),
      onPushUpdate: (cb: () => void) => {
        captured = cb;
        return () => {
          captured = null;
        };
      },
    });

    const observeCache = new FakeObserveScreenCache();

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, fakeSimctl as any, {
      iosCtrlProxyManager: iosManager,
      iosCtrlProxyClient: iosClient,
      observeScreenCache: observeCache,
    });

    const manager = createTestSessionManager(provider);
    await manager.verifyIosDevice("ios-push-1");

    // Listener registered; cache untouched until update fires.
    if (!captured) {
      throw new Error("onPushUpdate listener never registered");
    }
    expect(observeCache.wasClearedFor("ios-push-1")).toBe(false);

    captured();

    expect(observeCache.wasClearedFor("ios-push-1")).toBe(true);
    expect(observeCache.getClearedDevices()).toEqual(["ios-push-1"]);
  });

  test("re-registers cache invalidation on a replacement iOS client only once", async () => {
    const deviceId = "ios-restarted-push";
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo(deviceId, {
      udid: deviceId,
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });
    const iosManager = new FakeIOSCtrlProxyManager();
    iosManager.setRunning(true);
    const callbacksA: Array<() => void> = [];
    const callbacksB: Array<() => void> = [];
    const makeClient = (callbacks: Array<() => void>) =>
      stubIOSCtrlProxy({
        isConnected: () => true,
        verifyServiceReady: () => Promise.resolve(true),
        onPushUpdate: (callback: () => void) => {
          callbacks.push(callback);
          return () => {};
        },
      });
    const options = {
      iosCtrlProxyManager: iosManager,
      iosCtrlProxyClient: makeClient(callbacksA),
      observeScreenCache: new FakeObserveScreenCache(),
    };
    const provider = new FakeDeviceClientProvider(
      fakeAdb,
      fakeDeviceUtils,
      fakeSimctl as any,
      options,
    );
    const manager = createTestSessionManager(provider);

    await manager.verifyIosDevice(deviceId);
    await manager.verifyIosDevice(deviceId);
    expect(callbacksA).toHaveLength(1);

    options.iosCtrlProxyClient = makeClient(callbacksB);
    await manager.verifyIosDevice(deviceId);
    await manager.verifyIosDevice(deviceId);
    expect(callbacksB).toHaveLength(1);
    callbacksB[0]();
    expect(options.observeScreenCache.getClearedDevices()).toEqual([deviceId]);
  });

  test("waits for startup reaping before confirming a connected iOS runner is ready", async () => {
    const reaping = deferred();
    const reapSpy = spyOn(
      IOSCtrlProxyManager,
      "reapOrphanedRunnerProcessesOnStartup",
    ).mockImplementation(() => reaping.promise);
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-push-1", {
      udid: "ios-push-1",
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });

    const iosManager = new FakeIOSCtrlProxyManager();
    const verifyServiceReady = spyOn(
      new FakeIOSCtrlProxy(),
      "verifyServiceReady",
    ).mockResolvedValue(true);
    const iosClient = {
      isConnected: () => true,
      verifyServiceReady,
      onPushUpdate: () => () => {},
    } as unknown as IOSCtrlProxy;
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, fakeSimctl as any, {
      iosCtrlProxyManager: iosManager,
      iosCtrlProxyClient: iosClient,
    });
    const manager = createTestSessionManager(provider);

    try {
      IOSCtrlProxyManager.startOrphanRunnerReapOnStartup();
      const verify = manager.verifyIosDevice("ios-push-1");
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(verifyServiceReady).not.toHaveBeenCalled();
      reaping.resolve();
      await verify;
      expect(verifyServiceReady).toHaveBeenCalled();
    } finally {
      reapSpy.mockRestore();
      IOSCtrlProxyManager.resetInstances();
    }
  });
});

describe("DeviceSessionManager legacy iOS auto-start readiness", () => {
  const iosDevice: BootedDevice = {
    deviceId: "ios-ready-1",
    name: "iPhone 15",
    platform: "ios",
  };

  function createManager(
    iosManager: FakeIOSCtrlProxyManager,
    iosClient: FakeIOSCtrlProxy,
    useConfiguredReadinessTimeout: boolean = false,
    lifecycleCoordinator?: VirtualDeviceLifecycleCoordinator,
  ): DeviceSessionManager {
    const fakeAdb = new FakeAdbExecutor();
    const fakeDeviceUtils = new FakeDeviceUtils();
    const fakeSimctl = new FakeSimctl();
    fakeSimctl.setAvailableSimulators([iosDevice]);
    fakeSimctl.setBootedSimulators([iosDevice]);
    fakeSimctl.setDeviceInfo(iosDevice.deviceId, {
      udid: iosDevice.deviceId,
      name: iosDevice.name,
      state: "Booted",
      isAvailable: true,
    });
    const simctl = Object.assign(fakeSimctl, {
      openSimulatorApp: async () => true,
    });
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, simctl as never, {
      iosCtrlProxyManager: iosManager,
      iosCtrlProxyClient: iosClient,
    });
    const timer = new FakeTimer();
    timer.enableAutoAdvance();

    const options = {
      runnerReadinessTimer: timer,
      lifecycleCoordinator,
      ...(useConfiguredReadinessTimeout ? {} : { runnerReadinessTimeoutMs: 1_000 }),
    };
    return createTestSessionManager(provider, undefined, options);
  }

  test("fails auto-start with the original CtrlProxy setup diagnostic", async () => {
    const iosManager = new FakeIOSCtrlProxyManager();
    iosManager.setSetupShouldFail(true);
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(false);
    const manager = createManager(iosManager, iosClient);

    const error = await manager.ensureDeviceReady("ios").then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(
      /legacy iOS session auto-start.*phase=runner-setup.*Mock setup failure/,
    );
    expect(message).not.toContain("startDevice");
  });

  test("teardown preempts legacy session auto-start readiness for the same UDID", async () => {
    const lifecycleTimer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(lifecycleTimer);
    const iosManager = new FakeIOSCtrlProxyManager();
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(false);
    let setupStarted!: () => void;
    const didStartSetup = new Promise<void>((resolve) => {
      setupStarted = resolve;
    });
    iosManager.setup = async (_force, _perf, signal) => {
      setupStarted();
      return await new Promise((resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("setup cancelled"));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const manager = createManager(iosManager, iosClient, false, lifecycleCoordinator);

    const readiness = manager.ensureDeviceReady("ios");
    await didStartSetup;
    const teardown = lifecycleCoordinator.reserve(
      { kind: "stable", platform: "ios", stableId: iosDevice.deviceId },
      { operation: "teardown", deadlineMs: 1_000 },
    );

    await expect(readiness).rejects.toThrow(/preempted by teardown/);
    const teardownLease = await teardown;
    teardownLease.release();
  });

  test("reserves an auto-created simulator name before creation and binds its UDID", async () => {
    const lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    const fakeAdb = new FakeAdbExecutor();
    const fakeDeviceUtils = new FakeDeviceUtils();
    const fakeSimctl = new FakeSimctl();
    const createdUdid = "created-simulator-udid";
    const bootStarted = deferred();
    fakeSimctl.setDeviceTypes([
      {
        name: "iPhone 17",
        identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        productFamily: "iPhone",
        bundlePath: "/tmp",
        minRuntimeVersion: 0,
        maxRuntimeVersion: 0,
      },
    ]);
    fakeSimctl.setCreatedSimulatorUdid(createdUdid);
    Object.assign(fakeSimctl, {
      resolveRuntimeIdentifiersForBounds: async () => [
        "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      ],
      openSimulatorApp: async () => true,
    });
    fakeSimctl.bootSimulator = async () => {
      bootStarted.resolve();
      const signal = getAbortSignal();
      return await new Promise<BootedDevice>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("boot cancelled"));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const iosManager = new FakeIOSCtrlProxyManager();
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(true);
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, fakeSimctl as never, {
      iosCtrlProxyManager: iosManager,
      iosCtrlProxyClient: iosClient,
    });
    const manager = createTestSessionManager(provider, undefined, {
      lifecycleCoordinator,
    });
    setDeviceCreationGate(new FakeDeviceCreationGate(true));

    try {
      const readiness = manager.findOrStartIosDevice();
      await bootStarted.promise;
      const createCall = fakeSimctl.getMethodCalls("createSimulator")[0];
      const createdName = createCall?.name;
      expect(createdName).toBeString();
      expect(lifecycleCoordinator.reservations[0]).toEqual({
        identity: { kind: "selector", platform: "ios", selector: createdName },
        operation: "start",
      });

      const teardown = lifecycleCoordinator.reserve(
        { kind: "stable", platform: "ios", stableId: createdUdid },
        { operation: "teardown", deadlineMs: 300_000 },
      );
      await expect(readiness).rejects.toThrow(/preempted by teardown/);
      const teardownLease = await teardown;
      teardownLease.release();
    } finally {
      resetDeviceCreationGate();
    }
  });

  test("fails auto-start when CtrlProxy setup throws", async () => {
    const iosManager = new FakeIOSCtrlProxyManager();
    iosManager.setup = async () => {
      throw new Error("xcodebuild exited 65");
    };
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(false);
    const manager = createManager(iosManager, iosClient);

    await expect(manager.ensureDeviceReady("ios")).rejects.toThrow(
      /phase=runner-setup.*xcodebuild exited 65/,
    );
  });

  test("fails auto-start when CtrlProxy never connects", async () => {
    const iosManager = new FakeIOSCtrlProxyManager();
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(false);
    const manager = createManager(iosManager, iosClient);

    await expect(manager.ensureDeviceReady("ios")).rejects.toThrow(/phase=runner-connect/);
  });

  test("sizes runner provisioning by the provision budget, decoupled from the health budget", async () => {
    // Session auto-start's total deadline covers a cold CtrlProxy launch
    // (the provision budget), so the setup health-poll duration reflects that
    // budget — not the short steady-state readiness/health config (#5376).
    const originalTimeoutMs = serverConfig.getRunnerReadinessTimeoutMs();
    try {
      const iosManager = new FakeIOSCtrlProxyManager();
      const iosClient = new FakeIOSCtrlProxy();
      iosClient.setConnected(false);
      const manager = createManager(iosManager, iosClient, true);
      serverConfig.setRunnerReadinessTimeoutMs(30_000);

      await expect(manager.ensureDeviceReady("ios")).rejects.toThrow(/phase=runner-connect/);
      // Provision (setup) budget dominates the health budget, so a cold launch
      // gets the full provision window rather than the 30s health window.
      expect(iosManager.getLastSetupMinimumHealthPollDurationMs()).toBe(
        DEFAULT_RUNNER_PROVISION_TIMEOUT_MS,
      );
    } finally {
      serverConfig.setRunnerReadinessTimeoutMs(originalTimeoutMs);
    }
  });

  test("resets stale setup state after the connected health probe fails", async () => {
    const iosManager = new FakeIOSCtrlProxyManager();
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(true);
    spyOn(iosClient, "verifyServiceReady").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const manager = createManager(iosManager, iosClient);

    await expect(manager.ensureDeviceReady("ios")).resolves.toEqual(iosDevice);
    expect(iosManager.wasMethodCalled("resetSetupState")).toBe(true);
    expect(iosManager.wasMethodCalled("forceRestart")).toBe(true);
    expect(iosManager.wasMethodCalled("setup")).toBe(false);
  });

  test("does not retry the current simulator after runner readiness fails", async () => {
    const iosManager = new FakeIOSCtrlProxyManager();
    iosManager.setSetupShouldFail(true);
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(false);
    const manager = createManager(iosManager, iosClient);
    manager.setCurrentDevice(iosDevice, "ios");

    await expect(manager.ensureDeviceReady("ios")).rejects.toThrow(/phase=runner-setup/);
    expect(iosManager.getCallCount("setup")).toBe(1);
  });

  test("fails auto-start when a connected CtrlProxy never becomes healthy", async () => {
    const iosManager = new FakeIOSCtrlProxyManager();
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(true);
    spyOn(iosClient, "verifyServiceReady").mockResolvedValue(false);
    const manager = createManager(iosManager, iosClient);

    await expect(manager.ensureDeviceReady("ios")).rejects.toThrow(/phase=runner-health/);
  });

  test("keeps an already-responsive CtrlProxy on the fast path", async () => {
    const iosManager = new FakeIOSCtrlProxyManager();
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(true);
    const manager = createManager(iosManager, iosClient);

    await expect(manager.ensureDeviceReady("ios")).resolves.toEqual(iosDevice);
    expect(iosManager.wasMethodCalled("setup")).toBe(false);
  });
});

describe("DeviceSessionManager iOS presentation policy", () => {
  let originalAppearanceDefaults: AppearanceConfigInput;

  beforeEach(() => {
    originalAppearanceDefaults = serverConfig.getAppearanceDefaults();
    serverConfig.setAppearanceDefaults({
      ...originalAppearanceDefaults,
      applyOnConnect: false,
      syncWithHost: false,
      defaultMode: "light",
    });
  });

  afterEach(() => {
    serverConfig.setAppearanceDefaults(originalAppearanceDefaults);
  });

  function createIosManager(fakeSimctl: FakeSimCtlClient, timer = new FakeTimer()) {
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(true);
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      fakeSimctl as never,
      { iosCtrlProxyManager: new FakeIOSCtrlProxyManager(), iosCtrlProxyClient: iosClient },
    );
    return createTestSessionManager(provider, undefined, {
      runnerReadinessTimer: timer,
    });
  }

  test("repeated verification across multiple 30-second intervals never presents", async () => {
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-sim-1", {
      udid: "ios-sim-1",
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });
    const timer = new FakeTimer();
    const manager = createIosManager(fakeSimctl, timer);

    for (let attempt = 0; attempt < 4; attempt++) {
      await manager.verifyIosDevice(
        "ios-sim-1",
        attempt % 2 === 0 ? { readiness: "booted" } : undefined,
      );
      timer.advanceTime(30_000);
    }
    expect(fakeSimctl.getMethodCalls("openSimulatorApp")).toHaveLength(0);
  });

  test("verification of a shutdown device never presents", async () => {
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-sim-1", {
      udid: "ios-sim-1",
      name: "iPhone 15",
      state: "Shutdown",
      isAvailable: true,
    });
    await createIosManager(fakeSimctl).verifyIosDevice("ios-sim-1");
    expect(fakeSimctl.getMethodCalls("openSimulatorApp")).toHaveLength(0);
  });

  test("session auto-start presents after its own boot; reconnect to the booted device does not", async () => {
    const fakeSimctl = new FakeSimctl();
    const device = { deviceId: "ios-sim-1", name: "iPhone 15", platform: "ios" as const };
    fakeSimctl.setAvailableSimulators([{ ...device, isAvailable: true }]);
    fakeSimctl.setDeviceInfo(device.deviceId, {
      udid: device.deviceId,
      name: device.name,
      state: "Booted",
      isAvailable: true,
    });
    const presentations: Array<{ udid: string; generation: string }> = [];
    Object.assign(fakeSimctl, {
      presentSimulatorAfterStart: async (udid: string, generation: string) => {
        presentations.push({ udid, generation });
      },
    });
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(true);
    const provider = new FakeDeviceClientProvider(
      new FakeAdbExecutor(),
      new FakeDeviceUtils(),
      fakeSimctl as never,
      { iosCtrlProxyManager: new FakeIOSCtrlProxyManager(), iosCtrlProxyClient: iosClient },
    );
    const manager = createTestSessionManager(provider);

    await manager.findOrStartIosDevice({ readiness: "booted" });
    expect(presentations).toHaveLength(1);
    expect(presentations[0].udid).toBe(device.deviceId);
    fakeSimctl.setBootedSimulators([device]);
    await manager.findOrStartIosDevice({ readiness: "booted" });
    expect(presentations).toHaveLength(1);
  });
});

describe("DeviceSessionManager dual-platform resolution", () => {
  const androidDevice: BootedDevice = {
    name: "emulator-5554",
    deviceId: "emulator-5554",
    platform: "android",
  };

  const iosDevice: BootedDevice = {
    name: "iPhone 15",
    deviceId: "ios-sim-1",
    platform: "ios",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeDeviceUtils: FakeDeviceUtils;
  let fakeSimctl: FakeSimctl;
  let fakeAdbFactory: AdbClientFactory;
  let fakeWindow: FakeWindow;
  let originalAppearanceDefaults: AppearanceConfigInput;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeSimctl = new FakeSimctl();
    fakeAdbFactory = { create: () => fakeAdb };
    fakeWindow = makeReadyWindow();

    fakeAdb.setDevices([androidDevice]);
    fakeSimctl.setBootedSimulators([iosDevice]);
    fakeSimctl.setDeviceInfo("ios-sim-1", {
      udid: "ios-sim-1",
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });

    originalAppearanceDefaults = serverConfig.getAppearanceDefaults();
    serverConfig.setAppearanceDefaults({
      ...originalAppearanceDefaults,
      applyOnConnect: false,
      syncWithHost: false,
      defaultMode: "light",
    });
  });

  afterEach(() => {
    serverConfig.setAppearanceDefaults(originalAppearanceDefaults);
  });

  function buildProvider(): FakeDeviceClientProvider {
    const fakeCtrlProxy = new FakeCtrlProxyManager();
    fakeCtrlProxy.setInstalled(true);
    fakeCtrlProxy.setEnabled(true);
    fakeCtrlProxy.setVersionCompatible(true);

    const fakeIosManager = new FakeIOSCtrlProxyManager();
    const fakeIosClient = new FakeIOSCtrlProxy();
    fakeIosClient.setConnected(true);

    return new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, fakeSimctl as any, {
      window: fakeWindow,
      ctrlProxyManager: fakeCtrlProxy,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => true,
        verifyServiceReady: () => Promise.resolve(true),
      }),
      iosCtrlProxyManager: fakeIosManager,
      iosCtrlProxyClient: fakeIosClient,
    });
  }

  test("should throw when both platforms connected and no active device or deviceId", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    await expect(manager.ensureDeviceReady("either")).rejects.toThrow(
      "pass sessionUuid (from getAndroid/getApple), platform, or a bound device label on this call",
    );
  });

  test("fails closed when an unusable iOS runner override is set (#4221)", async () => {
    // A directory-valued AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH cannot load, and
    // the cached-start path skips the builder that would validate it. The
    // override must fail closed rather than silently run the cached runner.
    const original = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = os.tmpdir(); // a directory
    try {
      const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);
      await expect(
        manager.verifyIosDevice(iosDevice.deviceId, { skipCtrlProxyDownload: true }),
      ).rejects.toThrow(/BUNDLE_PATH.*unusable|directory/);
    } finally {
      if (original === undefined) {
        delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
      } else {
        process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = original;
      }
    }
  });

  test("does not fail closed when a usable .ipa override is set (#4221)", async () => {
    const original = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsm-override-"));
    const ipa = path.join(dir, "runner.ipa");
    await fs.writeFile(ipa, ipaBytes());
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = ipa;
    try {
      const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);
      const result = await manager.ensureDeviceReady("ios", iosDevice.deviceId, {
        skipCtrlProxyDownload: true,
      });
      expect(result.platform).toBe("ios");
    } finally {
      if (original === undefined) {
        delete process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
      } else {
        process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = original;
      }
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  test("should resolve to ios when setActiveDevice was called with ios", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    manager.setCurrentDevice(iosDevice, "ios");

    const result = await manager.ensureDeviceReady("either", iosDevice.deviceId);
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe("ios-sim-1");
  });

  test("resolves the other platform by providedDeviceId even when setActiveDevice selected a different one (#5870)", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    // Ambient platform is Android (a prior setActiveDevice), but the caller now
    // targets the iOS device by id with no explicit platform — switching must
    // honor the named device over the ambient platform, not throw.
    manager.setCurrentDevice(androidDevice, "android");

    const result = await manager.ensureDeviceReady("either", iosDevice.deviceId);
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe("ios-sim-1");
  });

  test("should resolve to active platform without deviceId when setActiveDevice was called", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    manager.setCurrentDevice(iosDevice, "ios");

    const result = await manager.ensureDeviceReady("either");
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe("ios-sim-1");
  });

  test("explicit pin wins over a later ambient device resolution", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);
    manager.setCurrentDevice(iosDevice, "ios");
    manager.setExplicitDevicePin(iosDevice);
    manager.setCurrentDevice(androidDevice, "android");

    const result = await manager.ensureDeviceReady("either");
    expect(result.deviceId).toBe(iosDevice.deviceId);
    expect(manager.getCurrentDevice()?.deviceId).toBe(iosDevice.deviceId);
  });

  test("should resolve ios device by providedDeviceId when no active device set", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    const result = await manager.ensureDeviceReady("either", "ios-sim-1");
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe("ios-sim-1");
  });

  test("reserves a provided simulator through readiness verification", async () => {
    const lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory, {
      lifecycleCoordinator,
    });

    await manager.ensureDeviceReady("ios", iosDevice.deviceId);

    expect(lifecycleCoordinator.reservations).toContainEqual({
      identity: { kind: "stable", platform: "ios", stableId: iosDevice.deviceId },
      operation: "start",
    });
  });

  test("should resolve android device by providedDeviceId when no active device set", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    const result = await manager.ensureDeviceReady("either", "emulator-5554");
    expect(result.platform).toBe("android");
    expect(result.deviceId).toBe("emulator-5554");
  });

  test("should verify current device using resolvedPlatform not raw platform when platform is 'either'", async () => {
    // This test ensures that when platform="either" and currentDevice is Android,
    // verifyDevice is called with "android" (resolvedPlatform) instead of "either" (raw platform).
    // Bug fix: previously "either" was passed to verifyDevice which treated it as iOS.
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    // Set current device to Android (simulating a prior setActiveDevice call)
    manager.setCurrentDevice(androidDevice, "android");

    // Call ensureDeviceReady with "either" - should use the current Android device
    const result = await manager.ensureDeviceReady("either");
    expect(result.platform).toBe("android");
    expect(result.deviceId).toBe("emulator-5554");
    // The device should still be set (not cleared by a failed iOS verification)
    expect(manager.getCurrentPlatform()).toBe("android");
    expect(manager.getCurrentDevice()?.deviceId).toBe("emulator-5554");
  });

  test("request cancellation preserves the current device selection", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);
    const controller = new AbortController();
    manager.setCurrentDevice(androidDevice, "android");
    controller.abort(new Error("request cancelled"));

    await expect(
      manager.ensureDeviceReady("either", undefined, {
        readiness: "booted",
        signal: controller.signal,
      }),
    ).rejects.toThrow("request cancelled");

    expect(manager.getCurrentPlatform()).toBe("android");
    expect(manager.getCurrentDevice()?.deviceId).toBe(androidDevice.deviceId);
  });

  test("reserves the current simulator through readiness verification", async () => {
    const lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory, {
      lifecycleCoordinator,
    });
    manager.setCurrentDevice(iosDevice, "ios");

    await manager.ensureDeviceReady("either");

    expect(lifecycleCoordinator.reservations).toContainEqual({
      identity: { kind: "stable", platform: "ios", stableId: iosDevice.deviceId },
      operation: "start",
    });
  });

  test("should return android device when platform is explicitly 'android' even with iOS active", async () => {
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    // Set current device to iOS (simulating a prior setActiveDevice call to iOS)
    manager.setCurrentDevice(iosDevice, "ios");

    // Call ensureDeviceReady with explicit "android" platform
    const result = await manager.ensureDeviceReady("android", "emulator-5554");
    expect(result.platform).toBe("android");
    expect(result.deviceId).toBe("emulator-5554");
    // Current device should now be updated to Android
    expect(manager.getCurrentPlatform()).toBe("android");
  });

  test("should resolve correct platform when explicitly requesting android with both devices booted", async () => {
    // When both platforms are booted and we explicitly request Android,
    // the returned device must always be Android even if current device was iOS.
    // Configure fakeDeviceUtils so findOrStartDevice can find Android devices
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);

    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    // Set current device to iOS first
    manager.setCurrentDevice(iosDevice, "ios");

    // Explicitly request Android without deviceId — should still resolve to Android
    const result = await manager.ensureDeviceReady("android");
    expect(result.platform).toBe("android");
    expect(result.deviceId).toBe("emulator-5554");
    // Current device should now be updated to Android
    expect(manager.getCurrentPlatform()).toBe("android");
  });

  test("passes spawned Android emulator process into auto-start readiness wait", async () => {
    const childProcess = new EventEmitter() as any;
    const startedDevice: BootedDevice = {
      name: "mock-Pixel_9_Pro",
      deviceId: "mock-Pixel_9_Pro",
      platform: "android",
    };
    fakeDeviceUtils.setDeviceImages("android", [{ name: "Pixel_9_Pro", platform: "android" }]);
    fakeDeviceUtils.setMockChildProcess("Pixel_9_Pro", childProcess);
    fakeAdb.setDevices([startedDevice]);

    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    await manager.findOrStartAndroidDevice();

    expect(fakeDeviceUtils.getWaitForDeviceReadyChildProcess()).toBe(childProcess);
  });

  test("does not cold-boot an Android image when its running state is unknown", async () => {
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.setDeviceImages("android", [
      {
        name: "Pixel_9_Pro",
        platform: "android",
        isRunning: false,
        isRunningStateKnown: false,
      },
    ]);
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory);

    await expect(manager.findOrStartAndroidDevice()).rejects.toThrow(
      "Cannot safely cold-boot Android AVD 'Pixel_9_Pro': its running state is unknown.",
    );

    expect(fakeDeviceUtils.wasMethodCalled("startDevice")).toBe(false);
  });

  test("holds the Android auto-start lease until a preempted emulator process exits", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const childProcess = new EventEmitter() as any;
    Object.assign(childProcess, {
      exitCode: null,
      signalCode: null,
      killed: false,
      stderr: null,
      kill: () => {
        childProcess.killed = true;
        return true;
      },
    });
    let readinessStarted!: () => void;
    const didStartReadiness = new Promise<void>((resolve) => {
      readinessStarted = resolve;
    });
    fakeAdb.setDevices([]);
    fakeDeviceUtils.setDeviceImages("android", [{ name: "Pixel_9_Pro", platform: "android" }]);
    fakeDeviceUtils.setMockChildProcess("Pixel_9_Pro", childProcess);
    fakeDeviceUtils.waitForDeviceReady = async (_device, _timeoutMs, _childProcess, signal) => {
      readinessStarted();
      return await new Promise<BootedDevice>((_resolve, reject) => {
        const abort = () => reject(signal?.reason ?? new Error("readiness cancelled"));
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
      });
    };
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory, {
      lifecycleCoordinator,
      runnerReadinessTimer: timer,
    });

    const readiness = manager.findOrStartAndroidDevice();
    await didStartReadiness;
    const teardown = lifecycleCoordinator.reserve(
      { kind: "stable", platform: "android", stableId: "Pixel_9_Pro" },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    let teardownAcquired = false;
    void teardown.then(() => {
      teardownAcquired = true;
    });
    for (let attempt = 0; !childProcess.killed && attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(childProcess.killed).toBe(true);
    expect(teardownAcquired).toBe(false);

    childProcess.exitCode = 0;
    childProcess.emit("exit", 0, "SIGTERM");
    await expect(readiness).rejects.toThrow(/preempted by teardown/);
    const teardownLease = await teardown;
    teardownLease.release();
  });

  // #10075: a launch cancelled after the emulator spawned rejects at once with the child
  // on the error. The auto-start must confirm that child's exit before it frees the AVD
  // lease, or the next start of the same AVD spawns a second emulator against the locks.
  describe("cancelled Android auto-start launch", () => {
    const AVD = "Pixel_9_Pro";

    type FakeEmulatorChild = HostChildProcess & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };

    function fakeEmulatorChild(pid: number | undefined) {
      const child = new EventEmitter() as FakeEmulatorChild;
      const signals: string[] = [];
      child.pid = pid;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (signal?: NodeJS.Signals | number) => {
        signals.push(String(signal ?? "SIGTERM"));
        return true;
      };
      const exit = () => {
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
      };
      return { child, signals, exit };
    }

    async function settle(): Promise<void> {
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }

    function startCancelledByAbort(childAtCancel: HostChildProcess | null) {
      const timer = new FakeTimer();
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
      fakeAdb.setDevices([]);
      fakeDeviceUtils.setDeviceImages("android", [{ name: AVD, platform: "android" }]);
      fakeDeviceUtils.startDevice = async () => {
        const signal = getAbortSignal();
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new EmulatorLaunchCancelledError(AVD, childAtCancel);
      };
      const manager = createTestSessionManager(buildProvider(), fakeAdbFactory, {
        lifecycleCoordinator,
        runnerReadinessTimer: timer,
      });
      const controller = new AbortController();
      let outcome: "pending" | "rejected" = "pending";
      const start = manager.findOrStartAndroidDevice({ signal: controller.signal }).then(
        () => undefined,
        (error: unknown) => {
          outcome = "rejected";
          return error;
        },
      );
      // A following start of the same AVD: queued once this one holds the lease, and
      // granted only when that lease is released.
      let nextGranted = false;
      const nextRefusals: unknown[] = [];
      const requestNextStart = () =>
        void lifecycleCoordinator
          .reserve(
            { kind: "stable", platform: "android", stableId: AVD },
            { operation: "start", deadlineMs: 60_000 },
          )
          .then(
            () => {
              nextGranted = true;
            },
            (error: unknown) => {
              nextRefusals.push(error);
            },
          );
      return {
        timer,
        controller,
        start,
        outcome: () => outcome,
        requestNextStart,
        nextGranted: () => nextGranted,
        nextRefusals,
      };
    }

    test("holds the AVD lease until SIGTERM, then SIGKILL, confirms the child exited", async () => {
      const emulator = fakeEmulatorChild(4242);
      const t = startCancelledByAbort(emulator.child);
      await settle();
      t.requestNextStart();

      t.controller.abort(new Error("request cancelled"));
      await settle();

      // The caller gets its rejection at once, but the lease stays held.
      expect(t.outcome()).toBe("rejected");
      expect(emulator.signals).toEqual(["SIGTERM"]);
      expect(t.nextGranted()).toBe(false);

      t.timer.advanceTime(1_000);
      await settle();
      expect(emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(t.nextGranted()).toBe(false);

      emulator.exit();
      await settle();
      expect(t.nextGranted()).toBe(true);
      expect(await t.start).toBeInstanceOf(EmulatorLaunchCancelledError);
    });

    test("releases the lease as soon as a SIGTERM-only exit is confirmed", async () => {
      const emulator = fakeEmulatorChild(4242);
      const t = startCancelledByAbort(emulator.child);
      await settle();
      t.requestNextStart();
      t.controller.abort(new Error("request cancelled"));
      await settle();
      expect(t.nextGranted()).toBe(false);

      emulator.exit();
      await settle();

      expect(emulator.signals).toEqual(["SIGTERM"]);
      expect(t.nextGranted()).toBe(true);
    });

    test("keeps the lease for a child that survives SIGKILL until it finally exits", async () => {
      // No pid: the survivor watch listens for `exit` only, so nothing probes a real pid.
      const emulator = fakeEmulatorChild(undefined);
      const t = startCancelledByAbort(emulator.child);
      await settle();
      t.requestNextStart();
      t.controller.abort(new Error("request cancelled"));
      await settle();

      t.timer.advanceTime(1_000);
      await settle();
      t.timer.advanceTime(1_000);
      await settle();
      expect(emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
      // The waiting start is refused with the unkillable-process hold, never granted.
      expect(t.nextGranted()).toBe(false);
      expect(String(t.nextRefusals[0])).toContain("unkillable process");

      // The hold lifts only once the child is finally gone.
      emulator.exit();
      await settle();
      t.requestNextStart();
      await settle();
      expect(t.nextGranted()).toBe(true);
    });

    test("releases the lease at once when the cancel arrived before anything spawned", async () => {
      const t = startCancelledByAbort(null);
      await settle();
      t.requestNextStart();
      t.controller.abort(new Error("request cancelled"));
      await settle();

      expect(t.outcome()).toBe("rejected");
      expect(t.nextGranted()).toBe(true);
    });
  });

  test("reserves a warm Android emulator by stable AVD name", async () => {
    const lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    fakeDeviceUtils.setBootedDevices("android", [
      {
        name: "Pixel_9_Pro",
        deviceId: "emulator-5554",
        platform: "android",
      },
    ]);
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory, {
      lifecycleCoordinator,
    });

    await manager.findOrStartAndroidDevice();

    expect(lifecycleCoordinator.reservations).toContainEqual({
      identity: {
        kind: "stable",
        platform: "android",
        stableId: "Pixel_9_Pro",
      },
      operation: "start",
    });
  });

  test("keeps same-model physical Android handsets in distinct serial lifecycle lanes", async () => {
    const lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    const first: BootedDevice = {
      name: "Pixel 7",
      deviceId: "R5CT10AAAAA",
      platform: "android",
    };
    const second: BootedDevice = { ...first, deviceId: "R5CT10BBBBB" };
    const manager = createTestSessionManager(buildProvider(), fakeAdbFactory, {
      lifecycleCoordinator,
    });

    fakeDeviceUtils.setBootedDevices("android", [first]);
    fakeAdb.setDevices([first]);
    await manager.findOrStartAndroidDevice();
    fakeDeviceUtils.setBootedDevices("android", [second]);
    fakeAdb.setDevices([second]);
    await manager.findOrStartAndroidDevice();

    expect(lifecycleCoordinator.reservations).toContainEqual({
      identity: { kind: "selector", platform: "android", selector: first.deviceId },
      operation: "start",
    });
    expect(lifecycleCoordinator.reservations).toContainEqual({
      identity: { kind: "selector", platform: "android", selector: second.deviceId },
      operation: "start",
    });
  });

  test("replaces a Window when a warm AVD takes over a serial", async () => {
    const first: BootedDevice = {
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
      platform: "android",
    };
    const second: BootedDevice = { ...first, name: "Pixel_7_API_34" };
    const raw = (device: BootedDevice): BootedDevice => ({ ...device, name: device.deviceId });
    const createdFor: string[] = [];
    const factory: AdbClientFactory = {
      create(target) {
        if (target) {
          createdFor.push(target.name);
        }
        return fakeAdb;
      },
    };
    const dumpsysOutput =
      "imeControlTarget in display# 0 Window{12345678 u0 com.example.app/com.example.app.MainActivity}";
    fakeAdb.setDefaultResponse({
      stdout: dumpsysOutput,
      stderr: "",
      toString: () => dumpsysOutput,
      trim: () => dumpsysOutput.trim(),
      includes: (value: string) => dumpsysOutput.includes(value),
    } as ExecResult);
    const provider = buildProvider();
    const windowProvider = new DefaultDeviceClientProvider(factory);
    provider.getWindow = windowProvider.getWindow.bind(windowProvider);
    const manager = createTestSessionManager(provider);

    fakeDeviceUtils.setBootedDevices("android", [first]);
    fakeAdb.setDevices([raw(first)]);
    await manager.findOrStartAndroidDevice();
    fakeDeviceUtils.setBootedDevices("android", [second]);
    fakeAdb.setDevices([raw(second)]);
    await manager.findOrStartAndroidDevice();

    expect(createdFor).toEqual([first.name, second.name]);
  });

  function trackWindowFactories(): { createdFor: string[]; factory: AdbClientFactory } {
    const createdFor: string[] = [];
    const factory: AdbClientFactory = {
      create(target) {
        if (target) {
          createdFor.push(target.name);
        }
        return fakeAdb;
      },
    };
    const dumpsysOutput =
      "imeControlTarget in display# 0 Window{12345678 u0 com.example.app/com.example.app.MainActivity}";
    fakeAdb.setDefaultResponse({
      stdout: dumpsysOutput,
      stderr: "",
      toString: () => dumpsysOutput,
      trim: () => dumpsysOutput.trim(),
      includes: (value: string) => dumpsysOutput.includes(value),
    } as ExecResult);
    return { createdFor, factory };
  }

  // Production discovery lists Android devices from raw `adb devices`, so the
  // provided-device and current-device paths only ever see `name === serial`.
  // Each path must still resolve the AVD identity so a different AVD taking
  // over the serial rebuilds the cached Window (#7031 round 2).
  test("provided-device readiness rebuilds the Window when a different AVD takes the serial", async () => {
    const first: BootedDevice = {
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
      platform: "android",
    };
    const second: BootedDevice = { ...first, name: "Pixel_7_API_34" };
    const raw = (device: BootedDevice): BootedDevice => ({ ...device, name: device.deviceId });
    const { createdFor, factory } = trackWindowFactories();
    const provider = buildProvider();
    const windowProvider = new DefaultDeviceClientProvider(factory);
    provider.getWindow = windowProvider.getWindow.bind(windowProvider);
    const manager = createTestSessionManager(provider, fakeAdbFactory);

    fakeDeviceUtils.setBootedDevices("android", [first]);
    fakeAdb.setDevices([raw(first)]);
    const readyFirst = await manager.ensureDeviceReady("android", first.deviceId);
    fakeDeviceUtils.setBootedDevices("android", [second]);
    fakeAdb.setDevices([raw(second)]);
    const readySecond = await manager.ensureDeviceReady("android", second.deviceId);

    expect(createdFor).toEqual([first.name, second.name]);
    expect(readyFirst.name).toBe(first.name);
    expect(readySecond.name).toBe(second.name);
  });

  test("current-device readiness rebuilds the Window when a different AVD takes the serial", async () => {
    const first: BootedDevice = {
      name: "Pixel_8_API_35",
      deviceId: "emulator-5554",
      platform: "android",
    };
    const second: BootedDevice = { ...first, name: "Pixel_7_API_34" };
    const raw = (device: BootedDevice): BootedDevice => ({ ...device, name: device.deviceId });
    const { createdFor, factory } = trackWindowFactories();
    const provider = buildProvider();
    const windowProvider = new DefaultDeviceClientProvider(factory);
    provider.getWindow = windowProvider.getWindow.bind(windowProvider);
    const manager = createTestSessionManager(provider, fakeAdbFactory);
    manager.setCurrentDevice(raw(first), "android");

    fakeDeviceUtils.setBootedDevices("android", [first]);
    fakeAdb.setDevices([raw(first)]);
    const readyFirst = await manager.ensureDeviceReady("android");
    fakeDeviceUtils.setBootedDevices("android", [second]);
    fakeAdb.setDevices([raw(second)]);
    const readySecond = await manager.ensureDeviceReady("android");

    expect(createdFor).toEqual([first.name, second.name]);
    expect(readyFirst.name).toBe(first.name);
    expect(readySecond.name).toBe(second.name);
    expect(manager.getCurrentDevice()?.name).toBe(second.name);
  });

  // Readiness calls for two AVDs can overlap on a reused serial and finish out
  // of order. An older resolved observation must not evict the Window the newer
  // AVD already cached (#7031 round 2).
  test("keeps the newer AVD's Window when an older resolved observation arrives late", async () => {
    const newer: BootedDevice = {
      name: "Pixel_7_API_34",
      deviceId: "emulator-5554",
      platform: "android",
      observedAt: 5,
    };
    const older: BootedDevice = { ...newer, name: "Pixel_8_API_35", observedAt: 4 };
    const { createdFor, factory } = trackWindowFactories();
    const provider = new DefaultDeviceClientProvider(factory);

    const cached = provider.getWindow({ ...newer, observedAt: 2 });
    expect(provider.getWindow(newer)).toBe(cached);
    expect(provider.getWindow(older)).toBe(cached);
    expect(provider.getWindow({ ...newer, name: newer.deviceId, observedAt: 6 })).toBe(cached);
    expect(provider.getWindow({ ...older, observedAt: 6 })).not.toBe(cached);

    expect(createdFor).toEqual([newer.name, older.name]);
  });

  test("readiness does not let a stale resolved identity replace a newer AVD's Window", async () => {
    const newer: BootedDevice = {
      name: "Pixel_7_API_34",
      deviceId: "emulator-5554",
      platform: "android",
      observedAt: 2,
    };
    const older: BootedDevice = { ...newer, name: "Pixel_8_API_35", observedAt: 1 };
    const raw: BootedDevice = { ...newer, name: newer.deviceId };
    const { createdFor, factory } = trackWindowFactories();
    fakeAdb.setDevices([raw]);
    const manager = createTestSessionManager(new DefaultDeviceClientProvider(factory));

    await manager.verifyAndroidDevice(raw.deviceId, { readiness: "booted" }, newer);
    await manager.verifyAndroidDevice(raw.deviceId, { readiness: "booted" }, older);

    expect(createdFor).toEqual([newer.name]);
  });
});

describe("DeviceSessionManager device-list error formatting (#4227)", () => {
  // These messages exist to tell the caller which identifier to use instead.
  // Joining BootedDevice objects renders "[object Object]", destroying the only
  // actionable part of the error.

  function makeProvider(devices: BootedDevice[]): FakeDeviceClientProvider {
    const adb = new FakeAdbExecutor();
    adb.setDevices(devices);
    return new FakeDeviceClientProvider(adb, new FakeDeviceUtils(), undefined, {
      window: makeReadyWindow(),
      ctrlProxyManager: new FakeCtrlProxyManager(),
      ctrlProxyClient: stubAndroidCtrlProxy({ isConnected: () => true }),
    });
  }

  const androidDevice: BootedDevice = {
    name: "Pixel_9_Pro",
    platform: "android",
    deviceId: "emulator-5554",
  };

  test("verifyAndroidDevice matches the device id when the Android name differs", async () => {
    const manager = createTestSessionManager(makeProvider([androidDevice]));

    await expect(
      manager.verifyAndroidDevice(androidDevice.deviceId, { skipCtrlProxyDownload: true }),
    ).resolves.toBeUndefined();
  });

  test("ensureDeviceReady names the available devices instead of [object Object]", async () => {
    const manager = createTestSessionManager(makeProvider([androidDevice]));

    await expect(
      manager.ensureDeviceReady("android", "no-such-device", { skipCtrlProxyDownload: true }),
    ).rejects.toThrow(/emulator-5554/);
  });

  test("ensureDeviceReady never renders [object Object]", async () => {
    const manager = createTestSessionManager(makeProvider([androidDevice]));

    let message = "";
    try {
      await manager.ensureDeviceReady("android", "no-such-device", { skipCtrlProxyDownload: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("[object Object]");
  });

  test("ensureDeviceReady still reports 'none' when no devices are present", async () => {
    const manager = createTestSessionManager(makeProvider([]));

    let message = "";
    try {
      await manager.ensureDeviceReady("android", "no-such-device", { skipCtrlProxyDownload: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("[object Object]");
    expect(message).toContain("none");
  });

  test("verifyAndroidDevice names the available devices instead of [object Object]", async () => {
    const manager = createTestSessionManager(makeProvider([androidDevice]));

    let message = "";
    try {
      await manager.verifyAndroidDevice("no-such-device");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("[object Object]");
    expect(message).toContain("Pixel_9_Pro");
  });

  test("verifyAndroidDevice still reports 'none' when no devices are present", async () => {
    const manager = createTestSessionManager(makeProvider([]));

    let message = "";
    try {
      await manager.verifyAndroidDevice("no-such-device");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("none");
    expect(message).not.toContain("[object Object]");
  });
});

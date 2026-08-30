import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "events";
import { DeviceSessionManager } from "../../src/utils/DeviceSessionManager";
import { IOSCtrlProxyManager } from "../../src/utils/IOSCtrlProxyManager";
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
import { BootedDevice, AppearanceConfigInput } from "../../src/models";
import { serverConfig } from "../../src/utils/ServerConfig";
import { DEFAULT_RUNNER_PROVISION_TIMEOUT_MS } from "../../src/utils/runnerReadinessConfig";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
} from "../../src/utils/virtualDeviceLifecycleCoordinator";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AndroidCtrlProxy } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import type { IOSCtrlProxy } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { resetDeviceCreationGate, setDeviceCreationGate } from "../../src/utils/deviceCreationGate";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

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
  return overrides as unknown as AndroidCtrlProxy;
}

function stubIOSCtrlProxy(overrides: Partial<IOSCtrlProxy>): IOSCtrlProxy {
  return overrides as unknown as IOSCtrlProxy;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
    const manager = DeviceSessionManager.createInstance(provider);
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
    const manager = DeviceSessionManager.createInstance(provider);
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
    const manager = DeviceSessionManager.createInstance(provider);
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
    const manager = DeviceSessionManager.createInstance(provider);
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
    const manager = DeviceSessionManager.createInstance(provider);
    await manager.ensureDeviceReady("android", "device-1");

    expect(accessibilityManager.wasMethodCalled("setup")).toBe(true);
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
    const manager = DeviceSessionManager.createInstance(provider);
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
    const manager = DeviceSessionManager.createInstance(provider);
    await manager.ensureDeviceReady("android", "device-1");

    // Cache was stale (claimed installed but WebSocket failed), so setup should run
    expect(accessibilityManager.wasMethodCalled("resetSetupState")).toBe(true);
    expect(accessibilityManager.wasMethodCalled("setup")).toBe(true);
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
    const manager = DeviceSessionManager.createInstance(provider);
    await manager.ensureDeviceReady("android", "device-1");

    expect(accessibilityManager.getExecutedOperations()).toEqual([]);
  });

  test("should fall through to normal flow when websocket connected but service not responsive", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      window: fakeWindow,
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => true,
        verifyServiceReady: () => Promise.resolve(false), // Service not responsive
        waitForConnection: () => Promise.resolve(true),
      }),
    });
    const manager = DeviceSessionManager.createInstance(provider);
    await manager.ensureDeviceReady("android", "device-1");

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
    const manager = DeviceSessionManager.createInstance(provider);
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
    const manager = DeviceSessionManager.createInstance(provider);
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
    const manager = DeviceSessionManager.createInstance(provider);

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

    const manager = DeviceSessionManager.createInstance(provider);
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
    const manager = DeviceSessionManager.createInstance(provider);

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
      openSimulatorApp: async () => {},
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
    return DeviceSessionManager.createInstance(provider, undefined, options);
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
      resolveRuntimeIdentifier: async () => "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
      openSimulatorApp: async () => {},
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
    const manager = DeviceSessionManager.createInstance(provider, undefined, {
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

describe("DeviceSessionManager iOS openSimulatorApp", () => {
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

  function buildIosProvider(
    fakeAdb: FakeAdbExecutor,
    fakeDeviceUtils: FakeDeviceUtils,
    fakeSimctl: FakeSimCtlClient,
  ): FakeDeviceClientProvider {
    const iosManager = new FakeIOSCtrlProxyManager();
    const iosClient = new FakeIOSCtrlProxy();
    iosClient.setConnected(true);
    return new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, fakeSimctl as any, {
      iosCtrlProxyManager: iosManager,
      iosCtrlProxyClient: iosClient,
    });
  }

  test("should call openSimulatorApp once on the first booted iOS device verification", async () => {
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-sim-1", {
      udid: "ios-sim-1",
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });

    const manager = DeviceSessionManager.createInstance(
      buildIosProvider(fakeAdb, fakeDeviceUtils, fakeSimctl),
    );

    await manager.verifyIosDevice("ios-sim-1");

    expect(fakeSimctl.getMethodCalls("openSimulatorApp")).toHaveLength(1);
  });

  test("should not call openSimulatorApp again on subsequent verifications", async () => {
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-sim-1", {
      udid: "ios-sim-1",
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });

    const manager = DeviceSessionManager.createInstance(
      buildIosProvider(fakeAdb, fakeDeviceUtils, fakeSimctl),
    );

    await manager.verifyIosDevice("ios-sim-1");
    await manager.verifyIosDevice("ios-sim-1");
    await manager.verifyIosDevice("ios-sim-1");

    expect(fakeSimctl.getMethodCalls("openSimulatorApp")).toHaveLength(1);
  });

  test("should not call openSimulatorApp when device is not booted", async () => {
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-sim-1", {
      udid: "ios-sim-1",
      name: "iPhone 15",
      state: "Shutdown",
      isAvailable: true,
    });

    const manager = DeviceSessionManager.createInstance(
      buildIosProvider(fakeAdb, fakeDeviceUtils, fakeSimctl),
    );

    await manager.verifyIosDevice("ios-sim-1");

    expect(fakeSimctl.getMethodCalls("openSimulatorApp")).toHaveLength(0);
  });

  test("should retry openSimulatorApp on subsequent verifications after a failure", async () => {
    const fakeSimctl = new FakeSimCtlClient();
    fakeSimctl.setDeviceInfo("ios-sim-1", {
      udid: "ios-sim-1",
      name: "iPhone 15",
      state: "Booted",
      isAvailable: true,
    });

    const manager = DeviceSessionManager.createInstance(
      buildIosProvider(fakeAdb, fakeDeviceUtils, fakeSimctl),
    );

    // First call: openSimulatorApp throws — flag must NOT be set
    fakeSimctl.setOpenSimulatorAppError(new Error("open: command not found"));
    await manager.verifyIosDevice("ios-sim-1");
    expect(fakeSimctl.getMethodCalls("openSimulatorApp")).toHaveLength(1);

    // Second call: open succeeds now — flag gets set
    fakeSimctl.setOpenSimulatorAppError(null);
    await manager.verifyIosDevice("ios-sim-1");
    expect(fakeSimctl.getMethodCalls("openSimulatorApp")).toHaveLength(2);

    // Third call: flag is set, no retry
    await manager.verifyIosDevice("ios-sim-1");
    expect(fakeSimctl.getMethodCalls("openSimulatorApp")).toHaveLength(2);
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
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    await expect(manager.ensureDeviceReady("either")).rejects.toThrow(
      "Both Android and iOS devices are connected",
    );
  });

  test("fails closed when an unusable iOS runner override is set (#4221)", async () => {
    // A directory-valued AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH cannot load, and
    // the cached-start path skips the builder that would validate it. The
    // override must fail closed rather than silently run the cached runner.
    const original = process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH;
    process.env.AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH = os.tmpdir(); // a directory
    try {
      const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);
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
      const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);
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
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    manager.setCurrentDevice(iosDevice, "ios");

    const result = await manager.ensureDeviceReady("either", iosDevice.deviceId);
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe("ios-sim-1");
  });

  test("resolves the other platform by providedDeviceId even when setActiveDevice selected a different one (#5870)", async () => {
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    // Ambient platform is Android (a prior setActiveDevice), but the caller now
    // targets the iOS device by id with no explicit platform — switching must
    // honor the named device over the ambient platform, not throw.
    manager.setCurrentDevice(androidDevice, "android");

    const result = await manager.ensureDeviceReady("either", iosDevice.deviceId);
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe("ios-sim-1");
  });

  test("should resolve to active platform without deviceId when setActiveDevice was called", async () => {
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    manager.setCurrentDevice(iosDevice, "ios");

    const result = await manager.ensureDeviceReady("either");
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe("ios-sim-1");
  });

  test("should resolve ios device by providedDeviceId when no active device set", async () => {
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    const result = await manager.ensureDeviceReady("either", "ios-sim-1");
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe("ios-sim-1");
  });

  test("reserves a provided simulator through readiness verification", async () => {
    const lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory, {
      lifecycleCoordinator,
    });

    await manager.ensureDeviceReady("ios", iosDevice.deviceId);

    expect(lifecycleCoordinator.reservations).toContainEqual({
      identity: { kind: "stable", platform: "ios", stableId: iosDevice.deviceId },
      operation: "start",
    });
  });

  test("should resolve android device by providedDeviceId when no active device set", async () => {
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    const result = await manager.ensureDeviceReady("either", "emulator-5554");
    expect(result.platform).toBe("android");
    expect(result.deviceId).toBe("emulator-5554");
  });

  test("should verify current device using resolvedPlatform not raw platform when platform is 'either'", async () => {
    // This test ensures that when platform="either" and currentDevice is Android,
    // verifyDevice is called with "android" (resolvedPlatform) instead of "either" (raw platform).
    // Bug fix: previously "either" was passed to verifyDevice which treated it as iOS.
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

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

  test("reserves the current simulator through readiness verification", async () => {
    const lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory, {
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
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

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

    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

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

    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    await manager.findOrStartAndroidDevice();

    expect(fakeDeviceUtils.getWaitForDeviceReadyChildProcess()).toBe(childProcess);
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
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory, {
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

  test("reserves a warm Android emulator by stable AVD name", async () => {
    const lifecycleCoordinator = new FakeVirtualDeviceLifecycleCoordinator();
    fakeDeviceUtils.setBootedDevices("android", [
      {
        name: "Pixel_9_Pro",
        deviceId: "emulator-5554",
        platform: "android",
      },
    ]);
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory, {
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
    const manager = DeviceSessionManager.createInstance(makeProvider([androidDevice]));

    await expect(
      manager.verifyAndroidDevice(androidDevice.deviceId, { skipCtrlProxyDownload: true }),
    ).resolves.toBeUndefined();
  });

  test("ensureDeviceReady names the available devices instead of [object Object]", async () => {
    const manager = DeviceSessionManager.createInstance(makeProvider([androidDevice]));

    await expect(
      manager.ensureDeviceReady("android", "no-such-device", { skipCtrlProxyDownload: true }),
    ).rejects.toThrow(/emulator-5554/);
  });

  test("ensureDeviceReady never renders [object Object]", async () => {
    const manager = DeviceSessionManager.createInstance(makeProvider([androidDevice]));

    let message = "";
    try {
      await manager.ensureDeviceReady("android", "no-such-device", { skipCtrlProxyDownload: true });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain("[object Object]");
  });

  test("ensureDeviceReady still reports 'none' when no devices are present", async () => {
    const manager = DeviceSessionManager.createInstance(makeProvider([]));

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
    const manager = DeviceSessionManager.createInstance(makeProvider([androidDevice]));

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
    const manager = DeviceSessionManager.createInstance(makeProvider([]));

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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DeviceSessionManager } from "../../src/utils/DeviceSessionManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
import { FakeIOSCtrlProxyManager } from "../fakes/FakeIOSCtrlProxyManager";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { Window } from "../../src/features/observe/Window";
import { BootedDevice, AppearanceConfigInput } from "../../src/models";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { AndroidCtrlProxy } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import type { IOSCtrlProxy } from "../../src/features/observe/ios/IOSCtrlProxyClient";

/**
 * Inline minimal AndroidCtrlProxy stubs are produced by this helper so each
 * test can focus on the specific connection states it cares about without
 * implementing the full surface. Cast through `unknown` to satisfy the
 * structural interface where the test only reads the configured methods.
 */
function stubAndroidCtrlProxy(overrides: Partial<AndroidCtrlProxy>): AndroidCtrlProxy {
  return overrides as unknown as AndroidCtrlProxy;
}

function stubIOSCtrlProxy(overrides: Partial<IOSCtrlProxy>): IOSCtrlProxy {
  return overrides as unknown as IOSCtrlProxy;
}

describe("DeviceSessionManager", () => {
  const device: BootedDevice = {
    name: "device-1",
    deviceId: "device-1",
    platform: "android",
  };

  let fakeAdb: FakeAdbExecutor;
  let fakeDeviceUtils: FakeDeviceUtils;
  let originalGetActive: typeof Window.prototype.getActive;
  let originalAppearanceDefaults: AppearanceConfigInput;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeAdb.setDevices([device]);

    originalAppearanceDefaults = serverConfig.getAppearanceDefaults();
    serverConfig.setAppearanceDefaults({
      ...originalAppearanceDefaults,
      applyOnConnect: false,
      syncWithHost: false,
      defaultMode: "light"
    });

    originalGetActive = Window.prototype.getActive;
    Window.prototype.getActive = async function() {
      return {
        appId: "com.example.app",
        activityName: "MainActivity",
        layoutSeqSum: 0
      };
    };
  });

  afterEach(() => {
    Window.prototype.getActive = originalGetActive;
    serverConfig.setAppearanceDefaults(originalAppearanceDefaults);
  });

  test("should skip accessibility download when requested and not installed", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(false);
    accessibilityManager.setEnabled(false);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
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
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => false,
        waitForConnection: () => Promise.resolve(true),
      }),
    });
    const manager = DeviceSessionManager.createInstance(provider);
    await expect(
      manager.ensureDeviceReady("android", "device-1", { skipCtrlProxyDownload: true })
    ).rejects.toThrow("Accessibility service version mismatch");
  });

  test("should run accessibility setup by default", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(false);
    accessibilityManager.setEnabled(false);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
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
    let managerTouched = false;
    const accessibilityManager: any = new Proxy(new FakeCtrlProxyManager(), {
      get(target, prop, receiver) {
        if (prop !== "wasMethodCalled" && prop !== "constructor") {
          managerTouched = true;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubAndroidCtrlProxy({
        isConnected: () => true,
        verifyServiceReady: () => Promise.resolve(true),
      }),
    });
    const manager = DeviceSessionManager.createInstance(provider);
    await manager.ensureDeviceReady("android", "device-1");

    expect(managerTouched).toBe(false);
  });

  test("should fall through to normal flow when websocket connected but service not responsive", async () => {
    const accessibilityManager = new FakeCtrlProxyManager();
    accessibilityManager.setInstalled(true);
    accessibilityManager.setEnabled(true);

    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils, undefined, {
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

  test("regression: provider, not static getInstance, supplies CtrlProxy collaborators", async () => {
    // Wire fakes only via the provider — do NOT monkey-patch any static getInstance.
    // The DSM must obtain its CtrlProxy manager + client exclusively through the provider.
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
      ctrlProxyManager: accessibilityManager,
      ctrlProxyClient: stubClient,
    });
    const manager = DeviceSessionManager.createInstance(provider);
    await manager.ensureDeviceReady("android", "device-1");

    expect(clientFromProvider).toBeGreaterThan(0);
  });

  test("regression: FakeDeviceClientProvider throws directly when ctrlProxy fakes are missing", () => {
    // If a test wires a fake provider without ctrlProxy fakes, the provider itself
    // must fail loudly so the omission can't be silently masked by DSM's catch.
    const provider = new FakeDeviceClientProvider(fakeAdb, fakeDeviceUtils);
    expect(() => provider.getAndroidCtrlProxyClient(device)).toThrow(/ctrlProxyClient fake not configured/);
    expect(() => provider.getAndroidCtrlProxyManager(device)).toThrow(/ctrlProxyManager fake not configured/);
    expect(() => provider.getIOSCtrlProxyManager(device)).toThrow(/iosCtrlProxyManager fake not configured/);
    expect(() => provider.getIOSCtrlProxyClient(device, 8080)).toThrow(/iosCtrlProxyClient fake not configured/);
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
      defaultMode: "light"
    });
  });

  afterEach(() => {
    serverConfig.setAppearanceDefaults(originalAppearanceDefaults);
  });

  function buildIosProvider(
    fakeAdb: FakeAdbExecutor,
    fakeDeviceUtils: FakeDeviceUtils,
    fakeSimctl: FakeSimCtlClient
  ): FakeDeviceClientProvider {
    const iosManager = new FakeIOSCtrlProxyManager();
    iosManager.setSetupShouldFail(true); // skip the setup path in these tests
    return new FakeDeviceClientProvider(
      fakeAdb,
      fakeDeviceUtils,
      fakeSimctl as any,
      {
        iosCtrlProxyManager: iosManager,
        iosCtrlProxyClient: stubIOSCtrlProxy({
          isConnected: () => false,
        }),
      }
    );
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
      buildIosProvider(fakeAdb, fakeDeviceUtils, fakeSimctl)
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
      buildIosProvider(fakeAdb, fakeDeviceUtils, fakeSimctl)
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
      buildIosProvider(fakeAdb, fakeDeviceUtils, fakeSimctl)
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
      buildIosProvider(fakeAdb, fakeDeviceUtils, fakeSimctl)
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
  let originalGetActive: typeof Window.prototype.getActive;
  let originalAppearanceDefaults: AppearanceConfigInput;

  beforeEach(() => {
    fakeAdb = new FakeAdbExecutor();
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeSimctl = new FakeSimctl();
    fakeAdbFactory = { create: () => fakeAdb };

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

    originalGetActive = Window.prototype.getActive;
    Window.prototype.getActive = async function() {
      return { appId: "com.example.app", activityName: "MainActivity", layoutSeqSum: 0 };
    };
  });

  afterEach(() => {
    Window.prototype.getActive = originalGetActive;
    serverConfig.setAppearanceDefaults(originalAppearanceDefaults);
  });

  function buildProvider(): FakeDeviceClientProvider {
    const fakeCtrlProxy = new FakeCtrlProxyManager();
    fakeCtrlProxy.setInstalled(true);
    fakeCtrlProxy.setEnabled(true);
    fakeCtrlProxy.setVersionCompatible(true);

    const fakeIosManager = new FakeIOSCtrlProxyManager();
    fakeIosManager.setSetupShouldFail(true);

    return new FakeDeviceClientProvider(
      fakeAdb,
      fakeDeviceUtils,
      fakeSimctl as any,
      {
        ctrlProxyManager: fakeCtrlProxy,
        ctrlProxyClient: stubAndroidCtrlProxy({
          isConnected: () => true,
          verifyServiceReady: () => Promise.resolve(true),
        }),
        iosCtrlProxyManager: fakeIosManager,
        iosCtrlProxyClient: stubIOSCtrlProxy({ isConnected: () => false }),
      }
    );
  }

  test("should throw when both platforms connected and no active device or deviceId", async () => {
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    await expect(
      manager.ensureDeviceReady("either")
    ).rejects.toThrow("Both Android and iOS devices are connected");
  });

  test("should resolve to ios when setActiveDevice was called with ios", async () => {
    const manager = DeviceSessionManager.createInstance(buildProvider(), fakeAdbFactory);

    manager.setCurrentDevice(iosDevice, "ios");

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
});

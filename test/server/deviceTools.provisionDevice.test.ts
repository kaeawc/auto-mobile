import { AvdCreateInterruptedError } from "../../src/utils/android-cmdline-tools/AvdManagerClient";
import { provisionCancellationOutcomes } from "../../src/server/provisionCancellationOutcomes";
import {
  DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS,
  DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS,
  DeviceCleanupInProgressError,
  DeviceOwnedByOtherDaemonError,
  DeviceShuttingDownError,
  DEVICE_SHUTTING_DOWN_RETRY_AFTER_MS,
  SessionCreationTimeoutError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import { deviceAlreadyAssignedToAnotherSessionError } from "../../src/daemon/inputDeviceOwnership";
import { FakeDeviceResourceObserver } from "../fakes/FakeDeviceResourceObserver";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { warmedTests } from "../helpers/warmedTests";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { afterAll, afterEach, beforeEach, describe, expect, spyOn } from "bun:test";
import { z } from "zod/v4";
import {
  provisionDeviceSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { classifyDisplayCutout } from "../../src/utils/displayCutout";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { stubCtrlProxySetup } from "../helpers/stubCtrlProxySetup";
import type {
  ExactDeviceProvisionRequest,
  ExactDeviceProvisioner,
  ExactProvisionedDevice,
} from "../../src/devices/exactDeviceProvisioning";
import {
  DefaultExactDeviceProvisioner,
  FileAndroidAvdConfigWriter,
  ProvisionDeviceError,
} from "../../src/devices/exactDeviceProvisioning";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceResourceController } from "../fakes/FakeDeviceResourceController";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool, McpSessionRecoveryInProgressError } from "../../src/daemon/devicePool";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleCoordinator,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import { MAX_PROVISION_DEVICE_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import {
  RunnerReadinessError,
  RunnerReadinessService,
} from "../../src/ctrlProxy/RunnerReadinessService";
import { AdbDeviceOfflineError } from "../../src/utils/android-cmdline-tools/AdbDeviceHealth";
import { DaemonHandoffInterruptionError } from "../../src/daemon/daemonHandoffInterruption";
import type { BootedDevice, SomePlatform } from "../../src/models";
import type {
  BootedDeviceDiscovery,
  BootedDeviceDiscoveryOptions,
} from "../../src/devices/deviceUtils";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { resetProvisionedDeviceTransportFenceForTests } from "../../src/utils/provisionedDeviceTransportFence";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";

isolateToolRegistry();

/**
 * Pool dependencies with in-memory session-tracking and autolock persistence, so
 * no pool write reaches getDatabase() (and through a caller-exported
 * AUTOMOBILE_DB_DIR, a real file DB).
 */
function isolatedPoolDependencies(
  ...[sessionManager, daemonSessionId, overrides]: Parameters<typeof createDevicePoolDependencies>
): ReturnType<typeof createDevicePoolDependencies> {
  return createDevicePoolDependencies(sessionManager, daemonSessionId, {
    installedAppsRepository: new FakeInstalledAppsRepository(),
    deviceSessionRepository: { markAutolockSession: async () => {} },
    ...overrides,
  });
}

let policyReads = 0;
const autolockEnv = new Proxy<Record<string, string | undefined>>(
  {},
  {
    get(target, key, receiver) {
      if (key === "AUTOMOBILE_DEVICE_POOL_AUTOLOCK") {
        policyReads += 1;
      }
      return Reflect.get(target, key, receiver);
    },
  },
);

async function provisionResponseText(args: Record<string, unknown>): Promise<string> {
  const tool = ToolRegistry.getTool("provisionDevice");
  if (!tool) {
    throw new Error("provisionDevice not registered");
  }

  const response: unknown = await tool.handler(args);
  if (typeof response !== "object" || response === null || !("content" in response)) {
    throw new Error("provisionDevice returned an invalid response");
  }
  const { content } = response;
  if (!Array.isArray(content)) {
    throw new Error("provisionDevice response has no content array");
  }
  const firstContent = content[0];
  if (
    typeof firstContent !== "object" ||
    firstContent === null ||
    !("text" in firstContent) ||
    typeof firstContent.text !== "string"
  ) {
    throw new Error("provisionDevice response has no text content");
  }
  return firstContent.text;
}

class FakeExactDeviceProvisioner implements ExactDeviceProvisioner {
  readonly requests: ExactDeviceProvisionRequest[] = [];

  async provision(request: ExactDeviceProvisionRequest): Promise<ExactProvisionedDevice> {
    this.requests.push(request);
    return {
      created: true,
      device: {
        name: request.name,
        platform: request.platform,
        isRunning: false,
        runtimeId: request.spec.runtime,
        runtime: request.spec.runtime,
        deviceType: request.spec.deviceType,
        ...(request.platform === "android" && request.spec.configuration
          ? {
              screenWidth: request.spec.configuration.screenWidth,
              screenHeight: request.spec.configuration.screenHeight,
              screenDensity: request.spec.configuration.screenDensity,
            }
          : {}),
        capabilityInventory: {
          schemaVersion: 2,
          capabilities: [{ id: "test.fake.capability", state: "available" }],
        },
      },
      resolvedSpec: {
        ...request.spec,
        displayCutout: classifyDisplayCutout(request.platform, request.spec.deviceType),
      },
    };
  }
}

class StaleAndroidBootedDeviceCache extends FakeDeviceUtils {
  readonly detailedOptions: BootedDeviceDiscoveryOptions[] = [];

  override async getBootedDevices(platform: SomePlatform): Promise<BootedDevice[]> {
    if (
      platform === "android" &&
      (!this.inDetailedDiscovery || this.detailedDiscoveryUsesStaleDevices)
    ) {
      return this.staleDevices;
    }
    return await super.getBootedDevices(platform);
  }

  override async getBootedDevicesDetailed(
    platform: SomePlatform,
    options: BootedDeviceDiscoveryOptions = {},
  ): Promise<BootedDeviceDiscovery> {
    this.detailedOptions.push(options);
    this.inDetailedDiscovery = true;
    this.detailedDiscoveryUsesStaleDevices = options.bypassAndroidDeviceListCache !== true;
    try {
      return await super.getBootedDevicesDetailed(platform, options);
    } finally {
      this.inDetailedDiscovery = false;
      this.detailedDiscoveryUsesStaleDevices = false;
    }
  }

  private inDetailedDiscovery = false;
  private detailedDiscoveryUsesStaleDevices = false;
  private readonly staleDevices: BootedDevice[] = [
    { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
  ];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await Promise.resolve();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
}

type ProvisionTestPlatform = "android" | "ios";

function provisionTestArgs(platform: ProvisionTestPlatform) {
  return platform === "android"
    ? {
        device: {
          platform,
          name: "phone-api-36-a",
          spec: {
            runtime: "system-images;android-36;google_apis;x86_64",
            deviceType: "pixel_9",
          },
        },
        boot: true,
        readiness: "automation" as const,
      }
    : {
        device: {
          platform,
          name: "iPhone 17",
          spec: {
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
          },
        },
        boot: true,
        readiness: "automation" as const,
      };
}

function provisionedTestDevice(
  platform: ProvisionTestPlatform,
  created: boolean,
): ExactProvisionedDevice {
  const args = provisionTestArgs(platform);
  return {
    created,
    device: {
      name: args.device.name,
      platform,
      ...(platform === "ios" ? { deviceId: "SIM-123" } : {}),
      isRunning: false,
      runtime: args.device.spec.runtime,
      deviceType: args.device.spec.deviceType,
    },
    resolvedSpec: {
      ...args.device.spec,
      displayCutout: classifyDisplayCutout(platform, args.device.spec.deviceType),
    },
  };
}

function configureProvisionBootAndTeardown(
  manager: FakeDeviceUtils,
  platform: ProvisionTestPlatform,
): void {
  const deviceName = provisionTestArgs(platform).device.name;
  let exitListener: (() => void) | undefined;
  const processHandle: any = {
    exitCode: null,
    signalCode: null,
    once: (event: string, listener: () => void) => {
      if (event === "exit") {
        exitListener = listener;
      }
      return processHandle;
    },
    kill: () => {
      processHandle.exitCode = 0;
      manager.setBootedDevices(platform, []);
      exitListener?.();
      return true;
    },
  };
  manager.setMockChildProcess(deviceName, processHandle as any);
  const originalWaitForDeviceReady = manager.waitForDeviceReady.bind(manager);
  manager.waitForDeviceReady = async (device, timeoutMs, childProcess, signal) => {
    const booted = await originalWaitForDeviceReady(device, timeoutMs, childProcess, signal);
    const resolved = {
      ...booted,
      deviceId: platform === "android" ? "emulator-5554" : "SIM-123",
    };
    manager.setBootedDevices(platform, [resolved]);
    return resolved;
  };
  const originalKillDevice = manager.killDevice.bind(manager);
  manager.killDevice = async (device) => {
    await originalKillDevice(device);
    manager.setBootedDevices(platform, []);
  };
}

function configurePostCreateAndroidDiscoveryFailure(manager: FakeDeviceUtils): () => void {
  const getBootedDevicesDetailed = manager.getBootedDevicesDetailed.bind(manager);
  let discoveryIncompleteAfterCreate = false;
  manager.getBootedDevicesDetailed = async (...args) => {
    if (!discoveryIncompleteAfterCreate) {
      return await getBootedDevicesDetailed(...args);
    }
    discoveryIncompleteAfterCreate = false;
    manager.setAndroidDiscoveryIncomplete("adb devices failed during boot discovery");
    try {
      return await getBootedDevicesDetailed(...args);
    } finally {
      manager.failedPlatforms.delete("android");
    }
  };
  return () => {
    discoveryIncompleteAfterCreate = true;
  };
}

describe("provisionDevice handler", () => {
  let deviceManager: FakeDeviceUtils;
  let resourceObserver: FakeDeviceResourceObserver;
  let exactProvisioner: FakeExactDeviceProvisioner;
  let restorePipelineOverrides: (() => void) | undefined;

  const setup = async () => {
    // Teardown/replacement paths list active recordings. Without a fake repository
    // that read reaches getDatabase(): the unit-test guard makes it throw at once,
    // but a caller-exported AUTOMOBILE_DB_DIR stands the guard down and the real
    // file I/O reorders teardown against provisioning (and hangs the warm-up).
    await setVideoRecordingManagerDependencies({
      videoRecorderService: { listActiveRecordingIds: () => [] } as never,
      recordingRepository: new FakeVideoRecordingRepository() as never,
      configRepository: {} as never,
      highlightClient: {} as never,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });
    autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "0";
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      env: autolockEnv,
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    resourceObserver = new FakeDeviceResourceObserver();
    resourceObserver.result.resources.wallpaperRendering = {
      state: "unknown",
      reason: "Not verified in fake",
    };
    deviceManager = new FakeDeviceUtils();
    exactProvisioner = new FakeExactDeviceProvisioner();
    setDeviceToolsDependencies({
      env: autolockEnv,
      deviceResourceObserverFactory: () => resourceObserver,
      deviceManagerFactory: () => deviceManager,
      avdManagerFactory: () => ({ listDeviceImages: async () => [] }),
      exactDeviceProvisionerFactory: () => exactProvisioner,
      notifyResourcesChanged: async () => {},
      clearInstalledAppsForDevice: async () => {},
    });
    registerDeviceTools();
  };

  const cleanup = () => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    resetDeviceToolsDependencies();
    resetProvisionedDeviceTransportFenceForTests();
    resetVideoRecordingManagerDependencies();
    DaemonState.getInstance().reset();
  };

  const reset = async () => {
    cleanup();
    await setup();
  };
  const test = warmedTests(reset);
  beforeEach(reset);
  afterEach(cleanup);
  afterAll(cleanup);

  test("resource settings require booting and reject profiles and raw daemon labels", () => {
    const args = provisionTestArgs("ios");
    expect(
      provisionDeviceSchema.safeParse({
        ...args,
        boot: false,
        resources: { wallpaperRendering: "disabled" },
      }).success,
    ).toBe(false);
    expect(
      provisionDeviceSchema.safeParse({ ...args, resources: { profile: "efficient" } }).success,
    ).toBe(false);
    expect(
      provisionDeviceSchema.safeParse({ ...args, resources: { "com.apple.apsd": "disabled" } })
        .success,
    ).toBe(false);
  });

  test.each(["ios", "android"] as const)(
    "applies %s resources before automation readiness and includes verified results",
    async (platform) => {
      const resources = new FakeDeviceResourceController();
      const timer = new FakeTimer();
      const order: string[] = [];
      resources.onRequest = async () => {
        order.push("resources");
      };
      exactProvisioner.provision = async () => provisionedTestDevice(platform, false);
      deviceManager.setBootedDevices(platform, [
        {
          name: provisionTestArgs(platform).device.name,
          platform,
          deviceId: platform === "ios" ? "SIM-123" : "emulator-5554",
        },
      ]);
      setDeviceToolsDependencies({
        timer,
        deviceResourceControllerFactory: () => resources,
        ensureCtrlProxyReady: async () => {
          order.push("readiness");
        },
      });
      const args = {
        ...provisionTestArgs(platform),
        resources: { wallpaperRendering: "disabled" as const },
      };
      const response = await ToolRegistry.getTool("provisionDevice")!.handler(args);
      expect(order).toEqual(["resources", "readiness"]);
      expect(resourceObserver.requests[0]).toEqual({
        device: resources.requests[0]!.device,
        deadlineMs: timer.now() + (resources.requests[0]!.deadlineMs - timer.now()) / 2,
        signal: resources.requests[0]!.signal,
      });
      const payload = JSON.parse((response as any).content[0].text);
      expect(payload.resources?.observed).toEqual(resourceObserver.result);
      expect(resources.requests[0]!.device.platform).toBe(platform);
      expect(payload).toMatchObject({
        success: true,
        resources: { success: true, resources: { wallpaperRendering: { state: "disabled" } } },
      });
    },
  );

  test("rejects adoption when distinct running emulators claim the exact AVD name", async () => {
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5556" },
    ]);

    const response = await ToolRegistry.getTool("provisionDevice")!.handler(
      provisionTestArgs("android"),
    );

    expect((response as any).isError).toBe(true);
    expect(JSON.stringify(response)).toContain("identity_conflict");
    expect(JSON.stringify(response)).toContain("emulator-5554");
    expect(JSON.stringify(response)).toContain("emulator-5556");
    expect(deviceManager.wasMethodCalled("waitForDeviceReady")).toBe(false);
  });

  test("uses fresh Android discovery for a stale-cache identity race", async () => {
    const staleCacheManager = new StaleAndroidBootedDeviceCache();
    staleCacheManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5556" },
    ]);
    deviceManager = staleCacheManager;
    setDeviceToolsDependencies({ deviceManagerFactory: () => deviceManager });
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);

    const response = await ToolRegistry.getTool("provisionDevice")!.handler(
      provisionTestArgs("android"),
    );

    expect((response as any).isError).toBe(true);
    expect(JSON.stringify(response)).toContain("identity_conflict");
    expect(JSON.stringify(response)).toContain("emulator-5554");
    expect(JSON.stringify(response)).toContain("emulator-5556");
    expect(staleCacheManager.wasMethodCalled("waitForDeviceReady")).toBe(false);
    expect(staleCacheManager.detailedOptions.at(-1)?.bypassAndroidDeviceListCache).toBe(true);
  });

  test("fails when fresh Android discovery is incomplete", async () => {
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.failedPlatforms.add("android");

    const response = await ToolRegistry.getTool("provisionDevice")!.handler(
      provisionTestArgs("android"),
    );

    expect((response as any).isError).toBe(true);
    expect(JSON.stringify(response)).toContain("discovery_incomplete");
    expect(JSON.stringify(response)).toContain('\\"retryable\\":true');
    expect(JSON.stringify(response)).not.toContain("identity_conflict");
    expect(deviceManager.wasMethodCalled("waitForDeviceReady")).toBe(false);
    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
  });

  test("rejects adoption when a running emulator identity is unresolved", async () => {
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
      { name: "Unknown (emulator-5556)", platform: "android", deviceId: "emulator-5556" },
    ]);

    const response = await ToolRegistry.getTool("provisionDevice")!.handler(
      provisionTestArgs("android"),
    );

    expect((response as any).isError).toBe(true);
    expect(JSON.stringify(response)).toContain("discovery_incomplete");
    expect(JSON.stringify(response)).toContain('\\"retryable\\":true');
    expect(JSON.stringify(response)).toContain("AVD identity has not resolved yet; retry");
    expect(JSON.stringify(response)).not.toContain('"success":true');
    expect(deviceManager.wasMethodCalled("waitForDeviceReady")).toBe(false);
    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
  });

  test("quarantines a stale pooled identity before rejecting unresolved adoption", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    await pool.initializeWithDevices([
      {
        name: "phone-api-36-a",
        platform: "android",
        deviceId: "emulator-5556",
      },
    ]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
      { name: "Unknown (emulator-5556)", platform: "android", deviceId: "emulator-5556" },
    ]);

    try {
      const response = await ToolRegistry.getTool("provisionDevice")!.handler(
        provisionTestArgs("android"),
      );

      expect((response as any).isError).toBe(true);
      expect(JSON.stringify(response)).toContain("discovery_incomplete");
      expect(JSON.stringify(response)).toContain('\\"retryable\\":true');
      expect(deviceManager.wasMethodCalled("waitForDeviceReady")).toBe(false);
      expect(pool.isPooledIdentityUnresolved("emulator-5556")).toBe(true);
    } finally {
      sessionManager.stopCleanupTimer();
    }
  });

  test("uses the exact-discovery phase deadline signal", async () => {
    const timer = new FakeTimer();
    let discoverySignal: AbortSignal | undefined;
    const pendingDiscoveryManager = new FakeDeviceUtils();
    pendingDiscoveryManager.getBootedDevicesDetailed = async (_platform, options = {}) =>
      await new Promise<BootedDeviceDiscovery>((_resolve, reject) => {
        discoverySignal = options.signal;
        const signal = options.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    deviceManager = pendingDiscoveryManager;
    setDeviceToolsDependencies({ timer, deviceManagerFactory: () => deviceManager });
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    const requestController = new AbortController();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const responsePromise = tool.handler(
      { ...provisionTestArgs("android"), timeoutMs: 1_000 },
      undefined,
      requestController.signal,
    );
    for (let attempt = 0; discoverySignal === undefined && attempt < 50; attempt++) {
      await Promise.resolve();
    }
    expect(discoverySignal).toBeInstanceOf(AbortSignal);
    expect(discoverySignal).not.toBe(requestController.signal);

    timer.advanceTime(1_000);
    const response = await responsePromise;
    expect(discoverySignal?.aborted).toBe(true);
    expect(requestController.signal.aborted).toBe(false);
    expect(JSON.parse((response as any).content[0].text)).toMatchObject({
      success: false,
      error: { code: "timeout" },
    });
    expect(pendingDiscoveryManager.wasMethodCalled("waitForDeviceReady")).toBe(false);
    expect(pendingDiscoveryManager.wasMethodCalled("startDevice")).toBe(false);
  });

  for (const initiallyEnabled of [true, false]) {
    test(`captures provisionDevice autolock ${initiallyEnabled} before discovery`, async () => {
      autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = initiallyEnabled ? "1" : "0";
      const timer = new FakeTimer();
      const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      sessions.stopCleanupTimer();
      const firstDevice: BootedDevice = {
        name: "phone-api-36-a",
        platform: "android",
        deviceId: "emulator-5554",
      };
      const secondDevice: BootedDevice = {
        ...firstDevice,
        name: "phone-api-36-b",
        deviceId: "emulator-5556",
      };
      deviceManager.setBootedDevices("android", [firstDevice, secondDevice]);
      const pool = new DevicePool(
        isolatedPoolDependencies(sessions, "daemon", {
          env: autolockEnv,
          timer,
          deviceManager,
        }),
      );
      await pool.initializeWithDevices([firstDevice, secondDevice]);
      DaemonState.getInstance().initialize(sessions, pool);
      setDeviceToolsDependencies({ timer, ensureCtrlProxyReady: async () => {} });
      exactProvisioner.provision = async (request) => ({
        ...provisionedTestDevice("android", false),
        device: {
          ...provisionedTestDevice("android", false).device,
          name: request.name,
        },
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const discover = deviceManager.getBootedDevices.bind(deviceManager);
      let paused = false;
      deviceManager.getBootedDevices = async (platform) => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return discover(platform);
      };
      const firstArgs = {
        ...provisionTestArgs("android"),
        __mcpSessionId: "first",
      };
      policyReads = 0;
      const pending = provisionResponseText(firstArgs);
      await entered.promise;
      autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = initiallyEnabled ? "0" : "1";
      release.resolve();
      expect(JSON.parse(await pending).sessionId).toEqual(expect.any(String));
      expect(Boolean(pool.getDevice(firstDevice.deviceId)?.autolockSessionId)).toBe(
        initiallyEnabled,
      );
      expect(policyReads).toBe(1);
      const secondArgs = {
        ...provisionTestArgs("android"),
        __mcpSessionId: "second",
        device: {
          ...firstArgs.device,
          name: secondDevice.name,
        },
      };
      expect(JSON.parse(await provisionResponseText(secondArgs)).sessionId).toEqual(
        expect.any(String),
      );
      expect(Boolean(pool.getDevice(secondDevice.deviceId)?.autolockSessionId)).toBe(
        !initiallyEnabled,
      );
    });
  }

  test("adopts a single Android device from fresh discovery", async () => {
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    setDeviceToolsDependencies({ ensureCtrlProxyReady: async () => {} });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler(
      provisionTestArgs("android"),
    );

    expect((response as any).isError).not.toBe(true);
    expect(JSON.stringify(response)).not.toContain("identity_conflict");
  });

  test("adopts a fresh exact Android transport when ordinary discovery is stale", async () => {
    const staleCacheManager = new StaleAndroidBootedDeviceCache();
    staleCacheManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5556" },
    ]);
    deviceManager = staleCacheManager;
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceManager,
      ensureCtrlProxyReady: async () => {},
    });
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);

    const response = await ToolRegistry.getTool("provisionDevice")!.handler(
      provisionTestArgs("android"),
    );

    expect((response as any).isError).not.toBe(true);
    expect(JSON.parse((response as any).content[0].text)).toMatchObject({
      created: false,
      adopted: true,
      device: {
        runtime: expect.objectContaining({ deviceId: "emulator-5556" }),
        name: "phone-api-36-a",
      },
    });
    expect(staleCacheManager.getExecutedOperations().join("|")).not.toContain("startDevice:");
    expect(staleCacheManager.detailedOptions).toEqual(
      expect.arrayContaining([expect.objectContaining({ bypassAndroidDeviceListCache: true })]),
    );
  });

  test("fresh provisioning surfaces an observation contradiction while retaining the device", async () => {
    const controller = new FakeDeviceResourceController();
    resourceObserver.result.resources.wallpaperRendering = { state: "enabled" };
    exactProvisioner.provision = async () => provisionedTestDevice("android", true);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    setDeviceToolsDependencies({
      deviceResourceControllerFactory: () => controller,
      ensureCtrlProxyReady: async () => {},
    });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      resources: { wallpaperRendering: "disabled" },
    });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: false,
      created: true,
      resources: {
        ...controller.result,
        success: false,
        observed: resourceObserver.result,
        observationContradictions: ["wallpaperRendering"],
      },
    });
  });

  test("observation cancellation prevents provision readiness and binding", async () => {
    const controller = new FakeDeviceResourceController();
    const abort = new AbortController();
    let readinessCalls = 0;
    resourceObserver.onRequest = async () => {
      abort.abort(new Error("observation preempted"));
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    setDeviceToolsDependencies({
      deviceResourceControllerFactory: () => controller,
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
      },
    });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler(
      {
        ...provisionTestArgs("android"),
        resources: { wallpaperRendering: "disabled" },
      },
      undefined,
      abort.signal,
    );
    expect(response.isError).toBe(true);
    expect(readinessCalls).toBe(0);
    expect(resourceObserver.requests).toHaveLength(1);
    expect(JSON.parse(response.content[0].text).sessionId).toBeUndefined();
  });
  test("resource timeout leaves readiness time and returns the retained device and session", async () => {
    const timer = new FakeTimer();
    const resources = new FakeDeviceResourceController();
    resources.result.success = false;
    resources.result.resources = { wallpaperRendering: { state: "unknown", reason: "timed out" } };
    resources.onRequest = async (request) => {
      timer.advanceTime(request.deadlineMs - timer.now());
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", true);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    let readinessBudget = 0;
    setDeviceToolsDependencies({
      timer,
      deviceResourceControllerFactory: () => resources,
      ensureCtrlProxyReady: async ({ totalDeadlineMs }) => {
        readinessBudget = totalDeadlineMs - timer.now();
        if (readinessBudget <= 0) {
          throw new Error("No readiness budget remaining");
        }
      },
    });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      timeoutMs: 60_000,
      resources: { wallpaperRendering: "disabled" },
    });
    expect(readinessBudget).toBeGreaterThan(0);
    expect((response as any).isError).toBe(true);
    const payload = JSON.parse((response as any).content[0].text);
    expect(Object.hasOwn(payload, "sessionUuid")).toBe(false);
    expect(Object.hasOwn(payload, "sessionId")).toBe(true);
    expect(payload).toMatchObject({
      success: false,
      created: true,
      device: { runtime: expect.objectContaining({ deviceId: "emulator-5554" }) },
      sessionId: expect.any(String),
      readiness: { status: "automation_ready" },
      resources: { success: false, resources: { wallpaperRendering: { state: "unknown" } } },
    });
  });

  test("teardown preemption after resource configuration prevents readiness and session binding", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const resources = new FakeDeviceResourceController();
    let teardown: ReturnType<typeof coordinator.reserve> | undefined;
    let readinessCalls = 0;
    resources.onRequest = async (request) => {
      teardown = coordinator.reserve(
        { kind: "stable", platform: "android", stableId: "phone-api-36-a" },
        { operation: "teardown", deadlineMs: 60_000 },
      );
      expect(request.signal?.aborted).toBe(true);
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: coordinator,
      deviceResourceControllerFactory: () => resources,
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
      },
    });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      timeoutMs: 60_000,
      resources: { wallpaperRendering: "disabled" },
    });
    const lease = await teardown;
    lease?.release();
    expect(readinessCalls).toBe(0);
    expect((response as any).isError).toBe(true);
    expect(JSON.parse((response as any).content[0].text).sessionId).toBeUndefined();
  });

  test("unsupported resources return an explicit error while preserving the provisioned identity", async () => {
    const resources = new FakeDeviceResourceController();
    resources.result.success = false;
    resources.result.resources = {
      wallpaperRendering: { state: "unsupported", reason: "Android control deferred" },
    };
    resources.result.changed = [];
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    setDeviceToolsDependencies({ deviceResourceControllerFactory: () => resources });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      readiness: "none",
      resources: { wallpaperRendering: "disabled" },
    });
    expect((response as any).isError).toBe(true);
    expect(JSON.parse((response as any).content[0].text)).toMatchObject({
      success: false,
      device: { runtime: expect.objectContaining({ deviceId: "emulator-5554" }) },
      resources: { resources: { wallpaperRendering: { state: "unsupported" } } },
    });
  });

  const SIM_UDID = "A1B2C3D4-0000-4000-8000-000000000001";
  const simDevice = () => ({
    ...provisionedTestDevice("ios", false).device,
    deviceId: SIM_UDID,
  });

  const setupSimulator = (created: boolean, resources: FakeDeviceResourceController) => {
    exactProvisioner.provision = async () => ({
      ...provisionedTestDevice("ios", created),
      device: simDevice(),
    });
    deviceManager.setBootedDevices("ios", [
      {
        name: provisionTestArgs("ios").device.name,
        platform: "ios",
        deviceId: SIM_UDID,
      },
    ]);
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(new FakeTimer());
    let readinessCalls = 0;
    setDeviceToolsDependencies({
      lifecycleCoordinator: coordinator,
      deviceResourceControllerFactory: () => resources,
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
      },
    });
    return { coordinator, readinessCalls: () => readinessCalls };
  };

  const expectDeviceFree = async (coordinator: InMemoryVirtualDeviceLifecycleCoordinator) => {
    const lease = await coordinator.reserve(
      { kind: "stable", platform: "ios", stableId: SIM_UDID },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    lease.release();
  };

  test("iOS simulator profile (#6695): an unproven profile fails with typed drift, binds no session and frees the device", async () => {
    const resources = new FakeDeviceResourceController();
    resources.result.requested = { wallpaperRendering: "disabled", widgets: "disabled" };
    resources.result.resources = {
      wallpaperRendering: { state: "disabled" },
      widgets: { state: "disabled" },
    };
    resourceObserver.result.resources.wallpaperRendering = { state: "disabled" };
    resourceObserver.result.resources.widgets = { state: "enabled" };
    const harness = setupSimulator(false, resources);

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("ios"),
      resources: { wallpaperRendering: "disabled", widgets: "disabled" },
    });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.sessionId).toBeUndefined();
    expect(payload.error).toMatchObject({
      code: "resource_profile_unproven",
      retryable: false,
      resourceDrift: [
        {
          resource: "widgets",
          kind: "missingRequested",
          expected: "disabled",
          observed: { state: "enabled" },
        },
      ],
    });
    expect(payload.error.message).toContain("widgets (missingRequested");
    expect(payload.error.message).not.toContain("wallpaperRendering (");
    expect(harness.readinessCalls()).toBe(0);
    // Partial transition: the override that did land stays (no compensating write)
    // and remains recorded as AutoMobile-owned, so a retry or reconcile sees it.
    expect(resources.requests).toHaveLength(1);
    await expectDeviceFree(harness.coordinator);
  });

  test("iOS simulator profile (#6695): an unsupported resource rolls back a device this operation created", async () => {
    const resources = new FakeDeviceResourceController();
    resources.result.success = false;
    resources.result.resources = {
      wallpaperRendering: { state: "unsupported", reason: "group not installed" },
    };
    resourceObserver.result.resources.wallpaperRendering = { state: "unsupported" };
    const provisioned = { ...provisionedTestDevice("ios", true), device: simDevice() };
    configureProvisionBootAndTeardown(deviceManager, "ios");
    const bootWait = deviceManager.waitForDeviceReady.bind(deviceManager);
    deviceManager.waitForDeviceReady = async (...args) => ({
      ...(await bootWait(...args)),
      deviceId: SIM_UDID,
    });
    let readinessCalls = 0;
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages("ios", [provisioned.device]);
          return provisioned;
        },
      }),
      deviceResourceControllerFactory: () => resources,
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
      },
      idGenerator: new FakeIdGenerator(["cleanup-sim"]),
    });
    registerDeviceTools();

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("ios"),
      resources: { wallpaperRendering: "disabled" },
    });

    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.sessionId).toBeUndefined();
    expect(payload.error.code).toBe("resource_profile_unproven");
    expect(payload.error.resourceDrift).toMatchObject([
      { resource: "wallpaperRendering", kind: "unsupported" },
    ]);
    expect(payload.cleanup).toMatchObject({ status: "succeeded", state: "destroyed" });
    // A clean rollback is not a cleanup failure.
    expect(payload.recovery.boundary).not.toBe("cleanup_failure");
    expect(readinessCalls).toBe(0);
    expect(await deviceManager.listDeviceImages("ios")).toEqual([]);
  });

  test("iOS simulator profile (#6695): unreadable evidence everywhere is a retryable command failure with its drift", async () => {
    const resources = new FakeDeviceResourceController();
    resources.result.resources = { wallpaperRendering: { state: "unknown" } };
    resourceObserver.result.resources.wallpaperRendering = {
      state: "unknown",
      reason: "launchctl timed out",
    };
    const harness = setupSimulator(false, resources);
    const args = {
      ...provisionTestArgs("ios"),
      resources: { wallpaperRendering: "disabled" as const },
    };

    const response = await ToolRegistry.getTool("provisionDevice")!.handler(args);

    const payload = JSON.parse(response.content[0].text);
    expect(payload.error.retryable).toBe(true);
    expect(payload.error.resourceDrift).toMatchObject([
      { resource: "wallpaperRendering", kind: "commandFailure" },
    ]);
    expect(payload.sessionId).toBeUndefined();
    await expectDeviceFree(harness.coordinator);
  });

  test.each([
    ["unknown", { state: "unknown", reason: "launchctl timed out" }],
    ["unsupported", { state: "unsupported" }],
  ] as const)(
    "iOS simulator profile (#11028): an observed %s never overrides a state the controller proved",
    async (_name, observed) => {
      const resources = new FakeDeviceResourceController();
      resourceObserver.result.resources.wallpaperRendering = observed;
      const harness = setupSimulator(false, resources);

      const response = await ToolRegistry.getTool("provisionDevice")!.handler({
        ...provisionTestArgs("ios"),
        resources: { wallpaperRendering: "disabled" },
      });

      expect(response.isError).not.toBe(true);
      expect(JSON.parse(response.content[0].text).sessionId).toEqual(expect.any(String));
      expect(harness.readinessCalls()).toBe(1);
    },
  );

  test("iOS simulator profile (#6695): a proven profile binds the session", async () => {
    const resources = new FakeDeviceResourceController();
    resourceObserver.result.resources.wallpaperRendering = { state: "disabled" };
    const harness = setupSimulator(false, resources);

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("ios"),
      resources: { wallpaperRendering: "disabled" },
    });

    expect(response.isError).not.toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.sessionId).toEqual(expect.any(String));
    expect(payload.resources.success).toBe(true);
    expect(harness.readinessCalls()).toBe(1);
  });

  test("accepts omitted boot and readiness with their documented defaults", () => {
    expect(
      provisionDeviceSchema.parse({
        device: {
          platform: "android",
          name: "phone-api-36-a",
          spec: {
            runtime: "system-images;android-36;google_apis;x86_64",
            deviceType: "pixel_9",
          },
        },
      }),
    ).toMatchObject({
      boot: true,
      readiness: "automation",
    });
  });

  test("reserves enough outer request time for bounded rollback", () => {
    const args = provisionTestArgs("android");

    expect(
      provisionDeviceSchema.parse({ ...args, timeoutMs: MAX_PROVISION_DEVICE_TIMEOUT_MS })
        .timeoutMs,
    ).toBe(MAX_PROVISION_DEVICE_TIMEOUT_MS);
    expect(() =>
      provisionDeviceSchema.parse({ ...args, timeoutMs: MAX_PROVISION_DEVICE_TIMEOUT_MS + 1 }),
    ).toThrow();
  });

  test("accepts only documented display-cutout preferences", () => {
    const input = {
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
          displayCutout: "hole_punch",
        },
      },
    };

    expect(provisionDeviceSchema.parse(input).device.spec).toMatchObject({
      displayCutout: "hole_punch",
    });
    expect(() =>
      provisionDeviceSchema.parse({
        ...input,
        device: {
          ...input.device,
          spec: { ...input.device.spec, displayCutout: "camera" },
        },
      }),
    ).toThrow();
  });

  test("advertises the platform-discriminated device schema with deterministic anyOf", () => {
    const definition = ToolRegistry.getToolDefinitions().find(
      (candidate) => candidate.name === "provisionDevice",
    );
    const properties = definition?.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;

    expect(properties?.device.oneOf).toBeUndefined();
    expect(properties?.device.anyOf).toBeArray();
  });

  test.each([
    "system-images;android-36;google_apis_playstore;x86_64",
    "system-images;android-36.1;google_apis_playstore;x86_64",
  ])("rejects unbootable memory for modern Play Store Android image %s", (runtime) => {
    expect(() =>
      provisionDeviceSchema.parse({
        device: {
          platform: "android",
          name: "phone-api-36-play",
          spec: {
            runtime,
            deviceType: "pixel_9",
            configuration: { memoryMb: 1024 },
          },
        },
      }),
    ).toThrow(/at least 2048/);
  });

  test.each([
    [
      "Play Store RAM below the product floor",
      {
        ...provisionTestArgs("android"),
        device: {
          ...provisionTestArgs("android").device,
          spec: {
            runtime: "system-images;android-36;google_apis_playstore;x86_64",
            deviceType: "pixel_9",
            configuration: { memoryMb: 1024 },
          },
        },
      },
    ],
    [
      "Android device with an iOS runtime",
      {
        ...provisionTestArgs("android"),
        device: {
          ...provisionTestArgs("android").device,
          spec: {
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            deviceType: "pixel_9",
          },
        },
      },
    ],
    [
      "iOS device with Android-only configuration",
      {
        ...provisionTestArgs("ios"),
        device: {
          ...provisionTestArgs("ios").device,
          spec: {
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
            configuration: { memoryMb: 4096 },
          },
        },
      },
    ],
  ] as const)(
    "rejects %s through the provisionDevice product handler before provisioning",
    async (_description, input) => {
      const response = await ToolRegistry.getTool("provisionDevice")!.handler(input);

      expect((response as any).isError).toBe(true);
      expect(exactProvisioner.requests).toHaveLength(0);
    },
  );

  test.each([
    ["system-images;android-36;google_apis_playstore;x86_64", 2048],
    ["system-images;android-36.1;google_apis_playstore;x86_64", 2048],
    ["system-images;android-36.1;google_apis;x86_64", 1024],
  ] as const)("accepts supported memory for Android image %s", (runtime, memoryMb) => {
    expect(
      provisionDeviceSchema.parse({
        device: {
          platform: "android",
          name: "phone-api-36",
          spec: {
            runtime,
            deviceType: "pixel_9",
            configuration: { memoryMb },
          },
        },
      }).device.spec.configuration?.memoryMb,
    ).toBe(memoryMb);
  });

  // #11065: a repeated call is a fresh provision, never a stored-result replay.
  test("creates the caller-specified device and runs every call through the provisioner", async () => {
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      device: {
        platform: "android",
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
          displayCutout: "hole_punch",
          configuration: {
            memoryMb: 4096,
            screenWidth: 1080,
            screenHeight: 2400,
            screenDensity: 420,
          },
        },
      },
      boot: false,
      readiness: "automation",
    };

    const first = JSON.parse(
      (
        (await tool.handler({
          ...args,
          __mcpSessionId: "mcp-session-5434",
          __executionId: "execution-5434",
          __executionStartTime: 0,
        } as any)) as any
      ).content[0].text,
    );
    const second = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(exactProvisioner.requests).toHaveLength(2);
    expect(exactProvisioner.requests[0]).toMatchObject({
      platform: "android",
      name: "phone-api-36-a",
      spec: {
        runtime: "system-images;android-36;google_apis;x86_64",
        deviceType: "pixel_9",
        displayCutout: "hole_punch",
        configuration: {
          memoryMb: 4096,
          screenWidth: 1080,
          screenHeight: 2400,
          screenDensity: 420,
        },
      },
    });
    expect(exactProvisioner.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(first).toMatchObject({
      created: true,
      adopted: false,
      lifecycleState: "created",
      readiness: { status: "not_requested" },
      device: {
        name: "phone-api-36-a",
        platform: "android",
        runtimeId: "system-images;android-36;google_apis;x86_64",
        deviceType: "pixel_9",
        display: { width: 1080, height: 2400, density: 420 },
        capabilityInventory: expect.any(Object),
      },
      displayCutout: "hole_punch",
    });
    expect(first).not.toHaveProperty("operationId");
    expect(second).toMatchObject({ created: true, lifecycleState: "created" });
  });

  test("provisionDevice.device preserves the configured display and capability inventory", async () => {
    const image = {
      name: "phone-api-36-parity",
      platform: "android" as const,
      isRunning: false,
      runtimeId: "system-images;android-36;google_apis;x86_64",
      runtime: "system-images;android-36;google_apis;x86_64",
      deviceType: "pixel_9",
      screenWidth: 1080,
      screenHeight: 2400,
      screenDensity: 420,
      capabilityInventory: {
        schemaVersion: 2,
        capabilities: [{ id: "test.fake.capability", state: "available" as const }],
      },
    };
    deviceManager.setDeviceImages("android", [image]);
    deviceManager.setBootedDevices("android", [
      { name: image.name, platform: "android", deviceId: "emulator-5554" },
    ]);
    const provisionTool = ToolRegistry.getTool("provisionDevice")!;
    const provisioned = JSON.parse(
      (
        (await provisionTool.handler({
          device: {
            platform: "android",
            name: image.name,
            spec: { runtime: image.runtimeId, deviceType: image.deviceType },
          },
          boot: true,
          readiness: "none",
        })) as any
      ).content[0].text,
    );
    const listed = JSON.parse(
      ((await ToolRegistry.getTool("listDevices")!.handler({ platform: "android" })) as any)
        .content[0].text,
    );

    expect(provisioned.device.display).toEqual(listed.devices[0].display);
    expect(provisioned.device.capabilityInventory).toEqual(listed.devices[0].capabilityInventory);
  });

  // #11065: without stored replays, the lifecycle lease is what serializes a
  // repeated provision behind a concurrent teardown of the same exact device.
  test("a repeated Android provision waits for a concurrent teardown's lifecycle lease", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    setDeviceToolsDependencies({ timer, lifecycleCoordinator });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: false,
      readiness: "none" as const,
    };
    await tool.handler(args);
    await Promise.resolve();
    const teardownLease = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "android", stableId: args.device.name },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    let repeatSettled = false;
    const repeat = tool.handler(args).finally(() => {
      repeatSettled = true;
    });

    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }
    expect(repeatSettled).toBe(false);
    expect(exactProvisioner.requests).toHaveLength(1);

    teardownLease.release();
    await repeat;
    expect(exactProvisioner.requests).toHaveLength(2);
  });

  test("a repeated iOS provision waits for a concurrent teardown's lifecycle lease", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    setDeviceToolsDependencies({ timer, lifecycleCoordinator });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      ...provisionTestArgs("ios"),
      boot: false,
      readiness: "none" as const,
    };
    exactProvisioner.provision = async (request) => {
      exactProvisioner.requests.push(request);
      return provisionedTestDevice("ios", false);
    };
    await tool.handler(args);
    await Promise.resolve();
    deviceManager.setDeviceImages("ios", [provisionedTestDevice("ios", false).device]);
    const teardownLease = await lifecycleCoordinator.reserve(
      { kind: "stable", platform: "ios", stableId: "SIM-123" },
      { operation: "teardown", deadlineMs: 1_000 },
    );
    let repeatSettled = false;
    const repeat = tool.handler(args).finally(() => {
      repeatSettled = true;
    });

    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }
    expect(repeatSettled).toBe(false);
    expect(exactProvisioner.requests).toHaveLength(1);

    teardownLease.release();
    await repeat;
    expect(exactProvisioner.requests).toHaveLength(2);
  });

  test("boots the exact device and runs automation readiness when requested", async () => {
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    let readinessRequest: unknown;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async (request) => {
        readinessRequest = request;
      },
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const result = JSON.parse(
      (
        (await tool.handler({
          device: {
            platform: "android",
            name: "phone-api-36-a",
            spec: {
              runtime: "system-images;android-36;google_apis;x86_64",
              deviceType: "pixel_9",
            },
          },
          boot: true,
          readiness: "automation",
        })) as any
      ).content[0].text,
    );

    expect(deviceManager.wasMethodCalled("startDevice")).toBe(true);
    expect(readinessRequest).toMatchObject({
      device: { name: "phone-api-36-a", platform: "android" },
    });
    const sessionId = result.sessionId;
    const runtimeSessionUuid = result.device.runtime.session.sessionUuid;
    expect(result).toMatchObject({
      lifecycleState: "ready",
      readiness: { mode: "automation", status: "automation_ready" },
      sessionId: expect.any(String),
      device: {
        runtime: {
          session: { sessionUuid: expect.any(String) },
          readiness: { state: "ready" },
        },
      },
    });
    expect(runtimeSessionUuid).toBe(sessionId);
  });

  test.each(["android", "ios"] as const)(
    "exposes sessionId without a top-level sessionUuid for fresh booted %s provisioning",
    async (platform) => {
      exactProvisioner.provision = async () => provisionedTestDevice(platform, false);
      deviceManager.setBootedDevices(platform, [
        {
          name: provisionTestArgs(platform).device.name,
          platform,
          deviceId: platform === "android" ? "emulator-5554" : "SIM-123",
        },
      ]);

      const response = JSON.parse(
        (
          (await ToolRegistry.getTool("provisionDevice")!.handler({
            ...provisionTestArgs(platform),
            readiness: "none",
          })) as any
        ).content[0].text,
      );

      expect(response.sessionId).toEqual(expect.any(String));
      expect(Object.hasOwn(response, "sessionUuid")).toBe(false);
      expect(Object.hasOwn(response, "sessionId")).toBe(true);
    },
  );

  test.each(["android", "ios"] as const)(
    "does not expose a session for boot:false %s provisioning",
    async (platform) => {
      const response = JSON.parse(
        (
          (await ToolRegistry.getTool("provisionDevice")!.handler({
            ...provisionTestArgs(platform),
            boot: false,
            readiness: "none",
          })) as any
        ).content[0].text,
      );

      expect(Object.hasOwn(response, "sessionUuid")).toBe(false);
      expect(Object.hasOwn(response, "sessionId")).toBe(false);
    },
  );

  for (const platform of ["android", "ios"] as const) {
    test(`${platform}: cleans up a newly created device when readiness fails`, async () => {
      const provisioned = provisionedTestDevice(platform, true);
      configureProvisionBootAndTeardown(deviceManager, platform);
      const provisioner: ExactDeviceProvisioner = {
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages(platform, [provisioned.device]);
          return provisioned;
        },
      };
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => provisioner,
        ensureCtrlProxyReady: async () => {
          throw new Error("runner readiness failed");
        },
        idGenerator: new FakeIdGenerator([`cleanup-${platform}`]),
      });
      registerDeviceTools();
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }

      const response = JSON.parse(
        ((await tool.handler(provisionTestArgs(platform))) as any).content[0].text,
      );

      expect(response).toMatchObject({
        success: false,
        error: { code: "platform_command_failed" },
        provisionFailure: {
          code: "platform_command_failed",
          message: expect.stringContaining("runner readiness failed"),
        },
        cleanup: {
          status: "succeeded",
          state: "destroyed",
        },
      });
      expect(deviceManager.getExecutedOperations()).toContainEqual(
        expect.stringContaining(`destroyDevice:${platform}:`),
      );
      expect(await deviceManager.listDeviceImages(platform)).toEqual([]);
    });

    test(`${platform}: never deletes an adopted device when readiness fails`, async () => {
      const provisioned = provisionedTestDevice(platform, false);
      configureProvisionBootAndTeardown(deviceManager, platform);
      deviceManager.setDeviceImages(platform, [provisioned.device]);
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => ({
          provision: async () => provisioned,
        }),
        ensureCtrlProxyReady: async () => {
          throw new Error("runner readiness failed");
        },
      });
      registerDeviceTools();
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }

      const response = JSON.parse(
        ((await tool.handler(provisionTestArgs(platform))) as any).content[0].text,
      );

      expect(response).toMatchObject({
        success: false,
        error: { code: "platform_command_failed" },
      });
      expect(response.cleanup).toBeUndefined();
      expect(deviceManager.getExecutedOperations()).not.toContainEqual(
        expect.stringContaining("destroyDevice:"),
      );
      expect(await deviceManager.listDeviceImages(platform)).toEqual([provisioned.device]);
    });

    test(`${platform}: reports a structured cleanup failure without false success`, async () => {
      const timer = new FakeTimer();
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
      const provisioned = provisionedTestDevice(platform, true);
      configureProvisionBootAndTeardown(deviceManager, platform);
      const provisioner: ExactDeviceProvisioner = {
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages(platform, [provisioned.device]);
          return provisioned;
        },
      };
      let destroyCalls = 0;
      deviceManager.destroyDevice = async () => {
        destroyCalls++;
        throw new Error("platform delete failed");
      };
      setDeviceToolsDependencies({
        timer,
        lifecycleCoordinator,
        exactDeviceProvisionerFactory: () => provisioner,
        ensureCtrlProxyReady: async () => {
          throw new Error("runner readiness failed");
        },
        idGenerator: new FakeIdGenerator([`cleanup-failure-${platform}`]),
      });
      registerDeviceTools();
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }

      const response = JSON.parse(
        ((await tool.handler(provisionTestArgs(platform))) as any).content[0].text,
      );

      expect(response).toMatchObject({
        success: false,
        error: {
          code: "cleanup_failed",
          message: expect.stringContaining("platform delete failed"),
        },
        provisionFailure: {
          code: "platform_command_failed",
          message: expect.stringContaining("runner readiness failed"),
        },
        cleanup: {
          status: "failed",
          failure: {
            code: "operation_failed",
            phase: "destroy",
            message: expect.stringContaining("platform delete failed"),
          },
        },
      });
      expect(destroyCalls).toBe(1);

      const releasedLease = await lifecycleCoordinator.reserve(
        {
          kind: "stable",
          platform,
          stableId: platform === "android" ? provisioned.device.name : "SIM-123",
        },
        { operation: "provision", deadlineMs: timer.now() + 1 },
      );
      releasedLease.release();
    });

    // #11065: a retry after a rolled-back failure is a fresh provision; the
    // removed device is not resurrected from a stored failure.
    test(`${platform}: retries a removed lifecycle as a fresh provision`, async () => {
      const provisioned = provisionedTestDevice(platform, true);
      configureProvisionBootAndTeardown(deviceManager, platform);
      let provisionCalls = 0;
      const provisioner: ExactDeviceProvisioner = {
        provision: async (request) => {
          provisionCalls++;
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages(platform, [provisioned.device]);
          return provisioned;
        },
      };
      let readinessCalls = 0;
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => provisioner,
        ensureCtrlProxyReady: async () => {
          readinessCalls++;
          if (readinessCalls === 1) {
            throw new Error("first readiness attempt failed");
          }
        },
        idGenerator: new FakeIdGenerator([`cleanup-retry-${platform}`]),
      });
      registerDeviceTools();
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }
      const args = provisionTestArgs(platform);

      const failed = JSON.parse(((await tool.handler(args)) as any).content[0].text);
      const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);

      expect(failed).toMatchObject({
        success: false,
        cleanup: { status: "succeeded" },
      });
      expect(failed.lifecycle).toMatchObject({
        state: "removed",
        phase: "cleanup",
        cleanup: { status: "succeeded" },
        device: {
          name: provisioned.device.name,
          platform,
          runtimeDeviceId: platform === "android" ? "emulator-5554" : "SIM-123",
        },
      });
      expect(retried).toMatchObject({ created: true, lifecycleState: "ready" });
      expect(provisionCalls).toBe(2);
      expect(readinessCalls).toBe(2);
    });
  }

  // #11065: concurrent provisions of the same exact device are serialized by
  // the lifecycle lease, so the second one adopts what the first created.
  test("serializes concurrent provisions of the same device so only one creates it", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const created = provisionedTestDevice("android", true);
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    let provisionCalls = 0;
    let inProvisioner = 0;
    let maxConcurrent = 0;
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls++;
          inProvisioner++;
          maxConcurrent = Math.max(maxConcurrent, inProvisioner);
          try {
            if ((await deviceManager.listDeviceImages("android")).length > 0) {
              return { ...created, created: false };
            }
            request.onBeforeCreate?.();
            deviceManager.setDeviceImages("android", [created.device]);
            firstEntered.resolve();
            await releaseFirst.promise;
            return created;
          } finally {
            inProvisioner--;
          }
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice")!;
    const args = { ...provisionTestArgs("android"), boot: false, readiness: "none" as const };

    const first = tool.handler(args);
    await firstEntered.promise;
    const second = tool.handler(args);
    await flushMicrotasks();
    expect(provisionCalls).toBe(1);

    releaseFirst.resolve();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);

    expect(JSON.parse((firstResponse as any).content[0].text)).toMatchObject({
      created: true,
      adopted: false,
    });
    expect(JSON.parse((secondResponse as any).content[0].text)).toMatchObject({
      created: false,
      adopted: true,
    });
    expect(provisionCalls).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  test("rolls back before a queued provision for the same device begins", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const provisioned = provisionedTestDevice("android", true);
    const firstReadinessStarted = Promise.withResolvers<void>();
    const failFirstReadiness = Promise.withResolvers<void>();
    let readinessCalls = 0;
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [provisioned.device]);
          return provisioned;
        },
      }),
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 1) {
          firstReadinessStarted.resolve();
          await failFirstReadiness.promise;
          throw new Error("first readiness attempt failed");
        }
      },
      idGenerator: new FakeIdGenerator(["cleanup-queued-provision"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const first = tool.handler(provisionTestArgs("android"));
    await firstReadinessStarted.promise;
    let secondSettled = false;
    const second = tool.handler(provisionTestArgs("android")).finally(() => {
      secondSettled = true;
    });

    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }
    expect(secondSettled).toBe(false);

    failFirstReadiness.resolve();
    const firstResponse = JSON.parse(((await first) as any).content[0].text);
    const secondResponse = JSON.parse(((await second) as any).content[0].text);

    expect(firstResponse).toMatchObject({
      success: false,
      cleanup: { status: "succeeded" },
    });
    expect(secondResponse).toMatchObject({
      lifecycleState: "ready",
      readiness: { status: "automation_ready" },
    });
  });

  test("cleans up an Android AVD created before exact provisioning fails", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [created.device]);
          throw new Error("writing AVD memory configuration failed");
        },
      }),
      idGenerator: new FakeIdGenerator(["cleanup-partial-android"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      ((await tool.handler(provisionTestArgs("android"))) as any).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      cleanup: { status: "succeeded" },
    });
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);
  });

  // At the boot limit each provision created the AVD, was refused at boot, then deleted it
  // (#11236): a read-only capacity check now refuses before creating.
  for (const boot of [true, false]) {
    test(`checks boot capacity before creating only when booting (boot=${boot})`, async () => {
      const timer = new FakeTimer();
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
      configureProvisionBootAndTeardown(deviceManager, "android");
      const createdAvds: string[] = [];
      const capacityChecks: string[] = [];
      setDeviceToolsDependencies({
        timer,
        lifecycleCoordinator,
        checkBootCapacity: async (platform) => {
          capacityChecks.push(platform);
          throw new BootCapacityExhaustedError(
            { platform, limit: 1, booted: 1, retryAfterMs: 5_000 },
            "Refused to boot: no Android capacity",
          );
        },
        exactDeviceProvisionerFactory: (manager, creationGate) =>
          new DefaultExactDeviceProvisioner({
            listDeviceImages: async (platform) => await manager.listDeviceImages(platform),
            isCreationAllowed: (createIfMissing) => creationGate.isCreationAllowed(createIfMissing),
            avdManager: {
              createAvd: async ({ name }) => {
                createdAvds.push(name);
                deviceManager.setDeviceImages("android", [
                  { name, platform: "android", isRunning: false },
                ]);
                return { success: true, message: "created", avdName: name };
              },
            },
            androidConfigReader: { readConfig: async () => undefined },
            androidConfigWriter: { setMemoryMb: async () => {} },
            iosSimulator: {
              createSimulator: async () => {
                throw new Error("unexpected iOS simulator creation");
              },
            },
            lifecycleCoordinator,
            timer,
          }),
      });
      registerDeviceTools();

      const response = JSON.parse(
        await provisionResponseText({
          ...provisionTestArgs("android"),
          boot,
          readiness: "none" as const,
        }),
      );

      if (boot) {
        expect(response).toMatchObject({
          success: false,
          error: { code: "capacity_exhausted", retryable: true, retryAfterMs: 5_000 },
        });
        expect(capacityChecks).toEqual(["android"]);
        expect(createdAvds).toEqual([]);
      } else {
        expect(capacityChecks).toEqual([]);
        expect(createdAvds).toEqual(["phone-api-36-a"]);
      }
    });
  }

  test("does not delete an AVD whose creation avdmanager rejected (#11100)", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: (manager, creationGate) =>
        new DefaultExactDeviceProvisioner({
          listDeviceImages: async (platform) => await manager.listDeviceImages(platform),
          isCreationAllowed: (createIfMissing) => creationGate.isCreationAllowed(createIfMissing),
          avdManager: {
            createAvd: async ({ name }) => {
              // A racing external create landed after the provisioner's listing.
              deviceManager.setDeviceImages("android", [
                { name, platform: "android", isRunning: false },
              ]);
              return { success: false, message: `An AVD with the name '${name}' already exists.` };
            },
          },
          androidConfigReader: {
            readConfig: async () => undefined,
          },
          androidConfigWriter: {
            setMemoryMb: async () => {
              throw new Error("unexpected AVD config write");
            },
          },
          iosSimulator: {
            createSimulator: async () => {
              throw new Error("unexpected iOS simulator creation");
            },
          },
          lifecycleCoordinator,
          timer,
        }),
      idGenerator: new FakeIdGenerator(["cleanup-rejected-create"]),
    });
    registerDeviceTools();
    const args = { ...provisionTestArgs("android"), boot: false, readiness: "none" as const };

    const response = JSON.parse(await provisionResponseText(args));

    expect(response).toMatchObject({
      success: false,
      error: { code: "platform_command_failed" },
    });
    expect(response.cleanup).toBeUndefined();
    expect(await deviceManager.listDeviceImages("android")).toEqual([
      { name: args.device.name, platform: "android", isRunning: false },
    ]);
  });

  test("deletes an AVD whose avdmanager create timed out mid-write (#11155)", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: (manager, creationGate) =>
        new DefaultExactDeviceProvisioner({
          listDeviceImages: async (platform) => await manager.listDeviceImages(platform),
          isCreationAllowed: (createIfMissing) => creationGate.isCreationAllowed(createIfMissing),
          avdManager: {
            createAvd: async ({ name }) => {
              // avdmanager wrote the AVD, then was killed at its timeout.
              deviceManager.setDeviceImages("android", [
                { name, platform: "android", isRunning: false },
              ]);
              throw new AvdCreateInterruptedError(
                name,
                "avdmanager command timed out after 300000ms",
              );
            },
          },
          androidConfigReader: {
            readConfig: async () => undefined,
          },
          androidConfigWriter: {
            setMemoryMb: async () => {
              throw new Error("unexpected AVD config write");
            },
          },
          iosSimulator: {
            createSimulator: async () => {
              throw new Error("unexpected iOS simulator creation");
            },
          },
          lifecycleCoordinator,
          timer,
        }),
      idGenerator: new FakeIdGenerator(["cleanup-interrupted-create"]),
    });
    registerDeviceTools();
    const args = { ...provisionTestArgs("android"), boot: false, readiness: "none" as const };

    const response = JSON.parse(await provisionResponseText(args));

    expect(response).toMatchObject({
      success: false,
      cleanup: { status: "succeeded", state: "destroyed" },
    });
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);
  });

  test("cancelled exact configuration cannot overwrite a replacement AVD after rollback", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    let config = "hw.ramSize=2048\n";
    const configWriter = new FileAndroidAvdConfigWriter({
      readFile: async () => {
        const captured = config;
        readStarted.resolve();
        await releaseRead.promise;
        return captured;
      },
      writeFile: async (_path, content) => {
        config = content;
      },
      environment: { ANDROID_AVD_HOME: "/avds" },
      homeDirectory: () => "/home/test",
    });
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: (manager, creationGate) =>
        new DefaultExactDeviceProvisioner({
          listDeviceImages: async (platform) => await manager.listDeviceImages(platform),
          isCreationAllowed: (createIfMissing) => creationGate.isCreationAllowed(createIfMissing),
          avdManager: {
            createAvd: async ({ name }) => {
              deviceManager.setDeviceImages("android", [
                { name, platform: "android", isRunning: false },
              ]);
              return { success: true, message: "created", avdName: name };
            },
          },
          androidConfigReader: {
            readConfig: async () => undefined,
          },
          androidConfigWriter: configWriter,
          iosSimulator: {
            createSimulator: async () => {
              throw new Error("unexpected iOS simulator creation");
            },
          },
          lifecycleCoordinator,
          timer,
        }),
      idGenerator: new FakeIdGenerator(["cleanup-cancelled-config"]),
    });
    registerDeviceTools();
    const baseArgs = provisionTestArgs("android");
    const args = {
      ...baseArgs,
      device: {
        ...baseArgs.device,
        spec: {
          ...baseArgs.device.spec,
          configuration: { memoryMb: 4096 },
        },
      },
      boot: false,
      readiness: "none" as const,
      timeoutMs: 1_000,
    };

    const responsePromise = ToolRegistry.getTool("provisionDevice")!.handler(args);
    await readStarted.promise;
    timer.advanceTime(1_000);
    const response = JSON.parse(((await responsePromise) as any).content[0].text);

    expect(response).toMatchObject({
      success: false,
      error: { code: "timeout" },
      cleanup: {
        status: "succeeded",
        state: "destroyed",
      },
    });
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);

    deviceManager.setDeviceImages("android", [
      { name: args.device.name, platform: "android", isRunning: false },
    ]);
    config = "hw.ramSize=8192\n";
    releaseRead.resolve();
    for (let drain = 0; drain < 10; drain++) {
      await Promise.resolve();
    }

    expect(config).toBe("hw.ramSize=8192\n");
  });

  test("rollback waits for an already-started exact config write before releasing the AVD", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    let config = "hw.ramSize=2048\n";
    const configWriter = new FileAndroidAvdConfigWriter({
      readFile: async () => config,
      writeFile: async (_path, content) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        config = content;
      },
      environment: { ANDROID_AVD_HOME: "/avds" },
      homeDirectory: () => "/home/test",
    });
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: (manager, creationGate) =>
        new DefaultExactDeviceProvisioner({
          listDeviceImages: async (platform) => await manager.listDeviceImages(platform),
          isCreationAllowed: (createIfMissing) => creationGate.isCreationAllowed(createIfMissing),
          avdManager: {
            createAvd: async ({ name }) => {
              deviceManager.setDeviceImages("android", [
                { name, platform: "android", isRunning: false },
              ]);
              return { success: true, message: "created", avdName: name };
            },
          },
          androidConfigReader: {
            readConfig: async () => undefined,
          },
          androidConfigWriter: configWriter,
          iosSimulator: {
            createSimulator: async () => {
              throw new Error("unexpected iOS simulator creation");
            },
          },
          lifecycleCoordinator,
          timer,
        }),
      idGenerator: new FakeIdGenerator(["cleanup-started-config-write"]),
    });
    registerDeviceTools();
    const baseArgs = provisionTestArgs("android");
    const args = {
      ...baseArgs,
      device: {
        ...baseArgs.device,
        spec: {
          ...baseArgs.device.spec,
          configuration: { memoryMb: 4096 },
        },
      },
      boot: false,
      readiness: "none" as const,
      timeoutMs: 1_000,
    };

    const responsePromise = ToolRegistry.getTool("provisionDevice")!.handler(args);
    await writeStarted.promise;
    timer.advanceTime(1_000);
    let responseSettled = false;
    void responsePromise.finally(() => {
      responseSettled = true;
    });
    let replacementAcquired = false;
    const replacementLeasePromise = lifecycleCoordinator
      .reserve(
        { kind: "stable", platform: "android", stableId: args.device.name },
        { operation: "provision", deadlineMs: timer.now() + 10_000 },
      )
      .then((lease) => {
        replacementAcquired = true;
        return lease;
      });
    for (let drain = 0; drain < 10; drain++) {
      await Promise.resolve();
    }

    expect(responseSettled).toBe(false);
    expect(replacementAcquired).toBe(false);
    releaseWrite.resolve();
    const response = JSON.parse(((await responsePromise) as any).content[0].text);
    expect(response).toMatchObject({
      success: false,
      error: { code: "timeout" },
      cleanup: {
        status: "succeeded",
        state: "destroyed",
      },
    });
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);

    const replacementLease = await replacementLeasePromise;
    deviceManager.setDeviceImages("android", [
      { name: args.device.name, platform: "android", isRunning: false },
    ]);
    config = "hw.ramSize=8192\n";
    for (let drain = 0; drain < 10; drain++) {
      await Promise.resolve();
    }
    replacementLease.release();

    expect(config).toBe("hw.ramSize=8192\n");
  });

  test("defers cleanup while retaining the AVD lease when mutation settlement times out", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const mutationStarted = Promise.withResolvers<void>();
    const releaseMutation = Promise.withResolvers<void>();
    const created = provisionedTestDevice("android", true);
    let provisionCalls = 0;
    let imagesAtRetry: unknown;
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls++;
          if (provisionCalls > 1) {
            imagesAtRetry = await deviceManager.listDeviceImages("android");
            return created;
          }
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [created.device]);
          mutationStarted.resolve();
          await releaseMutation.promise;
          throw request.signal?.reason ?? new Error("cancelled");
        },
      }),
      idGenerator: new FakeIdGenerator(["cleanup-unsettled-mutation", "cleanup-settled-mutation"]),
    });
    registerDeviceTools();
    const args = {
      ...provisionTestArgs("android"),
      boot: false,
      readiness: "none" as const,
      timeoutMs: 1_000,
    };

    const responsePromise = ToolRegistry.getTool("provisionDevice")!.handler(args);
    await mutationStarted.promise;
    timer.advanceTime(1_000);
    for (let drain = 0; drain < 10; drain++) {
      await Promise.resolve();
    }
    timer.advanceTime(60_000);
    const response = JSON.parse(((await responsePromise) as any).content[0].text);

    expect(response).toMatchObject({
      success: false,
      error: { code: "cleanup_failed" },
      provisionFailure: { code: "timeout" },
      cleanup: {
        status: "failed",
        failure: {
          code: "mutation_settlement_timeout",
          phase: "precondition",
        },
      },
      lifecycle: {
        state: "cleanup_in_progress",
        phase: "cleanup",
        device: {
          platform: "android",
          stableId: "phone-api-36-a",
        },
        cleanup: { status: "in_progress" },
      },
    });
    expect(response.recovery.nextAction).toMatchObject({
      action: "retry",
      automaticRetrySafe: false,
    });
    expect(await deviceManager.listDeviceImages("android")).toEqual([created.device]);

    // #11065: a concurrent provision of the same exact device waits on the
    // lifecycle lease the deferred cleanup still holds, then runs afresh.
    let queuedSettled = false;
    const queued = ToolRegistry.getTool("provisionDevice")!
      .handler(args)
      .finally(() => {
        queuedSettled = true;
      });
    await flushMicrotasks();
    expect(queuedSettled).toBe(false);
    expect(provisionCalls).toBe(1);

    releaseMutation.resolve();
    const queuedResponse = JSON.parse(
      ((await queued) as { content: { text: string }[] }).content[0].text,
    );
    expect(imagesAtRetry).toEqual([]);
    expect(provisionCalls).toBe(2);
    expect(queuedResponse).toMatchObject({ created: true, lifecycleState: "created" });
  });

  // #11064: a `simctl create` still in flight at the deadline must not be
  // missed by an early rollback discovery and recorded as no_device_created.
  describe("iOS rollback with simctl create in flight", () => {
    const iosArgs = () => ({
      ...provisionTestArgs("ios"),
      boot: false,
      readiness: "none" as const,
      timeoutMs: 1_000,
    });

    function inFlightIosCreate(timer: FakeTimer) {
      const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
      const mutationStarted = Promise.withResolvers<void>();
      const finishCreate = Promise.withResolvers<boolean>();
      const created = provisionedTestDevice("ios", true);
      configureProvisionBootAndTeardown(deviceManager, "ios");
      setDeviceToolsDependencies({
        timer,
        lifecycleCoordinator,
        exactDeviceProvisionerFactory: () => ({
          provision: async (request) => {
            request.onBeforeCreate?.();
            mutationStarted.resolve();
            // The simulator only appears in inventory once the create lands.
            if (await finishCreate.promise) {
              deviceManager.setDeviceImages("ios", [created.device]);
            }
            throw request.signal?.reason ?? new Error("cancelled");
          },
        }),
      });
      registerDeviceTools();
      const selectorReservation = async () =>
        await lifecycleCoordinator.reserve(
          { kind: "selector", platform: "ios", selector: created.device.name },
          { operation: "provision", deadlineMs: timer.now() + 10_000 },
        );
      return { mutationStarted, finishCreate, created, selectorReservation };
    }

    test("waits for the create to settle, then rolls the simulator back", async () => {
      const timer = new FakeTimer();
      const { mutationStarted, finishCreate, created } = inFlightIosCreate(timer);
      const args = iosArgs();

      const responsePromise = ToolRegistry.getTool("provisionDevice")!.handler(args);
      await mutationStarted.promise;
      timer.advanceTime(1_000);
      await flushMicrotasks();
      // The create lands inside the rollback budget.
      finishCreate.resolve(true);
      const response = JSON.parse(
        ((await responsePromise) as { content: { text: string }[] }).content[0].text,
      );

      expect(response).toMatchObject({
        success: false,
        provisionFailure: { code: "timeout" },
        cleanup: { status: "succeeded" },
        lifecycle: { state: "removed", device: { platform: "ios", stableId: "SIM-123" } },
      });
      expect(response.lifecycle.state).not.toBe("no_device_created");
      expect(
        deviceManager
          .getExecutedOperations()
          .filter((operation) => operation.startsWith("destroyDevice:")),
      ).toHaveLength(1);
      expect(await deviceManager.listDeviceImages("ios")).not.toContainEqual(created.device);
    });

    test("records an unresolved create as retained and keeps the lease until it settles", async () => {
      const timer = new FakeTimer();
      const { mutationStarted, finishCreate, selectorReservation } = inFlightIosCreate(timer);
      const args = iosArgs();

      const responsePromise = ToolRegistry.getTool("provisionDevice")!.handler(args);
      await mutationStarted.promise;
      timer.advanceTime(1_000);
      await flushMicrotasks();
      // The create outlives the whole rollback budget.
      timer.advanceTime(60_000);
      const response = JSON.parse(
        ((await responsePromise) as { content: { text: string }[] }).content[0].text,
      );

      expect(response).toMatchObject({
        success: false,
        provisionFailure: { code: "timeout" },
        cleanup: { status: "failed", failure: { code: "target_identity_unresolved" } },
        lifecycle: { state: "retained", cleanup: { status: "failed" } },
        recovery: {
          outcomes: { deviceCreation: "unknown" },
          nextAction: { action: "obtain_further_evidence", automaticRetrySafe: false },
        },
      });
      expect(response.lifecycle.device).toBeUndefined();

      let replacementAcquired = false;
      const replacement = selectorReservation().then((lease) => {
        replacementAcquired = true;
        return lease;
      });
      await flushMicrotasks();
      expect(replacementAcquired).toBe(false);

      finishCreate.resolve(false);
      (await replacement).release();
      expect(replacementAcquired).toBe(true);
    });
  });

  test("keeps a committed provision when the post-commit resource notification fails", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [created.device]);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {},
      notifyResourcesChanged: async () => {
        throw new Error("resource notification transport closed");
      },
      idGenerator: new FakeIdGenerator(["session-notify-failure", "cleanup-notify-failure"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      ((await tool.handler(provisionTestArgs("android"))) as any).content[0].text,
    );

    // Session + pool ownership are already committed by the time the
    // best-effort notification runs, so its failure must neither be reported
    // as a provisioning failure nor drive destructive rollback.
    expect(response).toMatchObject({
      created: true,
      lifecycleState: "ready",
      sessionId: "session-notify-failure",
    });
    expect(response.success).toBeUndefined();
    expect(response.error).toBeUndefined();
    expect(response.cleanup).toBeUndefined();
    expect(
      deviceManager
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("destroyDevice:")),
    ).toEqual([]);
    expect(await deviceManager.listDeviceImages("android")).toEqual([created.device]);
  });

  test.each(["android", "ios"] as const)(
    "keeps a stopped %s device when its resource notification fails",
    async (platform) => {
      const created = provisionedTestDevice(platform, true);
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => ({
          provision: async (request) => {
            request.onBeforeCreate?.();
            deviceManager.setDeviceImages(platform, [created.device]);
            return created;
          },
        }),
        notifyResourcesChanged: async () => {
          throw new Error("resource notification transport closed");
        },
      });
      registerDeviceTools();

      const response = JSON.parse(
        (
          (await ToolRegistry.getTool("provisionDevice")!.handler({
            ...provisionTestArgs(platform),
            boot: false,
            readiness: "none",
          })) as any
        ).content[0].text,
      );

      expect(response).toMatchObject({
        created: true,
        adopted: false,
        lifecycleState: "created",
        readiness: { status: "not_requested" },
      });
      expect(response.error).toBeUndefined();
      expect(response.cleanup).toBeUndefined();
      expect(
        deviceManager
          .getExecutedOperations()
          .filter((operation) => operation.startsWith("destroyDevice:")),
      ).toEqual([]);
      expect(await deviceManager.listDeviceImages(platform)).toEqual([created.device]);
    },
  );

  test("returns a stopped-device result without waiting for a resource notification", async () => {
    const created = provisionedTestDevice("android", true);
    const notification = Promise.withResolvers<void>();
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [created.device]);
          return created;
        },
      }),
      notifyResourcesChanged: () => notification.promise,
    });
    registerDeviceTools();

    let responseSettled = false;
    const request = ToolRegistry.getTool("provisionDevice")!
      .handler({
        ...provisionTestArgs("android"),
        boot: false,
        readiness: "none",
      })
      .then((response) => {
        responseSettled = true;
        return response;
      });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(responseSettled).toBe(true);
      expect(JSON.parse(((await request) as any).content[0].text)).toMatchObject({
        created: true,
        lifecycleState: "created",
      });
      expect(await deviceManager.listDeviceImages("android")).toEqual([created.device]);
    } finally {
      notification.resolve();
      await request;
    }
  });

  test("cleans up an iOS simulator created before exact provisioning fails", async () => {
    const created = provisionedTestDevice("ios", true);
    configureProvisionBootAndTeardown(deviceManager, "ios");
    deviceManager.setDeviceImages("ios", []);
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          // simctl created the simulator, but its UDID never reached us.
          deviceManager.setDeviceImages("ios", [created.device]);
          throw new Error("reading the created simulator UDID failed");
        },
      }),
      idGenerator: new FakeIdGenerator(["cleanup-partial-ios"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      ((await tool.handler(provisionTestArgs("ios"))) as any).content[0].text,
    );

    // The rollback target is resolved by re-reading the simulator inventory,
    // so assert it landed on the UDID this operation created.
    expect(response).toMatchObject({
      success: false,
      cleanup: {
        status: "succeeded",
        target: { platform: "ios", stableId: "SIM-123", stableName: "iPhone 17" },
      },
    });
    expect(await deviceManager.listDeviceImages("ios")).toEqual([]);
  });

  test("does not roll back a fresh provision when MCP session recovery is in progress", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages("android", [created.device]);
          return created;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new McpSessionRecoveryInProgressError("mcp-session-recovering");
      },
      idGenerator: new FakeIdGenerator(["session-recovery", "cleanup-recovery"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = await tool.handler(provisionTestArgs("android"));

    // A transport routing conflict does not invalidate the healthy device, so
    // the recovery error must keep its identity instead of being wrapped by
    // the rollback and costing a full create + cold boot on retry.
    expect(JSON.stringify(response)).toContain("recovering a device");
    expect(JSON.stringify(response)).not.toContain("cleanup");
    expect(
      deviceManager
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("destroyDevice:")),
    ).toEqual([]);
    expect(await deviceManager.listDeviceImages("android")).toEqual([created.device]);
  });

  test("keeps a fresh Android AVD and reports a retryable daemon handoff interruption", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    let provisionCalls = 0;
    let readinessCalls = 0;
    const readinessStarted = Promise.withResolvers<void>();
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls++;
          if (provisionCalls === 1) {
            request.onBeforeCreate?.();
            deviceManager.setDeviceImages("android", [created.device]);
            return created;
          }
          return { ...created, created: false };
        },
      }),
      ensureCtrlProxyReady: async (request) => {
        readinessCalls++;
        if (readinessCalls === 1) {
          readinessStarted.resolve();
          await new Promise<never>((_resolve, reject) => {
            const rejectForAbort = () => reject(request.signal?.reason);
            if (request.signal?.aborted) {
              rejectForAbort();
              return;
            }
            request.signal?.addEventListener("abort", rejectForAbort, { once: true });
          });
        }
      },
      idGenerator: new FakeIdGenerator(["session-handoff-retry"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = provisionTestArgs("android");
    const requestController = new AbortController();
    const first = tool.handler(args, undefined, requestController.signal);
    await readinessStarted.promise;
    requestController.abort(
      new DaemonHandoffInterruptionError("daemon shutdown interrupted provisioning"),
    );

    const failed = JSON.parse(((await first) as any).content[0].text);
    expect(failed).toMatchObject({
      success: false,
      error: {
        code: "daemon_handoff_interrupted",
        retryable: true,
      },
    });
    expect(failed.cleanup).toBeUndefined();
    expect(failed.recovery).toMatchObject({
      schemaVersion: 2,
      boundary: "daemon_handoff",
      originalError: { code: "daemon_handoff_interrupted" },
      device: { ownership: "created_by_request" },
      outcomes: { deviceCreation: "created" },
      freshness: { source: "snapshot" },
    });
    expect(failed.recovery.nextAction.automaticRetrySafe).toBe(true);
    expect(
      deviceManager
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("destroyDevice:")),
    ).toEqual([]);
    expect(await deviceManager.listDeviceImages("android")).toEqual([created.device]);

    // #11065: the retry is a fresh provision that adopts the AVD the
    // interrupted request created, instead of creating another.
    const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    expect(retried).toMatchObject({
      created: false,
      adopted: true,
      lifecycleState: "ready",
      sessionId: "session-handoff-retry",
    });
    expect(provisionCalls).toBe(2);
  });

  test("retains the AVD lease through a pending config write during daemon handoff", async () => {
    const timer = new FakeTimer();
    const lifecycleCoordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const writeStarted = Promise.withResolvers<void>();
    const releaseWrite = Promise.withResolvers<void>();
    let config = "hw.ramSize=2048\n";
    const configWriter = new FileAndroidAvdConfigWriter({
      readFile: async () => config,
      writeFile: async (_path, content) => {
        writeStarted.resolve();
        await releaseWrite.promise;
        config = content;
      },
      environment: { ANDROID_AVD_HOME: "/avds" },
      homeDirectory: () => "/home/test",
    });
    configureProvisionBootAndTeardown(deviceManager, "android");
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: (manager, creationGate) =>
        new DefaultExactDeviceProvisioner({
          listDeviceImages: async (platform) => await manager.listDeviceImages(platform),
          isCreationAllowed: (createIfMissing) => creationGate.isCreationAllowed(createIfMissing),
          avdManager: {
            createAvd: async ({ name }) => {
              deviceManager.setDeviceImages("android", [
                { name, platform: "android", isRunning: false },
              ]);
              return { success: true, message: "created", avdName: name };
            },
          },
          androidConfigReader: {
            readConfig: async () => undefined,
          },
          androidConfigWriter: configWriter,
          iosSimulator: {
            createSimulator: async () => {
              throw new Error("unexpected iOS simulator creation");
            },
          },
          lifecycleCoordinator,
          timer,
        }),
      idGenerator: new FakeIdGenerator([]),
    });
    registerDeviceTools();
    const baseArgs = provisionTestArgs("android");
    const args = {
      ...baseArgs,
      device: {
        ...baseArgs.device,
        spec: {
          ...baseArgs.device.spec,
          configuration: { memoryMb: 4096 },
        },
      },
      boot: false,
      readiness: "none" as const,
    };
    const requestController = new AbortController();

    const responsePromise = ToolRegistry.getTool("provisionDevice")!.handler(
      args,
      undefined,
      requestController.signal,
    );
    await writeStarted.promise;
    requestController.abort(
      new DaemonHandoffInterruptionError("daemon shutdown interrupted provisioning"),
    );
    const response = JSON.parse(((await responsePromise) as any).content[0].text);
    expect(response).toMatchObject({
      success: false,
      error: {
        code: "daemon_handoff_interrupted",
        retryable: true,
      },
    });
    expect(response.cleanup).toBeUndefined();

    let replacementAcquired = false;
    const replacementLeasePromise = lifecycleCoordinator
      .reserve(
        { kind: "stable", platform: "android", stableId: args.device.name },
        { operation: "provision", deadlineMs: timer.now() + 10_000 },
      )
      .then((lease) => {
        replacementAcquired = true;
        return lease;
      });
    for (let drain = 0; drain < 10; drain++) {
      await Promise.resolve();
    }
    expect(replacementAcquired).toBe(false);

    releaseWrite.resolve();
    const replacementLease = await replacementLeasePromise;
    config = "hw.ramSize=8192\n";
    replacementLease.release();

    expect(config).toBe("hw.ramSize=8192\n");
    expect(await deviceManager.listDeviceImages("android")).toHaveLength(1);
    expect(
      deviceManager
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("destroyDevice:")),
    ).toEqual([]);
  });

  // #11065: a retry after a failed cleanup re-runs the lifecycle; it adopts the
  // retained device, so its own readiness failure never deletes it.
  test("a retry after a failed cleanup adopts the retained device and never deletes it", async () => {
    const adopted = provisionedTestDevice("android", false);
    configureProvisionBootAndTeardown(deviceManager, "android");
    const originalDestroyDevice = deviceManager.destroyDevice.bind(deviceManager);
    let failFirstCleanup = true;
    deviceManager.destroyDevice = async (device) => {
      if (failFirstCleanup) {
        failFirstCleanup = false;
        throw new Error("first cleanup failed");
      }
      await originalDestroyDevice(device);
    };
    let provisionCalls = 0;
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls++;
          if (provisionCalls === 1) {
            request.onBeforeCreate?.();
            deviceManager.setDeviceImages("android", [adopted.device]);
            throw new Error("writing AVD memory configuration failed");
          }
          return adopted;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("retry readiness failed");
      },
      idGenerator: new FakeIdGenerator([
        "cleanup-partial-first-android",
        "cleanup-partial-retry-android",
      ]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = provisionTestArgs("android");

    const initial = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(initial).toMatchObject({
      success: false,
      cleanup: { status: "failed" },
      recovery: {
        boundary: "cleanup_failure",
        originalError: { message: expect.stringContaining("writing AVD memory configuration") },
        outcomes: { deviceCreation: "created" },
        cleanup: { status: "failed_device_retained" },
        nextAction: { action: "perform_cleanup", automaticRetrySafe: false },
      },
    });
    expect(retried).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("retry readiness failed") },
    });
    expect(retried.cleanup).toBeUndefined();
    expect(provisionCalls).toBe(2);
    expect(await deviceManager.listDeviceImages("android")).toEqual([adopted.device]);
  });

  test("does not retain creation ownership after verified rollback", async () => {
    const created = provisionedTestDevice("android", true);
    const replacement = provisionedTestDevice("android", false);
    configureProvisionBootAndTeardown(deviceManager, "android");
    let provisionCalls = 0;
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls++;
          if (provisionCalls === 1) {
            request.onBeforeCreate?.();
            deviceManager.setDeviceImages("android", [created.device]);
            throw new Error("writing AVD memory configuration failed");
          }
          return replacement;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("replacement readiness failed");
      },
      idGenerator: new FakeIdGenerator(["cleanup-original-android"]),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = provisionTestArgs("android");

    const initial = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    deviceManager.setDeviceImages("android", [replacement.device]);
    const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(initial).toMatchObject({
      success: false,
      cleanup: { status: "succeeded" },
    });
    expect(retried).toMatchObject({ success: false });
    expect(retried.cleanup).toBeUndefined();
    expect(await deviceManager.listDeviceImages("android")).toEqual([replacement.device]);
    expect(
      deviceManager
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("destroyDevice:")),
    ).toHaveLength(1);
  });

  test("adopts a running Android AVD by resolving its transport ID before boot", async () => {
    const existing = {
      name: "phone-api-36-a",
      platform: "android" as const,
      isRunning: true,
    };
    deviceManager.setDeviceImages("android", [existing]);
    deviceManager.setBootedDevices("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        deviceId: "emulator-5554",
      },
    ]);
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async () => ({
          created: false,
          device: existing,
          resolvedSpec: {
            runtime: "system-images;android-36;google_apis;x86_64",
            deviceType: "pixel_9",
            displayCutout: "hole_punch",
          },
        }),
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const result = JSON.parse(
      (
        (await tool.handler({
          device: {
            platform: "android",
            name: "phone-api-36-a",
            spec: {
              runtime: "system-images;android-36;google_apis;x86_64",
              deviceType: "pixel_9",
            },
          },
          boot: true,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
    expect(result).toMatchObject({
      created: false,
      adopted: true,
      lifecycleState: "ready",
      readiness: { mode: "none", status: "device_ready" },
      sessionId: expect.any(String),
      device: {
        runtime: expect.objectContaining({ deviceId: "emulator-5554" }),
        name: "phone-api-36-a",
      },
    });
  });

  test("boots the provisioned iOS UDID instead of another running simulator with the same name", async () => {
    deviceManager.setDeviceImages("ios", [
      {
        name: "phone-api-36-a",
        platform: "ios",
        deviceId: "requested-udid",
        isRunning: false,
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
    ]);
    deviceManager.setBootedDevices("ios", [
      {
        name: "phone-api-36-a",
        platform: "ios",
        deviceId: "other-udid",
      },
    ]);
    let receivedProvisionRequest: Parameters<ExactDeviceProvisioner["provision"]>[0] | undefined;
    const exactIosProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => {
        receivedProvisionRequest = request;
        return {
          created: false,
          device: {
            name: "phone-api-36-a",
            platform: "ios",
            deviceId: "requested-udid",
            isRunning: false,
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
          },
          resolvedSpec: {
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
          },
        };
      },
    };
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => exactIosProvisioner,
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      (
        (await tool.handler({
          device: {
            platform: "ios",
            name: "phone-api-36-a",
            deviceId: "requested-udid",
            spec: {
              runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
              deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
            },
          },
          boot: true,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      created: false,
      adopted: true,
      lifecycleState: "ready",
      readiness: { mode: "none", status: "device_ready" },
      sessionId: expect.any(String),
      device: {
        runtime: expect.objectContaining({ deviceId: "requested-udid" }),
      },
    });
    expect(deviceManager.getExecutedOperations()).toContainEqual(
      expect.stringContaining("startDevice:phone-api-36-a"),
    );
    expect(receivedProvisionRequest?.deviceId).toBe("requested-udid");
    expect(deviceManager.getGetDeviceImagesDetailedCalls()).toContainEqual({
      platform: "ios",
      options: {
        bypassIosDeviceListCache: true,
        signal: expect.any(AbortSignal),
      },
    });
  });

  test("reports a contended iOS selector reservation as a timeout", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const blocker = await coordinator.reserve(
      { kind: "selector", platform: "ios", selector: "iPhone 17" },
      { operation: "provision", deadlineMs: 10_000_000 },
    );
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: coordinator,
      exactDeviceProvisionerFactory: () => ({
        provision: async () => {
          throw new Error("provisioning must not start without a reservation");
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const pending = tool.handler({
      ...provisionTestArgs("ios"),
      boot: false,
      readiness: "none",
      timeoutMs: 60_000,
    });
    for (let index = 0; index < 30; index++) {
      await Promise.resolve();
    }
    timer.advanceTime(60_001);
    const response = JSON.parse(((await pending) as any).content[0].text);
    blocker.release();

    expect(response).toMatchObject({
      success: false,
      error: { code: "timeout" },
    });
  });

  test("fails closed when iOS lifecycle-reservation discovery is incomplete", async () => {
    deviceManager.failedPlatforms.add("ios");
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = JSON.parse(
      (
        (await tool.handler({
          device: {
            platform: "ios",
            name: "iPhone 17",
            spec: {
              runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
              deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
            },
          },
          boot: false,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: { code: "platform_command_failed" },
    });
    expect(exactProvisioner.requests).toHaveLength(0);
  });

  test("reports incomplete Android boot discovery as retryable without adopting a device", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    await pool.initializeWithDevices([]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    deviceManager.setAndroidDiscoveryIncomplete("adb devices failed during boot discovery");

    const response = JSON.parse(
      (
        (await ToolRegistry.getTool("provisionDevice")!.handler(
          provisionTestArgs("android"),
        )) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "discovery_incomplete",
        retryable: true,
      },
    });
    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
    expect(deviceManager.wasMethodCalled("waitForDeviceReady")).toBe(false);
    expect(pool.getDevice("emulator-5554")).toBeNull();
    expect(sessionManager.getAllSessionIds()).toEqual([]);
  });

  test("keeps incomplete Android boot discovery retryable after rolling back a created device", async () => {
    const created = provisionedTestDevice("android", true);
    const failDiscoveryAfterCreate = configurePostCreateAndroidDiscoveryFailure(deviceManager);
    exactProvisioner.provision = async (request) => {
      request.onBeforeCreate?.();
      deviceManager.setDeviceImages("android", [created.device]);
      failDiscoveryAfterCreate();
      return created;
    };

    const response = JSON.parse(
      (
        (await ToolRegistry.getTool("provisionDevice")!.handler(
          provisionTestArgs("android"),
        )) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "discovery_incomplete",
        retryable: true,
      },
      cleanup: { status: "succeeded" },
    });
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);
  });

  test("makes incomplete Android boot discovery non-retryable when rollback fails", async () => {
    const created = provisionedTestDevice("android", true);
    const failDiscoveryAfterCreate = configurePostCreateAndroidDiscoveryFailure(deviceManager);
    exactProvisioner.provision = async (request) => {
      request.onBeforeCreate?.();
      deviceManager.setDeviceImages("android", [created.device]);
      failDiscoveryAfterCreate();
      return created;
    };
    deviceManager.destroyDevice = async () => {
      throw new Error("platform delete failed");
    };
    const response = JSON.parse(
      (
        (await ToolRegistry.getTool("provisionDevice")!.handler(
          provisionTestArgs("android"),
        )) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "cleanup_failed",
        retryable: false,
      },
      cleanup: { status: "failed" },
    });
  });

  test("locks a newly created iOS simulator before booting it", async () => {
    const created: ExactProvisionedDevice = {
      created: true,
      device: {
        platform: "ios",
        name: "iPhone 17",
        deviceId: "created-udid",
        isRunning: false,
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
      },
      resolvedSpec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17",
        displayCutout: "dynamic_island",
      },
    };
    let releaseReadiness!: () => void;
    const readinessStarted = new Promise<void>((resolve) => {
      setDeviceToolsDependencies({
        ensureCtrlProxyReady: async () => {
          resolve();
          await new Promise<void>((release) => {
            releaseReadiness = release;
          });
        },
      });
    });
    // Let the preempted provision's rollback teardown (and the racing teardown)
    // run to completion against fakes: the shutdown must observe the simulator
    // leave the booted list, and the iOS CtrlProxy stop must not reach a real runner.
    const originalKillDevice = deviceManager.killDevice.bind(deviceManager);
    deviceManager.killDevice = async (device) => {
      await originalKillDevice(device);
      deviceManager.setBootedDevices("ios", []);
    };
    const iosCtrlProxyManager = spyOn(IOSCtrlProxyManager, "getInstance").mockReturnValue({
      stop: async () => {},
    } as never);
    try {
      const exactIosProvisioner: ExactDeviceProvisioner = {
        provision: async (request) => {
          deviceManager.setDeviceImages("ios", [created.device]);
          await request.lifecycleLease?.bindCanonicalIdentity({
            platform: "ios",
            stableId: created.device.deviceId!,
          });
          return created;
        },
      };
      setDeviceToolsDependencies({
        exactDeviceProvisionerFactory: () => exactIosProvisioner,
      });
      registerDeviceTools();
      const provisionTool = ToolRegistry.getTool("provisionDevice");
      const teardownTool = ToolRegistry.getTool("deleteDevice");
      if (!provisionTool || !teardownTool) {
        throw new Error("expected provisionDevice and deleteDevice tools");
      }

      const provision = provisionTool.handler({
        device: {
          platform: "ios",
          name: created.device.name,
          spec: created.resolvedSpec,
        },
        boot: true,
        readiness: "automation",
      });
      await readinessStarted;
      deviceManager.clearHistory();

      const teardown = teardownTool.handler({
        target: {
          platform: "ios",
          isVirtual: true,
          stableId: created.device.deviceId!,
          stableName: created.device.name,
        },
        mode: "destroy",
        verifyAbsence: true,
        timeoutMs: 60_000,
      });
      let teardownSettled = false;
      void teardown.then(
        () => {
          teardownSettled = true;
        },
        () => {
          teardownSettled = true;
        },
      );
      for (let attempt = 0; attempt < 50; attempt++) {
        await Promise.resolve();
      }
      expect(teardownSettled).toBe(false);
      expect(deviceManager.getExecutedOperations()).toEqual([]);

      releaseReadiness();
      const provisionResult = await provision;
      const teardownResult = await teardown;
      expect(deviceManager.getExecutedOperations()).toContainEqual(
        expect.stringContaining("getBootedDevices:ios"),
      );
      // Teardown preempts the in-flight provision, whose rollback removes the
      // simulator it created; the racing teardown then finds it already gone.
      expect(provisionResult.isError).toBe(true);
      expect(deviceManager.getExecutedOperations()).toContain("destroyDevice:ios:created-udid");
      expect(teardownResult.structuredContent).toMatchObject({ state: "already_absent" });
    } finally {
      iosCtrlProxyManager.mockRestore();
    }
  });

  // #6227 (round 6 P1): `readiness: "none"` deliberately skips CtrlProxy /
  // accessibility-service setup in `ensureProvisionDeviceReadiness`, so the
  // freshly-bound session must NOT be recorded as `automationReady` — that
  // would make a later `automationReady` tool (e.g. `observe`) wrongly treat
  // setup as already satisfied and run against a device whose CtrlProxy setup
  // was intentionally skipped.
  test("records booted (not automationReady) when readiness: 'none' skips CtrlProxy setup (#6227 round 6)", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    const bootedDevice = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "mock-phone-api-36-a",
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    await pool.initializeWithDevices([bootedDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    let readinessCalls = 0;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
      },
    });

    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const response = JSON.parse(
      (
        (await tool.handler({
          device: {
            platform: "android",
            name: "phone-api-36-a",
            spec: {
              runtime: "system-images;android-36;google_apis;x86_64",
              deviceType: "pixel_9",
            },
          },
          boot: true,
          readiness: "none",
        })) as any
      ).content[0].text,
    );

    expect(readinessCalls).toBe(0);
    expect(response.sessionId).toEqual(expect.any(String));
    expect(sessionManager.getDeviceReadiness(response.sessionId)).toBe("booted");
    sessionManager.stopCleanupTimer();
  });

  // #6227 (round 6 P1, continued): because the session bound after
  // `readiness: "none"` is recorded as merely `booted`, a subsequent
  // `automationReady`-declaring tool call against that same session must
  // still run CtrlProxy / accessibility-service setup rather than skipping it
  // as already-satisfied.
  test("a later automationReady tool runs setup for a session acquired via readiness: 'none' (#6227 round 6)", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    const bootedDevice = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "mock-phone-api-36-a",
    };
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    await pool.initializeWithDevices([bootedDevice]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {},
    });

    const ctrlProxySetup = stubCtrlProxySetup();

    try {
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }
      const response = JSON.parse(
        (
          (await tool.handler({
            device: {
              platform: "android",
              name: "phone-api-36-a",
              spec: {
                runtime: "system-images;android-36;google_apis;x86_64",
                deviceType: "pixel_9",
              },
            },
            boot: true,
            readiness: "none",
          })) as any
        ).content[0].text,
      );
      const sessionId = response.sessionId as string;
      expect(sessionId).toEqual(expect.any(String));
      expect(sessionManager.getDeviceReadiness(sessionId)).toBe("booted");

      ToolRegistry.registerDeviceAware(
        "automationReadyAfterProvisionProbe",
        "Automation-ready probe after provisionDevice readiness: none",
        z.object({ sessionUuid: z.string().optional() }),
        async () => ({ success: true }),
        { deviceReadiness: "automationReady" },
      );

      const automationResponse = await ToolRegistry.getTool(
        "automationReadyAfterProvisionProbe",
      )!.handler({
        platform: "android",
        sessionUuid: sessionId,
        // This probe verifies readiness setup, not host ADB keep-awake behavior.
        keepScreenAwake: false,
      });

      expect(automationResponse).toMatchObject({ success: true });
      expect(ctrlProxySetup.setupCallCount()).toBe(1);
      expect(sessionManager.getDeviceReadiness(sessionId)).toBe("automationReady");
    } finally {
      ctrlProxySetup.restore();
      sessionManager.stopCleanupTimer();
    }
  });

  test("reports MCP session recovery as a transient failure the caller can retry", async () => {
    // McpSessionRecoveryInProgressError is explicitly transient ("cannot remap
    // until recovery finishes"), so the caller is expected to retry.
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async () => {
          throw new McpSessionRecoveryInProgressError("mcp-session-recovering");
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = await tool.handler({
      ...provisionTestArgs("android"),
      boot: false,
      readiness: "none",
    });

    expect(JSON.stringify(response)).toContain("recovering a device");
  });

  test("a retry after a successful rollback provisions afresh", async () => {
    let calls = 0;
    const retryingProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => {
        calls++;
        if (calls === 1) {
          request.onBeforeCreate?.();
        } else {
          deviceManager.setBootedDevices("android", [
            { name: request.name, platform: "android", deviceId: "emulator-5554" },
          ]);
        }
        return {
          created: calls === 1,
          device: {
            name: request.name,
            platform: "android",
            isRunning: false,
          },
          resolvedSpec: {
            ...request.spec,
            displayCutout: classifyDisplayCutout(request.platform, request.spec.deviceType),
          },
        };
      },
    };
    let readinessCalls = 0;
    deviceManager.setDeviceImages("android", [
      {
        name: "phone-api-36-a",
        platform: "android",
        isRunning: false,
      },
    ]);
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => retryingProvisioner,
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        if (readinessCalls === 1) {
          throw new Error("first readiness attempt failed");
        }
      },
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      device: {
        platform: "android" as const,
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "automation" as const,
    };

    const failed = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);

    expect(failed).toMatchObject({
      success: false,
      lifecycle: { state: "removed", cleanup: { status: "succeeded" } },
    });
    expect(retried).toMatchObject({ lifecycleState: "ready" });
    expect(calls).toBe(2);
  });

  test("cancels the lifecycle and reports request_cancelled when its caller aborts", async () => {
    let provisionSignal: AbortSignal | undefined;
    let observedAbort = false;
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionSignal = request.signal;
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) {
              resolve();
              return;
            }
            request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          observedAbort = true;
          throw request.signal?.reason ?? new Error("aborted");
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      ...provisionTestArgs("android"),
      boot: false,
      readiness: "none" as const,
      // The daemon forwards its per-call key; the outcome is published under it (#11065).
      __mcpLiveDeadlineKey: "forwarded-call-key",
    };

    const caller = new AbortController();
    const published: unknown[] = [];
    const awaited = provisionCancellationOutcomes
      .await("forwarded-call-key", 60_000, new FakeTimer())
      .then((outcome) => published.push(outcome));
    const call = tool.handler(args, undefined, caller.signal);
    await Promise.resolve();
    caller.abort(new Error("client went away"));
    const response = await call;
    await awaited;
    // The socket layer's abandoned-request reply receives the same typed result (#11074).
    expect(published).toEqual([response]);
    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.resolve();
    }

    // Nothing is waiting for the result any more, so the provisioning work
    // must be cancelled rather than left to boot a device and bind a session
    // no client owns.
    expect(provisionSignal?.aborted).toBe(true);
    expect(observedAbort).toBe(true);
    expect(JSON.parse((response as any).content[0].text)).toMatchObject({
      success: false,
      error: { code: "request_cancelled" },
      recovery: {
        boundary: "caller_cancellation",
        outcomes: { settlement: "settled", deviceCreation: "not_created" },
        nextAction: { action: "retry", automaticRetrySafe: true },
      },
    });
  });

  // #11064: the cancellation response must not tell the caller to reacquire
  // the device the rollback just destroyed.
  test("a cancelled provision whose rollback removed the device reports it removed", async () => {
    const platform = "android" as const;
    const provisioned = provisionedTestDevice(platform, true);
    configureProvisionBootAndTeardown(deviceManager, platform);
    const readinessEntered = deferred();
    const releaseReadiness = deferred();
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages(platform, [provisioned.device]);
          return provisioned;
        },
      }),
      ensureCtrlProxyReady: async () => {
        readinessEntered.resolve();
        await releaseReadiness.promise;
        throw new Error("readiness aborted by cancellation");
      },
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = provisionTestArgs(platform);

    const caller = new AbortController();
    const call = tool.handler(args, undefined, caller.signal);
    await readinessEntered.promise;
    caller.abort(new Error("client went away"));
    releaseReadiness.resolve();
    const response = JSON.parse(((await call) as { content: { text: string }[] }).content[0].text);

    expect(response).toMatchObject({
      error: { code: "request_cancelled" },
      recovery: {
        boundary: "caller_cancellation",
        phaseReached: "cleanup",
        outcomes: { settlement: "settled" },
        cleanup: { status: "reported_complete_unverified" },
        nextAction: { action: "retry", automaticRetrySafe: true },
      },
    });
    expect(response.recovery.nextAction.action).not.toBe("reacquire_retained_device");
  });

  test("releases the stable lifecycle lease when the cold-boot settlement rejects", async () => {
    const platform = "android" as const;
    const timer = new FakeTimer();
    const inner = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    const reserved: string[] = [];
    const released: string[] = [];
    const lifecycleCoordinator: VirtualDeviceLifecycleCoordinator = {
      reserve: async (identity, options) => {
        const lease = await inner.reserve(identity, options);
        const key = JSON.stringify(lease.identity);
        reserved.push(key);
        return {
          get signal() {
            return lease.signal;
          },
          get identity() {
            return lease.identity;
          },
          bindCanonicalIdentity: async (canonical) => await lease.bindCanonicalIdentity(canonical),
          transitionToTeardown: () => lease.transitionToTeardown(),
          release: () => {
            released.push(JSON.stringify(lease.identity));
            lease.release();
          },
        };
      },
    };
    const provisioned = provisionedTestDevice(platform, true);
    configureProvisionBootAndTeardown(deviceManager, platform);
    // Registering the exit listener throws, so the unowned cold-boot
    // settlement promise REJECTS. A lease release deferred onto it with a bare
    // `.then()` would never run.
    deviceManager.setMockChildProcess(provisioned.device.name, {
      exitCode: null,
      signalCode: null,
      once: () => {
        throw new Error("exit listener registration failed");
      },
      kill: () => true,
    } as any);
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator,
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          request.onBeforeCreate?.();
          deviceManager.setDeviceImages(platform, [provisioned.device]);
          return provisioned;
        },
      }),
      ensureCtrlProxyReady: async () => {
        throw new Error("runner readiness failed");
      },
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    await tool.handler(provisionTestArgs(platform));
    for (let drain = 0; drain < 25; drain++) {
      await Promise.resolve();
    }

    expect(reserved.length).toBeGreaterThan(0);
    expect(released).toEqual(reserved);
  });

  test("does not hand a retry the cancelled attempt's failure before it settles", async () => {
    const timer = new FakeTimer();
    let provisionCalls = 0;
    const provisionEntered = deferred();
    let releaseFirstAttempt!: () => void;
    const firstAttemptGate = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    setDeviceToolsDependencies({
      timer,
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls += 1;
          provisionEntered.resolve();
          if (provisionCalls > 1) {
            return provisionedTestDevice("android", true);
          }
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          // The cancelled lifecycle is still unwinding when the retry arrives.
          await firstAttemptGate;
          throw request.signal?.reason ?? new Error("aborted");
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = {
      ...provisionTestArgs("android"),
      boot: false,
      readiness: "none" as const,
    };

    const caller = new AbortController();
    const call = tool.handler(args, undefined, caller.signal);
    await provisionEntered.promise;
    caller.abort(new Error("client went away"));
    await flushMicrotasks();
    expect(provisionCalls).toBe(1);

    timer.advanceTime(5_000);
    const cancelled = JSON.parse(((await call) as any).content[0].text);
    expect(cancelled).toMatchObject({
      error: { code: "request_cancelled" },
      recovery: {
        boundary: "caller_cancellation",
        outcomes: { settlement: "settled", deviceCreation: "not_created" },
        nextAction: { action: "retry", automaticRetrySafe: true },
      },
    });

    // Once cancellation is reported, a retry runs its own provision instead
    // of inheriting the cancelled attempt's failure.
    releaseFirstAttempt();
    for (let drain = 0; drain < 25; drain++) {
      await Promise.resolve();
    }
    const retried = JSON.parse(((await tool.handler(args)) as any).content[0].text);
    expect(retried.error?.code).not.toBe("request_cancelled");
    expect(retried.error).toBeUndefined();
    expect(retried).toMatchObject({ created: true });
    expect(provisionCalls).toBe(2);
  });

  // #11111: the daemon frees its admission barrier on cancel while rollback keeps running, so the
  // lifecycle lease alone must fence a following provision of the same device.
  test("a provision right after a cancel waits for the cancelled attempt's rollback", async () => {
    const timer = new FakeTimer();
    let provisionCalls = 0;
    const provisionEntered = deferred();
    const firstAttemptGate = Promise.withResolvers<void>();
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionCalls += 1;
          request.onBeforeCreate?.();
          provisionEntered.resolve();
          if (provisionCalls > 1) {
            return provisionedTestDevice("android", true);
          }
          await new Promise<void>((resolve) => {
            request.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          await firstAttemptGate.promise;
          throw request.signal?.reason ?? new Error("aborted");
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }
    const args = { ...provisionTestArgs("android"), boot: false, readiness: "none" as const };

    const caller = new AbortController();
    const first = tool.handler(args, undefined, caller.signal);
    await provisionEntered.promise;
    caller.abort(new Error("client went away"));
    await flushMicrotasks();
    timer.advanceTime(5_000);
    const cancelled = JSON.parse(
      ((await first) as { content: { text: string }[] }).content[0].text,
    );
    expect(cancelled).toMatchObject({ error: { code: "request_cancelled" } });

    const second = tool.handler(args);
    await flushMicrotasks();
    expect(provisionCalls).toBe(1);

    firstAttemptGate.resolve();
    const retried = JSON.parse(((await second) as { content: { text: string }[] }).content[0].text);
    expect(retried.error).toBeUndefined();
    expect(provisionCalls).toBe(2);
  });

  test.each(["android", "ios"] as const)(
    "preserves %s boot timeout classification",
    async (platform) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const provisioned = provisionedTestDevice(platform, false);
      exactProvisioner.provision = async () => provisioned;
      deviceManager.setDeviceImages(platform, [provisioned.device]);
      deviceManager.waitForDeviceReady = async (_device, _timeout, _handle, signal) => {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      };
      setDeviceToolsDependencies({ timer });
      const response = await ToolRegistry.getTool("provisionDevice")!.handler({
        ...provisionTestArgs(platform),
        timeoutMs: 180_000,
      });
      const payload = JSON.parse((response as any).content[0].text);
      expect(payload.error.code).toBe("timeout");
      expect(payload.error.message).toContain("provisionDevice timeout exhausted");
      expect(payload.error.message).toContain("waiting for device boot readiness");
    },
  );

  test.each([false, true])(
    "a delayed reservation release preserves acquisition outcome (failure=%s)",
    async (failReadiness) => {
      const timer = new FakeTimer();
      const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
      sessionManager.stopCleanupTimer();
      const pool = new DevicePool(
        isolatedPoolDependencies(sessionManager, "daemon-session", {
          env: autolockEnv,
          timer: timer,
          deviceManager: deviceManager,
        }),
      );
      const booted = {
        name: "phone-api-36-a",
        platform: "android" as const,
        deviceId: "emulator-5554",
      };
      deviceManager.setBootedDevices("android", [booted]);
      await pool.initializeWithDevices([booted]);
      DaemonState.getInstance().initialize(sessionManager, pool);
      exactProvisioner.provision = async () => provisionedTestDevice("android", false);
      let releaseRequested = false;
      const released = Promise.withResolvers<void>();
      pool.reserveDeviceForReadiness = async () =>
        Object.assign(
          async () => {
            releaseRequested = true;
            await released.promise;
          },
          { owner: Symbol("test-reservation") },
        );
      setDeviceToolsDependencies({
        timer,
        ensureCtrlProxyReady: async () => {
          if (failReadiness) {
            throw new Error("original readiness failure");
          }
        },
      });
      try {
        const response = await ToolRegistry.getTool("provisionDevice")!.handler({
          ...provisionTestArgs("android"),
          timeoutMs: 1_000,
        });
        const payload = JSON.parse((response as any).content[0].text);
        expect(releaseRequested).toBe(true);
        if (failReadiness) {
          expect(payload.error.message).toContain("original readiness failure");
          expect(sessionManager.getAllSessionIds()).toEqual([]);
        } else {
          expect(payload.sessionId).toBeDefined();
          expect(sessionManager.getSession(payload.sessionId)?.assignedDevice).toBe(
            booted.deviceId,
          );
        }
        expect(deviceManager.wasMethodCalled("killDevice")).toBe(false);
      } finally {
        released.resolve();
      }
    },
  );

  test("bounds a pending final session binding by the provision deadline", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    const booted = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    deviceManager.setBootedDevices("android", [booted]);
    await pool.initializeWithDevices([booted]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    pool.bindOrReuseDeviceSession = async () => await new Promise<string>(() => {});
    setDeviceToolsDependencies({ timer, ensureCtrlProxyReady: async () => {} });
    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      timeoutMs: 1_000,
    });
    const payload = JSON.parse((response as any).content[0].text);
    expect(payload.error.code).toBe("timeout");
    expect(payload.error.message).toContain("binding the device session");
    expect(sessionManager.getAllSessionIds()).toEqual([]);
  });

  test("enforces timeoutMs across exact provisioning before boot begins", async () => {
    const timer = new FakeTimer();
    let provisionSignal: AbortSignal | undefined;
    let provisionCalls = 0;
    const pendingProvisioner: ExactDeviceProvisioner = {
      provision: async (request) => {
        provisionCalls++;
        return await new Promise<ExactProvisionedDevice>((_resolve, reject) => {
          provisionSignal = request.signal;
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          });
        });
      },
    };
    setDeviceToolsDependencies({
      timer,
      exactDeviceProvisionerFactory: () => pendingProvisioner,
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const args = {
      device: {
        platform: "android",
        name: "phone-api-36-a",
        spec: {
          runtime: "system-images;android-36;google_apis;x86_64",
          deviceType: "pixel_9",
        },
      },
      boot: true,
      readiness: "automation",
      timeoutMs: 1_000,
    } as const;
    const response = tool.handler(args);

    for (let attempt = 0; provisionSignal === undefined && attempt < 10; attempt++) {
      await Promise.resolve();
    }
    expect(provisionSignal).toBeInstanceOf(AbortSignal);
    timer.advanceTime(1_000);

    expect(JSON.parse(((await response) as any).content[0].text)).toMatchObject({
      success: false,
      error: {
        code: "timeout",
      },
      lifecycle: {
        state: "no_device_created",
        phase: "provisioning",
        reason: { code: "timeout" },
      },
    });
    expect(provisionSignal?.aborted).toBe(true);
    expect(deviceManager.wasMethodCalled("startDevice")).toBe(false);
    expect(provisionCalls).toBe(1);
  });

  test.each([
    ["__mcpSessionId", "mcp-session-1"],
    ["__executionId", "execution-1"],
    ["__executionStartTime", 1_000],
    ["__mcpRequestTimeoutMs", 120_000],
    // Absolute deadline on the shared timer clock, so it must be far-future.
    ["__mcpRequestDeadlineMs", 8_640_000_000_000],
    ["__mcpLiveDeadlineKey", "live-deadline-1"],
  ] as const)(
    "strips the internal %s param before re-parsing against the strict schema",
    async (param, value) => {
      const tool = ToolRegistry.getTool("provisionDevice");
      if (!tool) {
        throw new Error("provisionDevice not registered");
      }

      const response = await tool.handler({
        ...provisionTestArgs("android"),
        boot: false,
        readiness: "none",
        [param]: value,
      } as any);

      expect((response as any).isError).toBeUndefined();
      expect(JSON.parse((response as any).content[0].text)).toMatchObject({
        lifecycleState: "created",
      });
    },
  );

  test("returns a structured invalid_arguments error instead of throwing a raw ZodError", async () => {
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    const response = await tool.handler({
      ...provisionTestArgs("android"),
      boot: false,
      readiness: "none",
      totallyUnknownKey: "nope",
    } as any);

    expect((response as any).isError).toBe(true);
    const payload = JSON.parse((response as any).content[0].text);
    expect(payload.error.code).toBe("invalid_arguments");
    expect(payload.error.message).toContain("provisionDevice");
  });

  // `cancelUnownedColdBoot` returns a settlement that resolves on the
  // emulator child's `exit` event. provisionDevice discarded it, so the AVD's
  // stable lifecycle lease was released while the emulator was still shutting
  // down and a concurrent start/teardown of the same AVD could relaunch or
  // delete it against a live `hardware-qemu.ini.lock`.
  test("holds the AVD lifecycle lease until a cancelled cold boot has exited", async () => {
    const timer = new FakeTimer();
    const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
    deviceManager.setDeviceImages("android", [
      { name: "phone-api-36-a", platform: "android", isRunning: false },
    ]);
    const exitListeners: (() => void)[] = [];
    const handle: any = {
      exitCode: null,
      signalCode: null,
      once: (event: string, listener: () => void) => {
        if (event === "exit") {
          exitListeners.push(listener);
        }
        return handle;
      },
      // A real emulator does not disappear synchronously on kill().
      kill: () => true,
    };
    deviceManager.setMockChildProcess("phone-api-36-a", handle);
    const originalWaitForDeviceReady = deviceManager.waitForDeviceReady.bind(deviceManager);
    deviceManager.waitForDeviceReady = async (device, timeoutMs, childProcess, signal) => {
      const booted = await originalWaitForDeviceReady(device, timeoutMs, childProcess, signal);
      const resolved = { ...booted, deviceId: "emulator-5554" };
      deviceManager.setBootedDevices("android", [resolved]);
      return resolved;
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: coordinator,
      ensureCtrlProxyReady: async () => {
        throw new Error("automation readiness failed");
      },
    });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      timeoutMs: 60_000,
    });
    expect((response as any).isError).toBe(true);

    let leaseGranted = false;
    const contender = coordinator
      .reserve(
        { kind: "stable", platform: "android", stableId: "phone-api-36-a" },
        { operation: "start", deadlineMs: 60_000 },
      )
      .then((lease) => {
        leaseGranted = true;
        return lease;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(leaseGranted).toBe(false);

    expect(exitListeners.length).toBeGreaterThan(0);

    handle.exitCode = 0;
    for (const listener of exitListeners) {
      listener();
    }
    (await contender).release();
    expect(leaseGranted).toBe(true);
  });

  // A readiness failure caused by an exhausted deadline was reported and
  // persisted as `platform_command_failed`, so a controller that retries on
  // `timeout` but treats `platform_command_failed` as terminal gave up on a
  // purely time-based failure.
  test("reports an exhausted readiness budget as a timeout", async () => {
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        throw new RunnerReadinessError(
          "provisionDevice automation runner readiness failed: phase=runner-setup " +
            "attempts=1 remainingBudgetMs=0: readiness budget exhausted before setup lock",
          false,
          true,
        );
      },
    });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      timeoutMs: 60_000,
    });

    expect(JSON.parse((response as any).content[0].text)).toMatchObject({
      error: { code: "timeout", retryable: true },
    });
  });

  // A boot refused at the booted-device limit lost its code, wait hint and limit details and
  // surfaced as terminal `platform_command_failed` (#11236).
  test("keeps a boot capacity refusal typed and retryable", async () => {
    deviceManager.setDeviceImages("android", [
      { name: "phone-api-36-a", platform: "android", isRunning: false },
    ]);
    deviceManager.startDevice = async () => {
      throw new BootCapacityExhaustedError(
        {
          platform: "android",
          limit: 2,
          booted: 2,
          retryAfterMs: 5_000,
          externalDevices: ["emulator-5556"],
        },
        "Refused to boot: no Android capacity",
      );
    };

    const response = JSON.parse(await provisionResponseText(provisionTestArgs("android")));

    expect(response).toMatchObject({
      success: false,
      error: {
        code: "capacity_exhausted",
        retryable: true,
        retryAfterMs: 5_000,
        limit: 2,
        booted: 2,
        externalDevices: ["emulator-5556"],
      },
    });
  });

  test.each(["device_lost", "device_offline"] as const)(
    "classifies a real runner readiness %s failure as retryable",
    async (code) => {
      const timer = new FakeTimer();
      const failure =
        code === "device_lost"
          ? new DeviceLostError("emulator-5554", "device disappeared", "readiness-incident")
          : new AdbDeviceOfflineError("emulator-5554", "device offline");
      deviceManager.setBootedDevices("android", [
        { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
      ]);
      exactProvisioner.provision = async () => provisionedTestDevice("android", false);
      const service = new RunnerReadinessService({
        timer,
        getAndroidManager: () => ({
          isInstalled: async () => {
            throw failure;
          },
          isEnabled: async () => true,
          isVersionCompatible: async () => true,
          enable: async () => {},
          resetSetupState: () => {},
          setup: async () => ({ success: true, message: "ready" }),
          ensureCompatibleVersion: async () => ({ status: "compatible" }),
        }),
        getAndroidClient: () => ({
          isConnected: () => true,
          waitForConnection: async () => true,
          verifyServiceReady: async () => true,
          connectWithoutSetup: async () => true,
        }),
        getIosManager: () => {
          throw new Error("unexpected iOS manager");
        },
        getIosClient: () => {
          throw new Error("unexpected iOS client");
        },
        checkIosOverride: async () => ({ present: false, usable: true }),
        awaitIosStartupMaintenance: async () => {},
      });
      setDeviceToolsDependencies({
        timer,
        ensureCtrlProxyReady: (request) => service.ensureReady(request),
      });

      const response = JSON.parse(await provisionResponseText(provisionTestArgs("android")));
      expect(response).toMatchObject({
        error: {
          code,
          retryable: true,
          providerCode: failure.code,
          readinessPhase: "runner-setup",
          attempt: 1,
          deviceId: "emulator-5554",
          ...(code === "device_lost" ? { incidentId: "readiness-incident" } : {}),
        },
      });
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );

  test("a device held by another session is a typed retryable device_owned_by_other_session failure", async () => {
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        throw deviceAlreadyAssignedToAnotherSessionError("emulator-5554");
      },
    });

    const response = JSON.parse(await provisionResponseText(provisionTestArgs("android")));

    expect(response).toMatchObject({
      error: {
        code: "device_owned_by_other_session",
        retryable: true,
        deviceId: "emulator-5554",
      },
    });
  });

  test.each([
    [
      new DeviceOwnedByOtherDaemonError("emulator-5554", 4242),
      "device_owned_by_other_daemon",
      { ownerPid: 4242, retryAfterMs: DEVICE_OWNED_BY_OTHER_DAEMON_RETRY_AFTER_MS },
    ],
    [
      new DeviceCleanupInProgressError("emulator-5554", 750),
      "device_cleanup_in_progress",
      { retryAfterMs: 750 },
    ],
    [
      new SessionCreationTimeoutError("s-1", "emulator-5554", 5000),
      "session_creation_timeout",
      { retryAfterMs: DEFAULT_DEVICE_ACQUISITION_RETRY_AFTER_MS },
    ],
    [
      new DeviceShuttingDownError("emulator-5554"),
      "device_shutting_down",
      { retryAfterMs: DEVICE_SHUTTING_DOWN_RETRY_AFTER_MS },
    ],
  ] as const)(
    "a typed acquisition refusal %# is a retryable %s failure with its hints",
    async (refusal, code, extra) => {
      deviceManager.setBootedDevices("android", [
        { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
      ]);
      exactProvisioner.provision = async () => provisionedTestDevice("android", false);
      setDeviceToolsDependencies({
        ensureCtrlProxyReady: async () => {
          throw refusal;
        },
      });

      const response = JSON.parse(await provisionResponseText(provisionTestArgs("android")));

      expect(response).toMatchObject({
        error: { code, retryable: true, deviceId: "emulator-5554", ...extra },
      });
    },
  );

  // #11065: a repeated call re-runs readiness instead of replaying a stored failure.
  test("preserves missing-device diagnostics and re-runs readiness on a repeated call", async () => {
    deviceManager.setBootedDevices("android", [
      { name: "phone-api-36-a", platform: "android", deviceId: "emulator-5554" },
    ]);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    let readinessCalls = 0;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        readinessCalls++;
        throw new RunnerReadinessError(
          "provisionDevice automation runner readiness failed: phase=runner-setup attempts=1: " +
            "error: device 'emulator-5554' not found",
          false,
          false,
          "runner-setup",
          1,
          new DeviceLostError(
            "emulator-5554",
            "error: device 'emulator-5554' not found",
            "incident-6d",
          ),
        );
      },
    });
    const args = provisionTestArgs("android");

    const first = JSON.parse(await provisionResponseText(args));
    const repeated = JSON.parse(await provisionResponseText(args));

    expect(first).toMatchObject({
      error: {
        code: "device_lost",
        providerCode: "device_lost",
        retryable: true,
        readinessPhase: "runner-setup",
        attempt: 1,
        incidentId: "incident-6d",
        deviceId: "emulator-5554",
        daemonBuild: expect.any(String),
      },
    });
    expect(repeated.error).toMatchObject(first.error);
    expect(readinessCalls).toBe(2);
    expect(first.recovery).toMatchObject({
      boundary: "readiness_failure",
      // The recorded lifecycle says this request created nothing.
      outcomes: { deviceCreation: "not_created" },
      cleanup: { status: "unnecessary" },
      originalError: { code: "device_lost" },
      nextAction: { action: "retry", automaticRetrySafe: true },
    });
    expect(first.recovery).not.toHaveProperty("operationId");
  });

  test("reports a non-retryable identity conflict from the provisioning path", async () => {
    exactProvisioner.provision = async () => {
      throw new ProvisionDeviceError(
        "identity_conflict",
        "the requested device identity conflicts with an existing device",
      );
    };

    const response = await ToolRegistry.getTool("provisionDevice")!.handler(
      provisionTestArgs("android"),
    );

    expect(JSON.parse((response as any).content[0].text)).toMatchObject({
      success: false,
      error: { code: "identity_conflict", retryable: false },
    });
  });

  test("keeps a timeout retryable after successful rollback", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    exactProvisioner.provision = async (request) => {
      request.onBeforeCreate?.();
      deviceManager.setDeviceImages("android", [created.device]);
      throw new ProvisionDeviceError("timeout", "provisioning timed out");
    };

    const response = JSON.parse(
      (
        (await ToolRegistry.getTool("provisionDevice")!.handler(
          provisionTestArgs("android"),
        )) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: { code: "timeout", retryable: true },
      cleanup: { status: "succeeded" },
    });
  });

  test("publishes the terminal lifecycle after a cold-boot readiness timeout", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    let provisionCalls = 0;
    exactProvisioner.provision = async (request) => {
      provisionCalls++;
      request.onBeforeCreate?.();
      deviceManager.setDeviceImages("android", [created.device]);
      return created;
    };
    setDeviceToolsDependencies({
      exactDeviceProvisionerFactory: () => exactProvisioner,
      ensureCtrlProxyReady: async () => {
        throw new ProvisionDeviceError("timeout", "automation readiness exceeded the deadline");
      },
      idGenerator: new FakeIdGenerator(["cleanup-cold-timeout", "query-cold-timeout"]),
    });
    registerDeviceTools();
    const args = provisionTestArgs("android");

    const first = JSON.parse(
      ((await ToolRegistry.getTool("provisionDevice")!.handler(args)) as any).content[0].text,
    );
    const lifecycle = {
      state: "removed",
      phase: "cleanup",
      device: {
        platform: "android",
        stableId: "phone-api-36-a",
        name: "phone-api-36-a",
        runtimeDeviceId: "emulator-5554",
      },
      reason: {
        code: "timeout",
        message: expect.stringContaining("automation readiness exceeded the deadline"),
      },
      cleanup: {
        status: "succeeded",
        reason: "readiness_timeout",
      },
    };
    expect(first).toMatchObject({
      success: false,
      error: { code: "timeout" },
      lifecycle,
    });
    expect(provisionCalls).toBe(1);
    expect(await deviceManager.listDeviceImages("android")).toEqual([]);
    const followUp = DeviceSessionManager.createInstance({} as any);
    await expect(followUp.ensureDeviceReady("android", "emulator-5554")).rejects.toMatchObject({
      code: "device_lost",
      deviceId: "emulator-5554",
    });
  });

  test("makes a timeout non-retryable when rollback fails", async () => {
    const created = provisionedTestDevice("android", true);
    configureProvisionBootAndTeardown(deviceManager, "android");
    exactProvisioner.provision = async (request) => {
      request.onBeforeCreate?.();
      deviceManager.setDeviceImages("android", [created.device]);
      throw new ProvisionDeviceError("timeout", "provisioning timed out");
    };
    deviceManager.destroyDevice = async () => {
      throw new Error("platform delete failed");
    };

    const response = JSON.parse(
      (
        (await ToolRegistry.getTool("provisionDevice")!.handler(
          provisionTestArgs("android"),
        )) as any
      ).content[0].text,
    );

    expect(response).toMatchObject({
      success: false,
      error: { code: "cleanup_failed", retryable: false },
      cleanup: { status: "failed" },
    });
  });

  // Boot and automation readiness share one provision budget, so a slow cold
  // boot could consume all of it and leave CtrlProxy setup with a
  // millisecond ("readiness budget exhausted before setup lock"). Boot must be
  // bounded by its own share of the deadline instead.
  test("bounds boot by its own share instead of the whole provision budget", async () => {
    const timer = new FakeTimer();
    deviceManager.setDeviceImages("android", [
      { name: "phone-api-36-a", platform: "android", isRunning: false },
    ]);
    // A failed owned boot now waits for the emulator to exit before releasing the AVD (#9901),
    // so the fake process exits on SIGTERM instead of lingering on the never-advanced FakeTimer.
    const exitListeners: (() => void)[] = [];
    const handle: any = {
      exitCode: null,
      signalCode: null,
      once: (_event: string, listener: () => void) => {
        exitListeners.push(listener);
        return handle;
      },
      kill: () => {
        handle.exitCode = 0;
        exitListeners.forEach((listener) => listener());
        return true;
      },
    };
    deviceManager.setMockChildProcess("phone-api-36-a", handle);
    const originalWaitForDeviceReady = deviceManager.waitForDeviceReady.bind(deviceManager);
    deviceManager.waitForDeviceReady = async (device, timeoutMs, childProcess, signal) => {
      // Yield once so the boot phase has registered its deadline timer, then
      // model a slow cold boot that ends 1ms before the whole provision deadline.
      await Promise.resolve();
      timer.advanceTime(59_999);
      const booted = await originalWaitForDeviceReady(device, timeoutMs, childProcess, signal);
      const resolved = { ...booted, deviceId: "emulator-5554" };
      deviceManager.setBootedDevices("android", [resolved]);
      return resolved;
    };
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    let readinessBudgetMs: number | undefined;
    setDeviceToolsDependencies({
      timer,
      ensureCtrlProxyReady: async ({ totalDeadlineMs }) => {
        readinessBudgetMs = totalDeadlineMs - timer.now();
      },
    });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      timeoutMs: 60_000,
    });

    const payload = JSON.parse((response as any).content[0].text);
    // Either boot stayed inside its share and readiness kept a usable budget, or
    // boot overran its share and the request failed as a timeout. What must not
    // happen is readiness running with a starved budget.
    expect(readinessBudgetMs ?? Number.POSITIVE_INFINITY).toBeGreaterThan(1_000);
    expect(payload.error?.code).toBe("timeout");
  });

  // `reserveDeviceForReadiness` proves ownership through its `autolockClient`
  // argument before the caller starts readiness side effects ("Acquisition may
  // reboot a device during readiness recovery"). provisionDevice passed no
  // autolock client, so it reset the shared per-device CtrlProxy manager and
  // rewrote device resource settings on another MCP client's live device, only
  // failing afterwards at the bind.
  // #11065: with no operationId replay, a second client's provision of the
  // same exact device can never attach to the first client's session; it is
  // refused by session ownership while the first client keeps the device.
  test("refuses a concurrent provision of the same device from another MCP client", async () => {
    const originalAutolock = autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    try {
      const booted = {
        name: "phone-api-36-a",
        platform: "android" as const,
        deviceId: "emulator-5554",
      };
      deviceManager.setBootedDevices("android", [booted]);
      deviceManager.setDeviceImages("android", [
        { name: "phone-api-36-a", platform: "android", isRunning: true },
      ]);
      await pool.initializeWithDevices([booted]);
      DaemonState.getInstance().initialize(sessionManager, pool);
      exactProvisioner.provision = async () => provisionedTestDevice("android", false);
      let readinessCalls = 0;
      setDeviceToolsDependencies({
        timer,
        ensureCtrlProxyReady: async () => {
          readinessCalls++;
        },
      });
      const tool = ToolRegistry.getTool("provisionDevice")!;
      const args = { ...provisionTestArgs("android"), timeoutMs: 60_000 };

      const first = JSON.parse(
        ((await tool.handler({ ...args, __mcpSessionId: "client-a" })) as any).content[0].text,
      );
      const firstSessionId: string = first.sessionId;
      const second = JSON.parse(
        ((await tool.handler({ ...args, __mcpSessionId: "client-b" })) as any).content[0].text,
      );

      expect(first.lifecycleState).toBe("ready");
      expect(typeof firstSessionId).toBe("string");
      expect(second).toMatchObject({ success: false });
      expect(second.error.message).toContain("already assigned to another session");
      expect(second.sessionId).toBeUndefined();
      expect(readinessCalls).toBe(1);
      expect(pool.getDevice(booted.deviceId)?.sessionId).toBe(firstSessionId);
      expect(pool.resolveAutolockSessionForMcpSession("client-a", "android")).toBe(firstSessionId);
      expect(pool.resolveAutolockSessionForMcpSession("client-b", "android")).toBeUndefined();
    } finally {
      sessionManager.stopCleanupTimer();
      if (originalAutolock === undefined) {
        delete autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    }
  });

  test("does not touch a device autolocked to another MCP client", async () => {
    const originalAutolock = autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    try {
      const booted = {
        name: "phone-api-36-a",
        platform: "android" as const,
        deviceId: "emulator-5554",
      };
      deviceManager.setBootedDevices("android", [booted]);
      deviceManager.setDeviceImages("android", [
        { name: "phone-api-36-a", platform: "android", isRunning: true },
      ]);
      await pool.initializeWithDevices([booted]);
      DaemonState.getInstance().initialize(sessionManager, pool);
      await pool.autolockDevice(
        "emulator-5554",
        "android",
        "other-mcp-client",
        undefined,
        undefined,
        booted,
      );
      exactProvisioner.provision = async () => provisionedTestDevice("android", false);
      const resources = new FakeDeviceResourceController();
      let readinessCalls = 0;
      setDeviceToolsDependencies({
        timer,
        deviceResourceControllerFactory: () => resources,
        ensureCtrlProxyReady: async () => {
          readinessCalls++;
        },
      });

      const response = await ToolRegistry.getTool("provisionDevice")!.handler({
        ...provisionTestArgs("android"),
        timeoutMs: 60_000,
        resources: { wallpaperRendering: "disabled" as const },
        __mcpSessionId: "my-mcp-client",
      });

      expect({ readinessCalls, resourceRequests: resources.requests.length }).toEqual({
        readinessCalls: 0,
        resourceRequests: 0,
      });
      expect((response as any).isError).toBe(true);
    } finally {
      sessionManager.stopCleanupTimer();
      if (originalAutolock === undefined) {
        delete autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    }
  });

  test("keeps provision leases until cancelled autolock release persistence settles", async () => {
    const originalAutolock = autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    const metadataStarted = Promise.withResolvers<void>();
    const metadataFinished = Promise.withResolvers<void>();
    const releaseStarted = Promise.withResolvers<void>();
    const releaseFinished = Promise.withResolvers<void>();
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    persistence.markReleased = async () => {
      releaseStarted.resolve();
      await releaseFinished.promise;
    };
    const sessionManager = new SessionManager(timer, persistence);
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
        deviceSessionRepository: {
          markAutolockSession: async () => {
            metadataStarted.resolve();
            await metadataFinished.promise;
          },
        },
      }),
    );
    const booted = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    deviceManager.setBootedDevices("android", [booted]);
    deviceManager.setDeviceImages("android", [
      { name: booted.name, platform: "android", isRunning: true },
    ]);
    await pool.initializeWithDevices([booted]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    let readinessReleases = 0;
    const reserveReadiness = pool.reserveDeviceForReadiness.bind(pool);
    pool.reserveDeviceForReadiness = async (
      ...args: Parameters<DevicePool["reserveDeviceForReadiness"]>
    ) => {
      const release = await reserveReadiness(...args);
      const countedRelease = async () => {
        readinessReleases++;
        await release();
      };
      return Object.assign(countedRelease, { owner: release.owner });
    };
    let lifecycleReleases = 0;
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: {
        reserve: async () => ({
          signal: new AbortController().signal,
          identity: { kind: "stable", platform: "android", stableId: booted.name },
          bindCanonicalIdentity: async () => {},
          transitionToTeardown: () => {},
          release: () => {
            lifecycleReleases++;
          },
        }),
      },
      ensureCtrlProxyReady: async () => {
        timer.advanceTime(59_500);
      },
    });
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";

    try {
      const request = ToolRegistry.getTool("provisionDevice")!.handler({
        ...provisionTestArgs("android"),
        timeoutMs: 60_000,
        __mcpSessionId: "provision-mcp-client",
      });
      await metadataStarted.promise;

      await timer.advanceTimeAsync(500);
      const response = await request;
      expect((response as any).isError).toBe(true);
      await releaseStarted.promise;
      expect(readinessReleases).toBe(0);
      expect(lifecycleReleases).toBe(0);

      releaseFinished.resolve();
      for (let attempt = 0; attempt < 50; attempt++) {
        await Promise.resolve();
      }
      expect(readinessReleases).toBe(1);
      expect(lifecycleReleases).toBe(1);
    } finally {
      metadataFinished.resolve();
      releaseFinished.resolve();
      sessionManager.stopCleanupTimer();
      if (originalAutolock === undefined) {
        delete autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    }
  });

  test("keeps provision leases while cancelled autolock session creation settles", async () => {
    const originalAutolock = autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    const activeSessionWriteStarted = Promise.withResolvers<void>();
    const activeSessionWriteFinished = Promise.withResolvers<void>();
    const releaseStarted = Promise.withResolvers<void>();
    const releaseFinished = Promise.withResolvers<void>();
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    persistence.upsertActiveSession = async () => {
      activeSessionWriteStarted.resolve();
      await activeSessionWriteFinished.promise;
    };
    persistence.markReleased = async () => {
      releaseStarted.resolve();
      await releaseFinished.promise;
    };
    const sessionManager = new SessionManager(timer, persistence);
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    const booted = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    deviceManager.setBootedDevices("android", [booted]);
    deviceManager.setDeviceImages("android", [
      { name: booted.name, platform: "android", isRunning: true },
    ]);
    await pool.initializeWithDevices([booted]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    let readinessReleases = 0;
    const reserveReadiness = pool.reserveDeviceForReadiness.bind(pool);
    pool.reserveDeviceForReadiness = async (
      ...args: Parameters<DevicePool["reserveDeviceForReadiness"]>
    ) => {
      const release = await reserveReadiness(...args);
      const countedRelease = async () => {
        readinessReleases++;
        await release();
      };
      return Object.assign(countedRelease, { owner: release.owner });
    };
    let lifecycleReleases = 0;
    setDeviceToolsDependencies({
      timer,
      lifecycleCoordinator: {
        reserve: async () => ({
          signal: new AbortController().signal,
          identity: { kind: "stable", platform: "android", stableId: booted.name },
          bindCanonicalIdentity: async () => {},
          transitionToTeardown: () => {},
          release: () => {
            lifecycleReleases++;
          },
        }),
      },
      ensureCtrlProxyReady: async () => {
        timer.advanceTime(59_500);
      },
    });
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";

    try {
      const request = ToolRegistry.getTool("provisionDevice")!.handler({
        ...provisionTestArgs("android"),
        timeoutMs: 60_000,
        __mcpSessionId: "provision-mcp-client",
      });
      await activeSessionWriteStarted.promise;

      await timer.advanceTimeAsync(500);
      const response = await request;
      expect((response as any).isError).toBe(true);
      expect(readinessReleases).toBe(0);
      expect(lifecycleReleases).toBe(0);

      activeSessionWriteFinished.resolve();
      await releaseStarted.promise;
      expect(readinessReleases).toBe(0);
      expect(lifecycleReleases).toBe(0);

      releaseFinished.resolve();
      for (let attempt = 0; attempt < 50; attempt++) {
        await Promise.resolve();
      }
      expect(readinessReleases).toBe(1);
      expect(lifecycleReleases).toBe(1);
    } finally {
      activeSessionWriteFinished.resolve();
      releaseFinished.resolve();
      sessionManager.stopCleanupTimer();
      if (originalAutolock === undefined) {
        delete autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
      } else {
        autolockEnv.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = originalAutolock;
      }
    }
  });

  // `reserveProvisionDeviceReadiness` records a stable-name readiness
  // reservation keyed `android:<avd>`. If the pooled entry's incarnation changes
  // while readiness is in flight (a disconnect + rediscovery of the same serial,
  // i.e. exactly the Android-reboot case the name reservation exists to bridge),
  // provisionDevice must still be able to bind: its own reservation owner has to
  // be handed to `bindBootedDeviceSession`, or the reservation denies its own bind.
  test("binds through its own readiness name reservation after an incarnation change", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const pool = new DevicePool(
      isolatedPoolDependencies(sessionManager, "daemon-session", {
        env: autolockEnv,
        timer: timer,
        deviceManager: deviceManager,
      }),
    );
    const booted = {
      name: "phone-api-36-a",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    const avdInfo = {
      name: "phone-api-36-a",
      platform: "android" as const,
      isRunning: true,
      source: "local" as const,
    };
    deviceManager.setBootedDevices("android", [booted]);
    deviceManager.setDeviceImages("android", [avdInfo]);
    await pool.initializeWithDevices([booted]);
    // `trackStableName` only fires for an emulator whose pooled AVD name matches.
    (pool as any).devices.get("emulator-5554").avdName = "phone-api-36-a";
    DaemonState.getInstance().initialize(sessionManager, pool);
    exactProvisioner.provision = async () => provisionedTestDevice("android", false);
    setDeviceToolsDependencies({
      timer,
      ensureCtrlProxyReady: async () => {
        // A disconnect + rediscovery of the same serial mints a new incarnation.
        await pool.removeDevice("emulator-5554");
        await pool.addDevice(booted, avdInfo);
      },
    });

    const response = await ToolRegistry.getTool("provisionDevice")!.handler({
      ...provisionTestArgs("android"),
      timeoutMs: 60_000,
    });

    expect((response as any).isError).toBeFalsy();
    const payload = JSON.parse((response as any).content[0].text);
    expect(payload.error).toBeUndefined();
    expect(payload).toMatchObject({
      lifecycleState: "ready",
      sessionId: expect.any(String),
    });
  });

  test("reserves rollback and response time from the daemon's queued-request deadline", async () => {
    const timer = new FakeTimer();
    let provisionDeadlineMs: number | undefined;
    setDeviceToolsDependencies({
      timer,
      exactDeviceProvisionerFactory: () => ({
        provision: async (request) => {
          provisionDeadlineMs = request.deadlineMs;
          return provisionedTestDevice("android", true);
        },
      }),
    });
    registerDeviceTools();
    const tool = ToolRegistry.getTool("provisionDevice");
    if (!tool) {
      throw new Error("provisionDevice not registered");
    }

    await tool.handler({
      ...provisionTestArgs("android"),
      boot: false,
      readiness: "none",
      timeoutMs: 100_000,
      // The outer request originally had 165s (100s provisioning + 60s
      // rollback + 5s response headroom); 20s elapsed in the socket queue.
      __mcpRequestTimeoutMs: 145_000,
      __mcpRequestDeadlineMs: 145_000,
    });

    expect(provisionDeadlineMs).toBe(80_000);
  });
});

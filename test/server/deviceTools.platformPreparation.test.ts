import {
  DEFAULT_DEVICE_READY_TIMEOUT_MS,
  MAX_DEVICE_READY_TIMEOUT_MS,
} from "../../src/utils/deviceTimeouts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getAndroidSchema,
  getAppleSchema,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ActionableError, type BootedDevice, type DeviceInfo } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { DeviceBootTimeoutError } from "../../src/utils/deviceBootService";
import type {
  VirtualDeviceLifecycleCoordinator,
  VirtualDeviceLifecycleLease,
} from "../../src/utils/virtualDeviceLifecycleCoordinator";

describe("platform device preparation tools", () => {
  let deviceUtils: FakeDeviceUtils;
  let matcher: FakeDeviceMatcher;
  let timer: FakeTimer;
  let sessionManager: SessionManager | undefined;

  beforeEach(() => {
    deviceUtils = new FakeDeviceUtils();
    matcher = new FakeDeviceMatcher();
    timer = new FakeTimer();
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceUtils,
      deviceMatcherFactory: () => matcher,
      ensureCtrlProxyReady: async () => {},
      notifyResourcesChanged: async () => {},
      timer,
    });
    registerDeviceTools();
  });

  afterEach(() => {
    resetDeviceToolsDependencies();
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
  });

  async function callTool(
    name: "getAndroid" | "getApple" | "startDevice",
    args: Record<string, unknown>,
  ) {
    const tool = ToolRegistry.getTool(name);
    if (!tool) {
      throw new Error(`${name} is not registered`);
    }
    const result = await tool.handler(args);
    return JSON.parse(
      typeof result === "string" ? result : ((result as any).content?.[0]?.text ?? "{}"),
    );
  }

  for (const [operation, platform, target] of [
    ["getAndroid", "android", { avdName: "Pixel" }],
    ["getApple", "ios", { udid: "sim-udid" }],
  ] as const) {
    test(`${operation} attributes boot deadlines to the requested acquisition`, async () => {
      class SlowDiscovery extends FakeDeviceUtils {
        override async listDeviceImages(selectedPlatform: "android" | "ios") {
          const images = await super.listDeviceImages(selectedPlatform);
          timer.advanceTime(11);
          return images;
        }
      }
      const slow = new SlowDiscovery();
      slow.setDeviceImages(platform, [
        { platform, name: "Pixel", deviceId: "sim-udid", isRunning: false },
      ]);
      setDeviceToolsDependencies({ deviceManagerFactory: () => slow });
      const failure = await callTool(operation, { ...target, bootTimeoutMs: 10 }).catch(
        (error) => error,
      );
      expect(failure).toBeInstanceOf(DeviceBootTimeoutError);
      expect(failure.operation).toBe(operation);
      expect(failure.message).toContain(`${operation} timeout exhausted`);
      expect(failure.budgetMs).toBe(10);
    });
  }

  test("reports a start lifecycle-reservation timeout against the acquisition budget", async () => {
    deviceUtils.setDeviceImages("android", [
      { platform: "android", name: "Pixel_9_API_36", isRunning: false, source: "local" },
    ]);
    const stalledCoordinator: VirtualDeviceLifecycleCoordinator = {
      reserve: async () => {
        timer.advanceTime(10_000);
        throw new Error("lifecycle reservation aborted");
      },
    };
    setDeviceToolsDependencies({ lifecycleCoordinator: stalledCoordinator });

    const failure = await callTool("getAndroid", {
      avdName: "Pixel_9_API_36",
      bootTimeoutMs: 5_000,
      automationReadyTimeoutMs: 1_000,
    }).catch((error: Error) => error);

    // This is the acquisition path: the killDevice-shaped default reported a
    // shutdown timeout against an unrelated 30s budget.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("to disappear after");
    expect((failure as Error).message).toContain("getAndroid timeout exhausted");
    expect((failure as Error).message).toContain("budgetMs=6000");
  });

  test("advertises the combined preparation budget including omitted defaults", () => {
    for (const [name, schema, target] of [
      ["getAndroid", getAndroidSchema, { avdName: "Pixel" }],
      ["getApple", getAppleSchema, { udid: "sim-udid" }],
    ] as const) {
      const definition = ToolRegistry.getToolDefinitions().find((tool) => tool.name === name)!;
      const properties = definition.inputSchema.properties as Record<
        string,
        { description: string }
      >;
      for (const field of ["bootTimeoutMs", "automationReadyTimeoutMs"]) {
        expect(properties[field].description).toContain(
          `bootTimeoutMs + automationReadyTimeoutMs must be <= ${MAX_DEVICE_READY_TIMEOUT_MS}`,
        );
        expect(properties[field].description).toContain("including defaults for omitted fields");
      }
      const maximumWithDefaultBoot = MAX_DEVICE_READY_TIMEOUT_MS - DEFAULT_DEVICE_READY_TIMEOUT_MS;
      expect(properties.automationReadyTimeoutMs.description).toContain(
        `when bootTimeoutMs is omitted, this must be <= ${maximumWithDefaultBoot}`,
      );
      expect(
        schema.safeParse({ ...target, automationReadyTimeoutMs: maximumWithDefaultBoot }).success,
      ).toBe(true);
      expect(
        schema.safeParse({ ...target, automationReadyTimeoutMs: maximumWithDefaultBoot + 1 })
          .success,
      ).toBe(false);
      expect(
        schema.safeParse({ ...target, bootTimeoutMs: 90_000, automationReadyTimeoutMs: 800_000 })
          .success,
      ).toBe(true);
    }
  });

  test("getAndroid returns the AVD to ADB serial and port mapping", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    deviceUtils.setBootedDevices("android", [emulator]);
    matcher.setBootedResult(emulator);

    const result = await callTool("getAndroid", { avdName: "Pixel_9_API_36" });

    // #5870: acquisition tools return `sessionUuid` (the key every consumer
    // tool's schema declares), not `sessionId`.
    expect(result.sessionUuid).toBeDefined();
    expect(result.sessionId).toBeUndefined();
    expect(result.deviceIdentity).toEqual({
      platform: "android",
      avdName: "Pixel_9_API_36",
      adbSerial: "emulator-5562",
      emulatorConsolePort: 5562,
    });
  });

  test("getAndroid reports Android API and release metadata from its selected AVD image", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    const image = {
      platform: "android" as const,
      name: emulator.name,
      isRunning: true,
      apiLevel: 36,
      osVersion: "16",
    };
    deviceUtils.setDeviceImages("android", [image]);
    deviceUtils.setBootedDevices("android", [emulator]);
    matcher.setBootedResult(emulator);

    const result = await callTool("getAndroid", { avdName: emulator.name });

    expect(result.deviceIdentity).toMatchObject({ apiLevel: 36, osVersion: "16" });
  });

  test("getApple accepts only a simulator UDID and returns its simulator identity", async () => {
    const simulator: DeviceInfo = {
      platform: "ios",
      name: "iPhone 17",
      deviceId: "E2F46BCE-4C97-4AA0-BD9D-544756FAB545",
      isRunning: false,
    };
    deviceUtils.setDeviceImages("ios", [simulator]);

    const result = await callTool("getApple", { udid: simulator.deviceId });

    expect(result.deviceIdentity).toEqual({
      platform: "ios",
      simulatorUdid: simulator.deviceId,
      simulatorName: simulator.name,
    });
    expect(deviceUtils.getExecutedOperations()).toContain(
      `startDevice:${simulator.name}:${DEFAULT_DEVICE_READY_TIMEOUT_MS}`,
    );
  });

  test("uses explicit boot and automation readiness budgets without accepting matcher inputs", async () => {
    const image: DeviceInfo = {
      platform: "android",
      name: "Pixel_9_API_36",
      isRunning: false,
    };
    let readinessRequest: { readinessTimeoutMs: number; totalDeadlineMs: number } | undefined;
    deviceUtils.setDeviceImages("android", [image]);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async (request) => {
        readinessRequest = {
          readinessTimeoutMs: request.readinessTimeoutMs,
          totalDeadlineMs: request.totalDeadlineMs,
        };
      },
    });

    await callTool("getAndroid", {
      avdName: image.name,
      bootTimeoutMs: 40_000,
      automationReadyTimeoutMs: 20_000,
    });

    expect(deviceUtils.getExecutedOperations()).toContain(`startDevice:${image.name}:40000`);
    expect(readinessRequest).toEqual({
      readinessTimeoutMs: 20_000,
      totalDeadlineMs: 60_000,
    });
    // #5870: `deviceId` — the identifier every device resource leads with — is
    // now an accepted target on getAndroid alongside `avdName`, but only when
    // both spellings name the same AVD.
    expect(() =>
      getAndroidSchema.parse({ avdName: image.name, deviceId: image.name }),
    ).not.toThrow();
    // `platform` remains an unrecognized key on getApple (strict schema).
    expect(() => getAppleSchema.parse({ udid: "sim-udid", platform: "ios" })).toThrow();
  });

  test("getAndroid accepts a deviceId target and prepares that serial (#5870)", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5554",
    };
    deviceUtils.setBootedDevices("android", [emulator]);
    matcher.setBootedResult(emulator);

    const result = await callTool("getAndroid", { deviceId: "emulator-5554" });

    expect(result.sessionUuid).toBeDefined();
    expect(result.deviceIdentity).toMatchObject({ adbSerial: "emulator-5554" });
  });

  test("getAndroid reuses an already-running AVD named through deviceId (#5870)", async () => {
    // Mirrors MultiPlatformDeviceManager.startDevice's production guard
    // (src/utils/deviceUtils.ts) which the plain fake omits: cold-booting a
    // second copy of a live AVD is rejected by the platform.
    class GuardedDeviceUtils extends FakeDeviceUtils {
      override async startDevice(device: DeviceInfo, timeoutMs?: number) {
        if (await this.isDeviceImageRunning(device)) {
          throw new ActionableError(
            `${device.platform} device '${device.name}' is already running`,
          );
        }
        return await super.startDevice(device, timeoutMs);
      }
    }
    const guarded = new GuardedDeviceUtils();
    const running: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5554",
    };
    guarded.setBootedDevices("android", [running]);
    guarded.setDeviceImages("android", [
      { platform: "android", name: running.name, isRunning: true, source: "local" },
    ]);
    setDeviceToolsDependencies({ deviceManagerFactory: () => guarded });
    matcher.setBootedResult(running);

    const result = await callTool("getAndroid", { deviceId: running.name });

    expect(result.deviceIdentity).toMatchObject({ adbSerial: running.deviceId });
    expect(guarded.getExecutedOperations().join("|")).not.toContain("startDevice:");
  });

  test("getApple accepts a deviceId target alongside udid (#5870)", async () => {
    const simulator: DeviceInfo = {
      platform: "ios",
      name: "iPhone 17",
      deviceId: "E2F46BCE-4C97-4AA0-BD9D-544756FAB545",
      isRunning: false,
    };
    deviceUtils.setDeviceImages("ios", [simulator]);

    const result = await callTool("getApple", { deviceId: simulator.deviceId });

    expect(result.deviceIdentity).toMatchObject({ simulatorUdid: simulator.deviceId });
  });

  test("getApple ignores daemon deadline provenance before strict schema validation", async () => {
    const simulator: DeviceInfo = {
      platform: "ios",
      name: "iPhone 17",
      deviceId: "E2F46BCE-4C97-4AA0-BD9D-544756FAB545",
      isRunning: false,
    };
    deviceUtils.setDeviceImages("ios", [simulator]);

    const result = await callTool("getApple", {
      deviceId: simulator.deviceId,
      __mcpRequestTimeoutMs: 120_000,
      __mcpRequestDeadlineMs: Date.now() + 120_000,
      __mcpLiveDeadlineKey: "daemon-deadline-key",
    });

    expect(result.deviceIdentity).toMatchObject({ simulatorUdid: simulator.deviceId });
  });

  test("getAndroid accepts avdName paired with that AVD's running serial", async () => {
    // `deviceId` is documented as a serial OR an image name, so the pair is
    // only contradictory when the resolved device disagrees with it.
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_A",
      deviceId: "emulator-5556",
    };
    deviceUtils.setBootedDevices("android", [emulator]);

    const result = await callTool("getAndroid", {
      avdName: emulator.name,
      deviceId: emulator.deviceId,
    });

    expect(result.deviceIdentity).toMatchObject({
      avdName: emulator.name,
      adbSerial: emulator.deviceId,
    });
  });

  test("getAndroid validates an avdName and serial pair after its startup lease", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_A",
      deviceId: "emulator-5556",
    };
    const image: DeviceInfo = {
      platform: "android",
      name: emulator.name,
      isRunning: false,
      source: "local",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(emulator, image);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setDeviceImages("android", [image]);
    deviceUtils.setBootedDevices("android", []);
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(emulator.deviceId)!]);

    const preparation = callTool("getAndroid", {
      avdName: emulator.name,
      deviceId: emulator.deviceId,
    });

    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        await Promise.resolve();
      }
      deviceUtils.setBootedDevices("android", [emulator]);
      await pool.releaseAdbServerResetCohortReservations(detached.devices);

      await expect(preparation).resolves.toMatchObject({
        deviceIdentity: { avdName: emulator.name, adbSerial: emulator.deviceId },
      });
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
    }
  });

  test("getAndroid rejects contradictory avdName and deviceId instead of silently preferring one", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_A",
      deviceId: "emulator-5554",
    };
    deviceUtils.setBootedDevices("android", [emulator]);

    const failure = await callTool("getAndroid", {
      avdName: emulator.name,
      deviceId: "emulator-5556",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as ActionableError).message).toContain("identifier_conflict");
    // The conflict is decided from a discovery sweep, so no device is booted
    // (and then killed) only to report it.
    expect(deviceUtils.wasMethodCalled("startDevice")).toBe(false);
  });

  test("getAndroid rejects a stopped AVD paired with a foreign running serial before booting", async () => {
    // avdName names a stopped AVD; the requested serial is running a different
    // AVD. The pair is contradictory without booting anything, so the old
    // post-boot recheck (which cold-booted Pixel_A and killed it) is wrong here.
    deviceUtils.setDeviceImages("android", [
      { platform: "android", name: "Pixel_A", isRunning: false, source: "local" },
    ]);
    deviceUtils.setBootedDevices("android", [
      { platform: "android", name: "Pixel_B", deviceId: "emulator-5556" },
    ]);

    const failure = await callTool("getAndroid", {
      avdName: "Pixel_A",
      deviceId: "emulator-5556",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as ActionableError).message).toContain("identifier_conflict");
    expect((failure as ActionableError).message).toContain("Pixel_B");
    expect(deviceUtils.wasMethodCalled("startDevice")).toBe(false);
  });

  test("getAndroid rejects an avdName paired with a serial that is not running before booting", async () => {
    // Neither identifier maps to a running device: the serial is absent from
    // discovery. That is still a contradiction the caller must resolve, decided
    // before any boot.
    deviceUtils.setDeviceImages("android", [
      { platform: "android", name: "Pixel_C", isRunning: false, source: "local" },
    ]);

    const failure = await callTool("getAndroid", {
      avdName: "Pixel_C",
      deviceId: "emulator-5599",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as ActionableError).message).toContain("identifier_conflict");
    expect((failure as ActionableError).message).toContain("not running");
    expect(deviceUtils.wasMethodCalled("startDevice")).toBe(false);
  });

  test("getApple rejects contradictory udid and deviceId instead of silently preferring one", () => {
    expect(() => getAppleSchema.parse({ udid: "UDID-A", deviceId: "UDID-B" })).toThrow(
      /identifier_conflict/,
    );
    expect(() => getAppleSchema.parse({ udid: "UDID-A", deviceId: "UDID-A" })).not.toThrow();
  });

  test("getAndroid rejects a call with neither avdName nor deviceId, naming the source (#5870)", () => {
    expect(() => getAndroidSchema.parse({})).toThrow(/avdName.*deviceId|deviceId.*avdName/i);
  });

  test("getApple rejects a call with neither udid nor deviceId (#5870)", () => {
    expect(() => getAppleSchema.parse({})).toThrow(/udid.*deviceId|deviceId.*udid/i);
  });

  test("matches the requested Android AVD name exactly", async () => {
    const exact: BootedDevice = {
      platform: "android",
      name: "Pixel_9",
      deviceId: "emulator-5554",
    };
    const overlapping: BootedDevice = {
      platform: "android",
      name: "Pixel_9_Pro",
      deviceId: "emulator-5556",
    };
    deviceUtils.setBootedDevices("android", [overlapping, exact]);

    const result = await callTool("getAndroid", { avdName: exact.name });

    expect(result.name).toBe(exact.name);
    expect(result.deviceIdentity).toMatchObject({ avdName: exact.name, adbSerial: exact.deviceId });
  });

  test("reuses the existing session for repeated warm getAndroid calls", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(emulator);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setBootedDevices("android", [emulator]);

    const first = await callTool("getAndroid", { avdName: emulator.name });
    const second = await callTool("getAndroid", { avdName: emulator.name });

    expect(second.sessionUuid).toBe(first.sessionUuid);
    expect(pool.getDevice(emulator.deviceId)).toMatchObject({ avdName: emulator.name });
  });

  test("records the AVD identity after binding an externally booted emulator", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setBootedDevices("android", [emulator]);

    await callTool("getAndroid", { avdName: emulator.name });

    expect(pool.getDevice(emulator.deviceId)).toMatchObject({
      avdName: emulator.name,
      androidImage: { name: emulator.name, platform: "android" },
    });
  });

  test("preserves admitted Android metadata for a serial-targeted warm acquisition", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    const admittedImage: DeviceInfo = {
      platform: "android",
      name: emulator.name,
      isRunning: true,
      apiLevel: 36,
      osVersion: "16",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(emulator, admittedImage);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setBootedDevices("android", [emulator]);

    const result = await callTool("getAndroid", { deviceId: emulator.deviceId });

    expect(pool.getDevice(emulator.deviceId)?.androidImage).toMatchObject({
      apiLevel: 36,
      osVersion: "16",
    });
    expect(result).toMatchObject({ apiLevel: 36, osVersion: "16" });
  });

  test("preserves all admitted Android metadata for a serial-targeted warm acquisition", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    const admittedImage: DeviceInfo = {
      platform: "android",
      name: emulator.name,
      isRunning: true,
      deviceId: emulator.deviceId,
      source: "local",
      apiLevel: 36,
      osVersion: "16",
      formFactor: "phone",
      screenWidth: 1080,
      screenHeight: 2400,
      screenDensity: 420,
      capabilityInventory: {
        schemaVersion: 1,
        capabilities: [{ id: "android.hardware.nfc", state: "available", source: "avd_config" }],
      },
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(emulator, admittedImage);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setBootedDevices("android", [emulator]);

    await callTool("getAndroid", { deviceId: emulator.deviceId });

    expect(pool.getDevice(emulator.deviceId)?.androidImage).toMatchObject(admittedImage);
  });

  test("does not record an image for a serial-targeted externally booted emulator", async () => {
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(emulator);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setBootedDevices("android", [emulator]);

    await callTool("getAndroid", { deviceId: emulator.deviceId });

    expect(pool.getDevice(emulator.deviceId)?.androidImage).toBeUndefined();
  });

  test("still returns the bound session when post-boot resource notification fails", async () => {
    const image: DeviceInfo = {
      platform: "android",
      name: "Pixel_9_API_36",
      isRunning: false,
      source: "local",
    };
    deviceUtils.setDeviceImages("android", [image]);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceToolsDependencies({
      notifyResourcesChanged: async () => {
        throw new Error("resource sync failed");
      },
    });

    const result = await callTool("getAndroid", { avdName: image.name });

    // The acquisition is already committed by the time the notification runs;
    // failing it would strand a busy device under a session UUID the caller
    // never receives.
    expect(result.sessionUuid).toBeDefined();
    expect(pool.getDevice(`mock-${image.name}`)).toMatchObject({
      sessionId: result.sessionUuid,
    });
  });

  test("waits for a reset-cohort reservation before booting the requested AVD", async () => {
    const stale: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    const image: DeviceInfo = {
      platform: "android",
      name: stale.name,
      isRunning: false,
      source: "local",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(stale, image);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setDeviceImages("android", [image]);
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(stale.deviceId)!]);

    let settled = false;
    const preparation = callTool("getAndroid", { avdName: stale.name }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(deviceUtils.getExecutedOperations()).not.toContain(
      `startDevice:${stale.name}:${DEFAULT_DEVICE_READY_TIMEOUT_MS}`,
    );

    await pool.releaseAdbServerResetCohortReservations(detached.devices);
    await expect(preparation).resolves.toMatchObject({
      deviceIdentity: { avdName: stale.name },
    });
  });

  test("a deviceId-targeted getAndroid does not block reset recovery of an unrelated AVD", async () => {
    const target: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    const targetImage: DeviceInfo = {
      platform: "android",
      name: target.name,
      isRunning: false,
      source: "local",
    };
    const unrelated: BootedDevice = {
      platform: "android",
      name: "Pixel_Tablet_API_35",
      deviceId: "emulator-5570",
    };
    const unrelatedImage: DeviceInfo = {
      platform: "android",
      name: unrelated.name,
      isRunning: false,
      source: "local",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(target, targetImage);
    await pool.addDevice(unrelated, unrelatedImage);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setBootedDevices("android", [target, unrelated]);
    deviceUtils.setDeviceImages("android", [targetImage, unrelatedImage]);

    let releaseReadiness!: () => void;
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        await readinessGate;
      },
    });
    registerDeviceTools();

    const inFlight = callTool("getAndroid", { deviceId: target.deviceId });
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }

    // The in-flight acquisition owns emulator-5562 only. A wildcard startup
    // lease would defer every cohort here, and the DisconnectMonitor skips its
    // whole iteration on a deferred detachment.
    const detachment = await pool.detachAdbServerResetCohort([pool.getDevice(unrelated.deviceId)!]);
    expect(detachment.deferred).toBe(false);

    releaseReadiness();
    await inFlight;
    await pool.releaseAdbServerResetCohortReservations(detachment.devices);
  });

  // The same exactness must hold for the AVD-image-name spelling of `deviceId`
  // (`getAndroid({ deviceId: "Pixel_9_API_36" })`): the pool is keyed by running
  // serial, so an image that is not running yet is unknown to it. Falling back
  // to the unnamed wildcard lease there makes this exact acquisition wait on —
  // and defer — every unrelated reset cohort for its whole preparation.
  test("an image-name getAndroid does not block reset recovery of an unrelated AVD", async () => {
    const targetImage: DeviceInfo = {
      platform: "android",
      name: "Pixel_9_API_36",
      isRunning: false,
      source: "local",
    };
    const unrelated: BootedDevice = {
      platform: "android",
      name: "Pixel_Tablet_API_35",
      deviceId: "emulator-5570",
    };
    const unrelatedImage: DeviceInfo = {
      platform: "android",
      name: unrelated.name,
      isRunning: false,
      source: "local",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(unrelated, unrelatedImage);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setBootedDevices("android", [unrelated]);
    deviceUtils.setDeviceImages("android", [targetImage, unrelatedImage]);

    let releaseReadiness!: () => void;
    const readinessGate = new Promise<void>((resolve) => {
      releaseReadiness = resolve;
    });
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        await readinessGate;
      },
    });
    registerDeviceTools();

    const inFlight = callTool("getAndroid", { deviceId: targetImage.name });
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }

    const detachment = await pool.detachAdbServerResetCohort([pool.getDevice(unrelated.deviceId)!]);
    expect(detachment.deferred).toBe(false);

    releaseReadiness();
    await inFlight.catch(() => undefined);
    await pool.releaseAdbServerResetCohortReservations(detachment.devices);
  });

  test("applies the named boot deadline while waiting for reset recovery", async () => {
    const stale: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    const image: DeviceInfo = {
      platform: "android",
      name: stale.name,
      isRunning: false,
      source: "local",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(stale, image);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(stale.deviceId)!]);
    const preparation = callTool("startDevice", {
      platform: "android",
      name: stale.name,
      timeoutMs: 10,
    });

    try {
      await Promise.resolve();
      timer.advanceTime(10);
      await expect(preparation).rejects.toThrow(/Timed out waiting for Android AVD reset recovery/);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
    }
  });

  test("bounds pre-boot avdName and serial validation by the boot deadline", async () => {
    class SlowDiscovery extends FakeDeviceUtils {
      override async getBootedDevicesDetailed(platform: "android" | "ios" | "either") {
        timer.advanceTime(11);
        return await super.getBootedDevicesDetailed(platform);
      }
    }
    const slow = new SlowDiscovery();
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_A",
      deviceId: "emulator-5556",
    };
    slow.setBootedDevices("android", [emulator]);
    setDeviceToolsDependencies({ deviceManagerFactory: () => slow });

    const failure = await callTool("getAndroid", {
      avdName: emulator.name,
      deviceId: emulator.deviceId,
      bootTimeoutMs: 10,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as ActionableError).message).toContain(
      "pre-boot serial validation did not complete",
    );
    expect((failure as ActionableError).message).toContain("after 10ms");
  });

  test("drops a late pre-boot serial observation after the boot deadline releases its lease", async () => {
    class SlowDiscovery extends FakeDeviceUtils {
      override async getBootedDevicesDetailed(platform: "android" | "ios" | "either") {
        const discovery = await super.getBootedDevicesDetailed(platform);
        // The platform discovery ignored the coordinated abort long enough for
        // the deadline to settle its caller before returning this observation.
        timer.advanceTime(1_001);
        return discovery;
      }
    }
    const slow = new SlowDiscovery();
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5554",
    };
    slow.setBootedDevices("android", [emulator]);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      slow,
      new DefaultRetryExecutor(timer),
    );
    await pool.initializeWithDevices([emulator]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const observations: Array<{ source: string }> = [];
    const reconcile = pool.reconcileDiscoveryObservation.bind(pool);
    pool.reconcileDiscoveryObservation = async (devices, source, options) => {
      observations.push({ source });
      await reconcile(devices, source, options);
    };
    let releases = 0;
    const lease: VirtualDeviceLifecycleLease = {
      signal: new AbortController().signal,
      identity: { kind: "selector", platform: "android", selector: emulator.name },
      bindCanonicalIdentity: async () => {},
      transitionToTeardown: () => {},
      release: () => {
        releases++;
      },
    };
    const lifecycleCoordinator: VirtualDeviceLifecycleCoordinator = {
      reserve: async () => lease,
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => slow,
      lifecycleCoordinator,
    });

    const failure = await callTool("getAndroid", {
      avdName: emulator.name,
      deviceId: emulator.deviceId,
      bootTimeoutMs: 1_000,
    }).catch((error: unknown) => error);
    // Allow the losing discovery callback to finish after its deadline race.
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }

    expect(failure).toBeInstanceOf(Error);
    expect(observations.some(({ source }) => source === "pre-boot-serial-validation")).toBe(false);
    expect(releases).toBe(1);
  });

  test("releases the lifecycle lease promptly when abort-aware pre-boot discovery reaches its deadline", async () => {
    const bootTimeoutMs = 1_000;
    let markDiscoveryStarted: (() => void) | undefined;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    class AbortAwareDiscovery extends FakeDeviceUtils {
      override async getBootedDevicesDetailed(
        platform: "android" | "ios" | "either",
        options?: { signal?: AbortSignal },
      ) {
        const discovery = await super.getBootedDevicesDetailed(platform);
        markDiscoveryStarted!();
        await new Promise<void>((resolve, reject) => {
          const adbTimeout = timer.setTimeout(resolve, 10_000);
          options?.signal?.addEventListener(
            "abort",
            () => {
              timer.clearTimeout(adbTimeout);
              reject(options.signal?.reason ?? new Error("discovery aborted"));
            },
            { once: true },
          );
        });
        return discovery;
      }
    }
    const slow = new AbortAwareDiscovery();
    const emulator: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5554",
    };
    slow.setBootedDevices("android", [emulator]);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      slow,
      new DefaultRetryExecutor(timer),
    );
    await pool.initializeWithDevices([emulator]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const observations: string[] = [];
    const reconcile = pool.reconcileDiscoveryObservation.bind(pool);
    pool.reconcileDiscoveryObservation = async (devices, source, options) => {
      observations.push(source);
      await reconcile(devices, source, options);
    };
    let releases = 0;
    const lease: VirtualDeviceLifecycleLease = {
      signal: new AbortController().signal,
      identity: { kind: "selector", platform: "android", selector: emulator.name },
      bindCanonicalIdentity: async () => {},
      transitionToTeardown: () => {},
      release: () => {
        releases++;
      },
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => slow,
      lifecycleCoordinator: { reserve: async () => lease },
    });

    let failure: unknown;
    void callTool("getAndroid", {
      avdName: emulator.name,
      deviceId: emulator.deviceId,
      bootTimeoutMs,
    }).catch((error: unknown) => {
      failure = error;
    });
    await discoveryStarted;
    await timer.advanceTimeAsync(bootTimeoutMs);

    expect(failure).toBeInstanceOf(ActionableError);
    expect(releases).toBe(1);
    expect(observations).not.toContain("pre-boot-serial-validation");
  });

  test("keeps the lifecycle lease held while a pre-boot reconcile is still draining when the boot deadline fires", async () => {
    const bootTimeoutMs = 1_000;
    const emulatorA: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5554",
    };
    const emulatorB: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36_2",
      deviceId: "emulator-5556",
    };
    deviceUtils.setBootedDevices("android", [emulatorA, emulatorB]);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.initializeWithDevices([emulatorA, emulatorB]);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const initialDeviceB = pool.getDevice(emulatorB.deviceId);
    let resolveGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    const observations: string[] = [];
    const reconcile = pool.reconcileDiscoveryObservation.bind(pool);
    let reconcileSettled = false;
    pool.reconcileDiscoveryObservation = async (devices, source, options) => {
      observations.push(source);
      timer.advanceTime(bootTimeoutMs + 1);
      await gate;
      await reconcile(devices, source, options);
      reconcileSettled = true;
    };
    let releases = 0;
    let deviceBAtRelease: ReturnType<typeof pool.getDevice> | undefined;
    const lease: VirtualDeviceLifecycleLease = {
      signal: new AbortController().signal,
      identity: { kind: "selector", platform: "android", selector: emulatorA.name },
      bindCanonicalIdentity: async () => {},
      transitionToTeardown: () => {},
      release: () => {
        releases++;
        deviceBAtRelease = pool.getDevice(emulatorB.deviceId);
      },
    };
    const lifecycleCoordinator: VirtualDeviceLifecycleCoordinator = {
      reserve: async () => lease,
    };
    setDeviceToolsDependencies({
      deviceManagerFactory: () => deviceUtils,
      lifecycleCoordinator,
    });

    const failure = await callTool("getAndroid", {
      avdName: emulatorA.name,
      deviceId: emulatorA.deviceId,
      bootTimeoutMs,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ActionableError);
    expect((failure as ActionableError).message).toContain(
      "pre-boot serial validation did not complete",
    );
    expect(releases).toBe(0);
    expect(reconcileSettled).toBe(false);
    expect(observations).toEqual(["pre-boot-serial-validation"]);
    expect(initialDeviceB).toBeDefined();

    resolveGate!();
    for (let attempt = 0; attempt < 50; attempt++) {
      await Promise.resolve();
    }

    expect(reconcileSettled).toBe(true);
    expect(releases).toBe(1);
    expect(observations).toEqual(["pre-boot-serial-validation"]);
    expect(deviceBAtRelease).toBe(initialDeviceB);
    expect(pool.getDevice(emulatorB.deviceId)).toBe(deviceBAtRelease);
  });

  test("waits for fuzzy legacy Android names that match a reserved AVD", async () => {
    const stale: BootedDevice = {
      platform: "android",
      name: "Pixel_9_API_36",
      deviceId: "emulator-5562",
    };
    const image: DeviceInfo = {
      platform: "android",
      name: stale.name,
      isRunning: false,
      source: "local",
    };
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
      new FakeInstalledAppsRepository(),
      deviceUtils,
      new DefaultRetryExecutor(timer),
    );
    await pool.addDevice(stale, image);
    DaemonState.getInstance().initialize(sessionManager, pool);
    deviceUtils.setDeviceImages("android", [image]);
    const detached = await pool.detachAdbServerResetCohort([pool.getDevice(stale.deviceId)!]);
    let settled = false;
    const preparation = callTool("startDevice", {
      platform: "android",
      name: "Pixel",
    }).finally(() => {
      settled = true;
    });

    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(deviceUtils.getExecutedOperations()).not.toContain(
        `startDevice:${stale.name}:${DEFAULT_DEVICE_READY_TIMEOUT_MS}`,
      );

      deviceUtils.setBootedDevices("android", [stale]);
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
      await preparation.catch(() => undefined);
      expect(settled).toBe(true);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached.devices);
    }
  });
});

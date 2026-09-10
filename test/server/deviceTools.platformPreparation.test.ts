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
import type { BootedDevice, DeviceInfo } from "../../src/models";
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
      transportId: "17",
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
      adbTransportId: "17",
    });
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
    // now an accepted target on getAndroid alongside `avdName`.
    expect(() =>
      getAndroidSchema.parse({ avdName: image.name, deviceId: "emulator-5554" }),
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
    const detachment = await pool.detachAdbServerResetCohort([
      pool.getDevice(unrelated.deviceId)!,
    ]);
    expect(detachment.deferred).toBe(false);

    releaseReadiness();
    await inFlight;
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

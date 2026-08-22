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

  async function callTool(name: "getAndroid" | "getApple" | "startDevice", args: Record<string, unknown>) {
    const tool = ToolRegistry.getTool(name);
    if (!tool) {
      throw new Error(`${name} is not registered`);
    }
    const result = await tool.handler(args);
    return JSON.parse(
      typeof result === "string" ? result : ((result as any).content?.[0]?.text ?? "{}"),
    );
  }

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

    expect(result.sessionId).toBeDefined();
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
    expect(deviceUtils.getExecutedOperations()).toContain(`startDevice:${simulator.name}:120000`);
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
    expect(() =>
      getAndroidSchema.parse({ avdName: image.name, deviceId: "emulator-5554" }),
    ).toThrow();
    expect(() => getAppleSchema.parse({ udid: "sim-udid", platform: "ios" })).toThrow();
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

    expect(second.sessionId).toBe(first.sessionId);
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
    const preparation = callTool("getAndroid", { avdName: stale.name }).then(result => {
      settled = true;
      return result;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(deviceUtils.getExecutedOperations()).not.toContain(`startDevice:${stale.name}:120000`);

    await pool.releaseAdbServerResetCohortReservations(detached);
    await expect(preparation).resolves.toMatchObject({
      deviceIdentity: { avdName: stale.name },
    });
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
      await pool.releaseAdbServerResetCohortReservations(detached);
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
      expect(deviceUtils.getExecutedOperations()).not.toContain(`startDevice:${stale.name}:120000`);

      deviceUtils.setBootedDevices("android", [stale]);
      await pool.releaseAdbServerResetCohortReservations(detached);
      await preparation.catch(() => undefined);
      expect(settled).toBe(true);
    } finally {
      await pool.releaseAdbServerResetCohortReservations(detached);
    }
  });
});

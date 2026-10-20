import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toolJson } from "../helpers/toolResponse";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { clearDirectSessionDevices } from "../../src/utils/directSessionDeviceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { AndroidAvdProvenanceCache } from "../../src/utils/AndroidAvdProvenanceCache";
import { DefaultDeviceMatcher } from "../../src/utils/deviceMatcher";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

isolateToolRegistry();

/**
 * #11648: with an explicit `deviceId`, a `name` the identified device does not carry was silently
 * ignored unless another constraint accompanied it. `name` is a spec field like any other: it is
 * compared the way the selector path compares it (case-insensitive substring of the device name:
 * the AVD name on Android, the simulator name on iOS), and a mismatch is refused.
 */
describe("startDevice with a deviceId and a name", () => {
  const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  let restoreEnv: (() => void) | undefined;
  let sessionManager: SessionManager | undefined;
  let pool: DevicePool;
  let bootOperations: () => string[] = () => [];

  const cleanup = () => {
    restoreEnv?.();
    restoreEnv = undefined;
    resetDeviceToolsDependencies();
    clearDirectSessionDevices();
    DaemonState.getInstance().reset();
    sessionManager?.stopCleanupTimer();
    sessionManager = undefined;
    PlatformDeviceManagerFactory.reset();
    AndroidAvdProvenanceCache.resetForTests();
  };
  beforeEach(cleanup);
  afterEach(cleanup);
  afterAll(cleanup);

  async function arrange(
    device: BootedDevice,
    image: DeviceInfo,
    booted: BootedDevice[] = [device],
  ): Promise<void> {
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const deviceUtils = new FakeDeviceUtils();
    const timer = new FakeTimer();
    bootOperations = () =>
      deviceUtils
        .getExecutedOperations()
        .filter((operation) => operation.startsWith("startDevice:"));
    deviceUtils.setBootedDevices(device.platform, booted);
    deviceUtils.setDeviceImages(device.platform, [image]);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices(booted);
    DaemonState.getInstance().initialize(sessionManager, pool);
    setDeviceToolsDependencies({
      env,
      timer,
      deviceManagerFactory: () => deviceUtils,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      idGenerator: new CountingIdGenerator("session"),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
    });
    setDeviceManager(deviceUtils);
    registerDeviceTools();
  }

  async function startOutcome(args: Record<string, unknown>): Promise<string> {
    try {
      const result = await ToolRegistry.getTool("startDevice")!.handler(args);
      return `bound ${String(toolJson(result).name)}`;
    } catch (error) {
      return `refused: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  test("iOS: a UDID plus a name that simulator does not carry is refused, with or without another constraint", async () => {
    const udid = "11111111-1111-4111-8111-111111111111";
    const device: BootedDevice = {
      name: "iPhone 15",
      platform: "ios",
      deviceId: udid,
      osVersion: "17.2",
      iosVersion: "17.2",
      formFactor: "phone",
    };
    await arrange(device, { ...device, isRunning: true });

    // Control: the same contradiction next to another constraint is already refused.
    const withConstraint = await startOutcome({
      platform: "ios",
      deviceId: udid,
      name: "iPad Pro",
      formFactor: "phone",
    });
    expect(withConstraint).toContain("does not satisfy the requested constraints");
    expect(pool.getDevice(udid)?.sessionId).toBeNull();

    const nameOnly = await startOutcome({ platform: "ios", deviceId: udid, name: "iPad Pro" });

    expect(nameOnly).toContain("refused");
    expect(pool.getDevice(udid)?.sessionId).toBeNull();
  });

  test("Android: a serial plus a name that emulator does not carry is refused", async () => {
    const device: BootedDevice = {
      name: "Pixel_7_API_34",
      platform: "android",
      deviceId: "emulator-5554",
      osVersion: "14",
      apiLevel: 34,
      formFactor: "phone",
    };
    await arrange(device, { ...device, isRunning: true });

    const nameOnly = await startOutcome({
      platform: "android",
      deviceId: device.deviceId,
      name: "Pixel_Tablet",
    });

    expect(nameOnly).toContain("refused");
    expect(pool.getDevice(device.deviceId)?.sessionId).toBeNull();
  });

  const iphone: BootedDevice = {
    name: "iPhone 15",
    platform: "ios",
    deviceId: "11111111-1111-4111-8111-111111111111",
    osVersion: "17.2",
    iosVersion: "17.2",
    formFactor: "phone",
  };
  const pixel: BootedDevice = {
    name: "Pixel_7_API_34",
    platform: "android",
    deviceId: "emulator-5554",
    osVersion: "14",
    apiLevel: 34,
    formFactor: "phone",
  };

  test("iOS: a UDID plus the name that simulator carries binds it, in any letter case", async () => {
    await arrange(iphone, { ...iphone, isRunning: true });
    const { deviceId } = iphone;
    const client = { __mcpSessionId: "client-a" };

    expect(await startOutcome({ platform: "ios", deviceId, name: "iPhone 15", ...client })).toBe(
      "bound iPhone 15",
    );
    expect(await startOutcome({ platform: "ios", deviceId, name: "iphone", ...client })).toBe(
      "bound iPhone 15",
    );
  });

  test("iOS: a stopped simulator's UDID plus a name it does not carry is refused unbooted", async () => {
    await arrange(iphone, { ...iphone, isRunning: false }, []);

    const outcome = await startOutcome({
      platform: "ios",
      deviceId: iphone.deviceId,
      name: "iPad Pro",
    });

    expect(outcome).toContain("does not satisfy the requested constraints");
    expect(bootOperations()).toEqual([]);
  });

  test("Android: a serial plus the AVD name that emulator runs binds it", async () => {
    await arrange(pixel, { ...pixel, isRunning: true });

    const outcome = await startOutcome({
      platform: "android",
      deviceId: pixel.deviceId,
      name: "Pixel_7_API_34",
    });

    expect(outcome).toBe("bound Pixel_7_API_34");
    expect(pool.getDevice(pixel.deviceId)?.sessionId).not.toBeNull();
  });

  test("Android: a serial plus its exact avdName still binds (an identity pair, not a spec)", async () => {
    await arrange(pixel, { ...pixel, isRunning: true });

    const outcome = await startOutcome({
      platform: "android",
      deviceId: pixel.deviceId,
      avdName: "Pixel_7_API_34",
    });

    expect(outcome).toBe("bound Pixel_7_API_34");
  });

  test("Android: a name cannot be judged against an emulator whose AVD name is unread", async () => {
    const unread = { ...pixel, name: `Unknown (${pixel.deviceId})` };
    await arrange(unread, { ...pixel, isRunning: true });

    const outcome = await startOutcome({
      platform: "android",
      deviceId: pixel.deviceId,
      name: "Pixel_7_API_34",
    });

    expect(outcome).toContain("refused: target_identity_unresolved");
    expect(pool.getDevice(pixel.deviceId)?.sessionId).toBeNull();
  });
});

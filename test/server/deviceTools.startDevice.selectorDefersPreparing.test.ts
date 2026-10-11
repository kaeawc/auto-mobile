import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { setDeviceManager } from "../../src/server/bootedDeviceResources";
import { clearDirectSessionDevices } from "../../src/server/directSessionDeviceRegistry";
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
 * #11648 makes a selector startDevice prefer an idle match over a device another session holds. A
 * start that has selected a device and is still preparing it (readiness reservation taken, session
 * not bound yet) has no session on it yet, so the preference also has to read the reservation
 * (#11651): otherwise a second selector start arriving in that window picks the same device, loses
 * the bind and is refused `device_owned_by_other_session` with another idle device satisfying the
 * spec right beside it. With no other match the second start still gets that typed refusal.
 */
describe("two selector starts racing while the first is still preparing its device", () => {
  const env: Record<string, string | undefined> = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
  let restoreEnv: (() => void) | undefined;
  let sessionManager: SessionManager | undefined;

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

  async function arrange(devices: BootedDevice[], images: DeviceInfo[]) {
    const platform = devices[0].platform;
    restoreEnv = ToolRegistry.setPipelineOverridesForTesting({ env });
    const deviceUtils = new FakeDeviceUtils();
    const timer = new FakeTimer();
    deviceUtils.setBootedDevices(platform, devices);
    deviceUtils.setDeviceImages(platform, images);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session", {
        env,
        timer,
        deviceManager: deviceUtils,
      }),
    );
    await pool.initializeWithDevices(devices);
    DaemonState.getInstance().initialize(sessionManager, pool);
    const readinessDeviceIds: string[] = [];
    let releaseFirstReadiness: () => void = () => {};
    const firstReadinessGate = new Promise<void>((resolve) => {
      releaseFirstReadiness = resolve;
    });
    let firstReadinessEntered: () => void = () => {};
    const firstReadinessStarted = new Promise<void>((resolve) => {
      firstReadinessEntered = resolve;
    });
    setDeviceToolsDependencies({
      env,
      timer,
      deviceManagerFactory: () => deviceUtils,
      deviceMatcherFactory: () => new DefaultDeviceMatcher(),
      idGenerator: new CountingIdGenerator("session"),
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async (request) => {
        readinessDeviceIds.push(request.device.deviceId);
        if (readinessDeviceIds.length === 1) {
          firstReadinessEntered();
          await firstReadinessGate;
        }
      },
    });
    setDeviceManager(deviceUtils);
    registerDeviceTools();
    return { pool, readinessDeviceIds, releaseFirstReadiness, firstReadinessStarted };
  }

  // The file's first start pays the one-off module and JIT cost of the whole startDevice path,
  // which is not part of any scenario: pay it here on a throwaway pool. Every test still
  // arranges and runs its own race in full.
  beforeAll(async () => {
    const warm: BootedDevice = { name: "warm-up", platform: "android", deviceId: "emulator-5590" };
    const { releaseFirstReadiness } = await arrange(
      [warm],
      [{ name: warm.name, platform: "android", deviceId: warm.deviceId, isRunning: true }],
    );
    releaseFirstReadiness();
    await startDevice({ platform: "android", __mcpSessionId: "warm-up" });
    cleanup();
  });

  async function startDevice(args: Record<string, unknown>): Promise<any> {
    const result = await ToolRegistry.getTool("startDevice")!.handler(args);
    return JSON.parse(result.content[0].text);
  }

  async function race(devices: BootedDevice[], images: DeviceInfo[]) {
    const platform = devices[0].platform;
    const { pool, readinessDeviceIds, releaseFirstReadiness, firstReadinessStarted } =
      await arrange(devices, images);

    const first = startDevice({ platform, __mcpSessionId: "client-a" });
    await firstReadinessStarted;
    // The first start has chosen its device and is preparing it; nothing is bound yet.
    const firstDeviceId = readinessDeviceIds[0];
    expect(pool.getDevice(firstDeviceId)?.sessionId).toBeNull();

    const second = startDevice({ platform, __mcpSessionId: "client-b" }).catch(
      (error: unknown) => ({ refused: (error as { code?: string }).code ?? String(error) }),
    );
    // Let the second start run as far as it can before the first one finishes.
    for (let turn = 0; turn < 200; turn++) {
      await Promise.resolve();
    }
    releaseFirstReadiness();
    const [winner, loser] = await Promise.all([first, second]);
    return { pool, readinessDeviceIds, firstDeviceId, winner, loser };
  }

  test("Android: the second start takes the other idle emulator", async () => {
    const one: BootedDevice = {
      name: "Pixel_7_API_34",
      platform: "android",
      deviceId: "emulator-5554",
      osVersion: "14",
      apiLevel: 34,
      formFactor: "phone",
    };
    const two: BootedDevice = { ...one, name: "Pixel_8_API_34", deviceId: "emulator-5556" };
    const image = (device: BootedDevice): DeviceInfo => ({
      name: device.name,
      platform: "android",
      deviceId: device.deviceId,
      isRunning: true,
      osVersion: "14",
      apiLevel: 34,
      formFactor: "phone",
    });
    const { pool, readinessDeviceIds, firstDeviceId, winner, loser } = await race(
      [one, two],
      [image(one), image(two)],
    );
    const otherDeviceId = firstDeviceId === one.deviceId ? two.deviceId : one.deviceId;

    expect(pool.getDevice(firstDeviceId)?.sessionId).toBe(winner.runtime.session.sessionUuid);
    expect(loser.refused).toBeUndefined();
    expect(pool.getDevice(otherDeviceId)?.sessionId).toBe(loser.runtime.session.sessionUuid);
    // The device the first start was preparing is never prepared by the second one.
    expect(readinessDeviceIds).toEqual([firstDeviceId, otherDeviceId]);
  });

  test("iOS: the second start takes the other idle simulator", async () => {
    const one: BootedDevice = {
      name: "iPhone 15",
      platform: "ios",
      deviceId: "11111111-1111-4111-8111-111111111111",
      osVersion: "17.2",
      iosVersion: "17.2",
      formFactor: "phone",
    };
    const two: BootedDevice = { ...one, deviceId: "22222222-2222-4222-8222-222222222222" };
    const image = (device: BootedDevice): DeviceInfo => ({
      name: device.name,
      platform: "ios",
      deviceId: device.deviceId,
      isRunning: true,
      osVersion: "17.2",
      formFactor: "phone",
    });
    const { pool, readinessDeviceIds, firstDeviceId, winner, loser } = await race(
      [one, two],
      [image(one), image(two)],
    );
    const otherDeviceId = firstDeviceId === one.deviceId ? two.deviceId : one.deviceId;

    expect(pool.getDevice(firstDeviceId)?.sessionId).toBe(winner.runtime.session.sessionUuid);
    expect(loser.refused).toBeUndefined();
    expect(pool.getDevice(otherDeviceId)?.sessionId).toBe(loser.runtime.session.sessionUuid);
    expect(readinessDeviceIds).toEqual([firstDeviceId, otherDeviceId]);
  });

  test("the device being prepared is the only match: the second start is refused, typed", async () => {
    const only: BootedDevice = {
      name: "iPhone 15",
      platform: "ios",
      deviceId: "11111111-1111-4111-8111-111111111111",
      osVersion: "17.2",
      iosVersion: "17.2",
      formFactor: "phone",
    };
    const { pool, firstDeviceId, winner, loser } = await race(
      [only],
      [{ ...only, isRunning: true }],
    );

    expect(pool.getDevice(firstDeviceId)?.sessionId).toBe(winner.runtime.session.sessionUuid);
    expect(loser.refused).toBe("device_owned_by_other_session");
  });
});

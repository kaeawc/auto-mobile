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
 * #11648: a selector-based startDevice (no avdName/deviceId) chose among ALL booted devices that
 * satisfy the spec, including ones another session holds, and was refused
 * `device_owned_by_other_session` for a held pick while an idle match was booted next to it. A
 * device another session holds is now taken only when no other booted device satisfies the spec.
 */
describe("selector startDevice among held and idle matching devices", () => {
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
      },
    });
    setDeviceManager(deviceUtils);
    registerDeviceTools();
    return { pool, readinessDeviceIds };
  }

  async function startDevice(args: Record<string, unknown>): Promise<any> {
    const result = await ToolRegistry.getTool("startDevice")!.handler(args);
    return toolJson(result);
  }

  const android = (serial: string, name: string): BootedDevice => ({
    name,
    platform: "android",
    deviceId: serial,
    osVersion: "14",
    apiLevel: 34,
    formFactor: "phone",
  });
  const androidImage = (device: BootedDevice): DeviceInfo => ({
    name: device.name,
    platform: "android",
    deviceId: device.deviceId,
    isRunning: true,
    osVersion: "14",
    apiLevel: 34,
    formFactor: "phone",
  });

  test("Android: the second session gets the idle emulator, not a refusal for the held one", async () => {
    const held = android("emulator-5554", "Pixel_7_API_34");
    const idle = android("emulator-5556", "Pixel_8_API_34");
    const { pool, readinessDeviceIds } = await arrange(
      [held, idle],
      [androidImage(held), androidImage(idle)],
    );

    const first = await startDevice({ platform: "android", __mcpSessionId: "client-a" });
    expect(first.runtime.session.sessionUuid).toBe("session-1");
    const firstDeviceId =
      pool.getDevice(held.deviceId)?.sessionId === "session-1" ? held.deviceId : idle.deviceId;
    expect(pool.getDevice(firstDeviceId)?.sessionId).toBe("session-1");
    const otherDeviceId = firstDeviceId === held.deviceId ? idle.deviceId : held.deviceId;
    expect(pool.getDevice(otherDeviceId)?.sessionId).toBeNull();

    // Same omitted-fields-mean-any spec from another client: one matching device is idle.
    const second = await startDevice({ platform: "android", __mcpSessionId: "client-b" }).catch(
      (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
    );

    expect(second.refused).toBeUndefined();
    expect(pool.getDevice(otherDeviceId)?.sessionId).toBe(second.runtime.session.sessionUuid);
    expect(pool.getDevice(firstDeviceId)?.sessionId).toBe("session-1");
    expect(readinessDeviceIds).toEqual([firstDeviceId, otherDeviceId]);
  });

  test("iOS: the second session gets the idle simulator, not a refusal for the held one", async () => {
    const simulator = (deviceId: string): BootedDevice => ({
      name: "iPhone 15",
      platform: "ios",
      deviceId,
      osVersion: "17.2",
      iosVersion: "17.2",
      formFactor: "phone",
    });
    const held = simulator("11111111-1111-4111-8111-111111111111");
    const idle = simulator("22222222-2222-4222-8222-222222222222");
    const image = (device: BootedDevice): DeviceInfo => ({
      name: device.name,
      platform: "ios",
      deviceId: device.deviceId,
      isRunning: true,
      osVersion: "17.2",
      formFactor: "phone",
    });
    const { pool } = await arrange([held, idle], [image(held), image(idle)]);

    const first = await startDevice({ platform: "ios", __mcpSessionId: "client-a" });
    const firstSession = first.runtime.session.sessionUuid;
    const firstDeviceId =
      pool.getDevice(held.deviceId)?.sessionId === firstSession ? held.deviceId : idle.deviceId;
    const otherDeviceId = firstDeviceId === held.deviceId ? idle.deviceId : held.deviceId;
    expect(pool.getDevice(otherDeviceId)?.sessionId).toBeNull();

    const second = await startDevice({ platform: "ios", __mcpSessionId: "client-b" }).catch(
      (error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
    );

    expect(second.refused).toBeUndefined();
    expect(pool.getDevice(otherDeviceId)?.sessionId).toBe(second.runtime.session.sessionUuid);
    expect(pool.getDevice(firstDeviceId)?.sessionId).toBe(firstSession);
  });

  const heldSessions = (pool: DevicePool) =>
    pool
      .getAllDevices()
      .map((device) => `${device.id}=${device.sessionId}`)
      .toSorted();

  test("a holder's repeat start reuses its own device, wherever it sits in discovery order", async () => {
    const first = android("emulator-5554", "Pixel_7_API_34");
    const second = android("emulator-5556", "Pixel_8_API_34");
    const { pool } = await arrange([first, second], [androidImage(first), androidImage(second)]);
    await startDevice({ platform: "android", __mcpSessionId: "client-a" });
    await startDevice({ platform: "android", __mcpSessionId: "client-b" });
    const bound = heldSessions(pool);
    expect(bound.map((entry) => entry.split("=")[1]).toSorted()).toEqual([
      "session-1",
      "session-2",
    ]);

    const againB = await startDevice({ platform: "android", __mcpSessionId: "client-b" });
    const againA = await startDevice({ platform: "android", __mcpSessionId: "client-a" });

    expect(againB.runtime.session.sessionUuid).toBe("session-2");
    expect(againA.runtime.session.sessionUuid).toBe("session-1");
    expect(heldSessions(pool)).toEqual(bound);
  });

  test("when every matching device is held by others, the ownership refusal is unchanged", async () => {
    const first = android("emulator-5554", "Pixel_7_API_34");
    const second = android("emulator-5556", "Pixel_8_API_34");
    const { pool, readinessDeviceIds } = await arrange(
      [first, second],
      [androidImage(first), androidImage(second)],
    );
    await startDevice({ platform: "android", __mcpSessionId: "client-a" });
    await startDevice({ platform: "android", __mcpSessionId: "client-b" });
    const bound = heldSessions(pool);
    const prepared = readinessDeviceIds.length;

    const refusal = await startDevice({ platform: "android", __mcpSessionId: "client-c" }).catch(
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    expect(refusal).toContain("is already assigned to another session");
    expect(readinessDeviceIds).toHaveLength(prepared);
    expect(heldSessions(pool)).toEqual(bound);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  type InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * `setActiveDevice {deviceId}` without `platform` fell back to the connection's default session and
 * rebound it across platforms (#11167): an iOS session was flipped onto an Android emulator and
 * its iPhone released.
 */
describe("setActiveDevice never rebinds a session across platforms (#11167)", () => {
  const android: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
  const android2: BootedDevice = {
    name: "Pixel 2",
    deviceId: "emulator-5556",
    platform: "android",
  };
  const android3: BootedDevice = {
    name: "Pixel 3",
    deviceId: "emulator-5558",
    platform: "android",
  };
  const iphone: BootedDevice = { name: "iPhone", deviceId: "ios-udid-1", platform: "ios" };
  const CONNECTION = "conn-1";

  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let spies: Array<ReturnType<typeof spyOn>>;
  let savedAutolock: string | undefined;

  const setup = async (devices: BootedDevice[]) => {
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices(
      "android",
      devices.filter((d) => d.platform === "android"),
    );
    discovery.setBootedDevices(
      "ios",
      devices.filter((d) => d.platform === "ios"),
    );
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "cross-platform-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices(devices);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath(devices).install();
  };

  beforeEach(() => {
    savedAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
  });

  afterEach(() => {
    tools.uninstall();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (savedAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = savedAutolock;
    }
  });

  test("an iOS default session is not rebound to a free Android emulator", async () => {
    await setup([android, iphone]);
    const ios = (await pool.autolockDevice(iphone.deviceId, "ios", CONNECTION))!;

    await tools.call("setActiveDevice", { deviceId: android.deviceId, __mcpSessionId: CONNECTION });

    const session = manager.getSession(ios)!;
    expect(session.platform).toBe("ios");
    expect(session.assignedDevice).toBe(iphone.deviceId);
    expect(pool.getDevice(iphone.deviceId)?.sessionId).toBe(ios);
  });

  test("an Android-only connection is not rebound to a free iPhone", async () => {
    await setup([android, iphone]);
    const droid = (await pool.autolockDevice(android.deviceId, "android", CONNECTION))!;

    await tools.call("setActiveDevice", { deviceId: iphone.deviceId, __mcpSessionId: CONNECTION });

    const session = manager.getSession(droid)!;
    expect(session.platform).toBe("android");
    expect(session.assignedDevice).toBe(android.deviceId);
  });

  test("the session of the device's platform is rebound; several of it require explicit selection", async () => {
    await setup([android, android2, android3, iphone]);
    const ios = (await pool.autolockDevice(iphone.deviceId, "ios", CONNECTION))!;
    await pool.autolockDevice(android.deviceId, "android", CONNECTION);
    try {
      await tools.call("setActiveDevice", {
        deviceId: iphone.deviceId,
        __mcpSessionId: CONNECTION,
      });
    } catch (e) {
      console.log("DBG", (e as Error).stack);
    }
    expect(manager.getSession(ios)!.assignedDevice).toBe(iphone.deviceId);

    await pool.autolockDevice(android2.deviceId, "android", CONNECTION);
    await expect(
      tools.call("setActiveDevice", { deviceId: android3.deviceId, __mcpSessionId: CONNECTION }),
    ).rejects.toThrow(/unambiguously/);
  });

  test("an explicit sessionUuid of another platform is refused with a typed error", async () => {
    await setup([android, iphone]);
    const ios = (await pool.autolockDevice(iphone.deviceId, "ios", CONNECTION))!;

    await expect(
      tools.call("setActiveDevice", {
        deviceId: android.deviceId,
        sessionUuid: ios,
        __mcpSessionId: CONNECTION,
      }),
    ).rejects.toThrow(/cannot be rebound/);
    expect(manager.getSession(ios)!.platform).toBe("ios");
  });

  test("naming an autolock session another connection owns is refused, typed (#11167)", async () => {
    await setup([android, android2]);
    const owned = (await pool.autolockDevice(android.deviceId, "android", CONNECTION))!;

    const error = await tools
      .call("setActiveDevice", {
        deviceId: android2.deviceId,
        sessionUuid: owned,
        __mcpSessionId: "conn-2",
      })
      .then(
        () => undefined,
        (e: unknown) => e as InputDeviceOwnedError,
      );

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(manager.getSession(owned)!.assignedDevice).toBe(android.deviceId);
    expect(pool.resolveAutolockSessionForMcpSession("conn-2")).toBeUndefined();
  });

  test("the owner may name its own autolock session", async () => {
    await setup([android, android2]);
    const owned = (await pool.autolockDevice(android.deviceId, "android", CONNECTION))!;

    await tools.call("setActiveDevice", {
      deviceId: android2.deviceId,
      sessionUuid: owned,
      __mcpSessionId: CONNECTION,
    });

    expect(manager.getSession(owned)!.assignedDevice).toBe(android2.deviceId);
  });
});

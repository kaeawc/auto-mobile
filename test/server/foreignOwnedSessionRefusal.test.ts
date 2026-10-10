import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  type InputDeviceOwnedError,
} from "../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";
import { refuseControlOnForeignOwnedSession } from "../../src/server/foreignOwnedSessionRefusal";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * #11344: a session belongs to the connection that acquired it. With autolock off (the default)
 * another connection that named the session could drive it, and `setActiveDevice` naming it could
 * move it to another device and adopt it. Both are refused, typed, before anything changes.
 */
describe("a session another connection owns is not controlled by naming it (#11344)", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const SESSION = "sess-a";
  const OWNER = "conn-1";
  const OTHER = "conn-2";

  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let spies: Array<ReturnType<typeof spyOn>>;
  let previousAutolock: string | undefined;

  const refusal = (run: () => unknown) =>
    Promise.resolve()
      .then(run)
      .then(
        () => undefined,
        (error: unknown) => error as InputDeviceOwnedError,
      );

  beforeEach(async () => {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "foreign-session-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([held, free]).install();
    await pool.bindOrReuseDeviceSession(
      SESSION,
      held.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      OWNER,
    );
  });

  afterEach(() => {
    tools.uninstall();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  });

  describe("the pool's ownership predicate", () => {
    test("the session is foreign to every connection but the one that acquired it", () => {
      expect(pool.isSessionOwnedByOtherConnection(SESSION, OTHER)).toBe(true);
      expect(pool.isSessionOwnedByOtherConnection(SESSION, OWNER)).toBe(false);
    });

    test("a session nobody holds, or whose owner disconnected, is foreign to no one", () => {
      expect(pool.isSessionOwnedByOtherConnection("never-issued", OTHER)).toBe(false);

      pool.releaseMcpSessionBindings(OWNER);

      expect(pool.isSessionOwnedByOtherConnection(SESSION, OTHER)).toBe(false);
    });

    test("a caller with no connection identity is not treated as a stranger to an ordinary session", () => {
      expect(pool.isSessionOwnedByOtherConnection(SESSION, undefined)).toBe(false);
    });
  });

  describe("a control call", () => {
    test("from another connection is refused with the typed code and the session's device", async () => {
      const error = await refusal(() =>
        refuseControlOnForeignOwnedSession("tapOn", SESSION, OTHER),
      );

      expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(error?.toPayload()).toEqual({
        code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
        deviceId: held.deviceId,
        retryable: false,
      });
      expect(error?.message).toContain(`session ${SESSION} is owned by another connected client`);
    });

    test("from the owner, from a caller with no identity, or naming no session is admitted", () => {
      expect(() => refuseControlOnForeignOwnedSession("tapOn", SESSION, OWNER)).not.toThrow();
      expect(() => refuseControlOnForeignOwnedSession("tapOn", SESSION, undefined)).not.toThrow();
      expect(() => refuseControlOnForeignOwnedSession("tapOn", undefined, OTHER)).not.toThrow();
    });

    test("is admitted once the owner has disconnected", () => {
      pool.releaseMcpSessionBindings(OWNER);

      expect(() => refuseControlOnForeignOwnedSession("tapOn", SESSION, OTHER)).not.toThrow();
    });
  });

  describe("setActiveDevice with autolock off", () => {
    test("naming the session on its own device is refused", async () => {
      const error = await refusal(() =>
        tools.call("setActiveDevice", {
          deviceId: held.deviceId,
          sessionUuid: SESSION,
          __mcpSessionId: OTHER,
        }),
      );

      expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(pool.isSessionOwnedByOtherConnection(SESSION, OTHER)).toBe(true);
    });

    test("naming the session with another device is refused and moves nothing", async () => {
      const error = await refusal(() =>
        tools.call("setActiveDevice", {
          deviceId: free.deviceId,
          sessionUuid: SESSION,
          __mcpSessionId: OTHER,
        }),
      );

      expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect(manager.getSession(SESSION)?.assignedDevice).toBe(held.deviceId);
      expect(pool.getDevice(held.deviceId)?.sessionId).toBe(SESSION);
      expect(pool.getDevice(free.deviceId)?.sessionId ?? null).toBeNull();
      expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(0);
    });

    test("the owner still selects with its own session", async () => {
      const result = await tools.call("setActiveDevice", {
        deviceId: held.deviceId,
        sessionUuid: SESSION,
        __mcpSessionId: OWNER,
      });

      expect(JSON.stringify(result)).toContain(SESSION);
    });
  });
});

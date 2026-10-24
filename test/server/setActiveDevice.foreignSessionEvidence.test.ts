import { describe, expect, spyOn } from "bun:test";
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
import { warmedTests } from "../helpers/warmedTests";

/**
 * A control call that names a session another connected client owns is refused with
 * `device_owned_by_other_session`, and the refusal's wire evidence is "the held device"
 * (`InputDeviceOwnedError.toPayload`): the device the named session holds. Every tool gets that
 * from `refuseControlOnForeignOwnedSession`, and `setActiveDevice`, which refuses in its own
 * handler, calls it too (#11647): a refusal about session S never names the free device the caller
 * asked for as held, so a client that reads `deviceId` to learn what is taken does not skip a
 * device nobody holds.
 */
describe("setActiveDevice naming a session another connection owns", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const SESSION = "sess-a";
  const OWNER = "conn-1";
  const OTHER = "conn-2";

  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath | undefined;
  let spies: Array<ReturnType<typeof spyOn>> = [];
  let previousAutolock: string | undefined;

  const refusal = (run: () => unknown) =>
    Promise.resolve()
      .then(run)
      .then(
        () => undefined,
        (error: unknown) => error as InputDeviceOwnedError,
      );

  async function arrangeHarness(): Promise<void> {
    previousAutolock = process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    const timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => {
        return new FakeDbWriteBarrier();
      },
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "set-active-foreign-evidence-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    tools = new RealToolCallPath([held, free]).install();
    await pool.bindOrReuseDeviceSession({
      sessionId: SESSION,
      deviceId: held.deviceId,
      platform: "android",
      allowSessionRebind: false,
      mcpSessionId: OWNER,
    });
  }

  function teardownHarness(): void {
    if (!tools) {
      return;
    }
    tools.uninstall();
    tools = undefined;
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
    spies = [];
    if (previousAutolock === undefined) {
      delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    } else {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = previousAutolock;
    }
  }

  // First-use costs (module graph, the setActiveDevice handler, the refusal) are paid in beforeAll.
  // The DevicePool harness is still built inside each test, so its cost is paid in the test body.
  const test = warmedTests(teardownHarness);
  function arranged(name: string, fn: () => void | Promise<void>, timeout?: number): void {
    test(
      name,
      async () => {
        await arrangeHarness();
        await fn();
      },
      timeout,
    );
  }

  arranged("the refusal carries the same evidence every other tool's refusal carries", async () => {
    const reference = await refusal(() =>
      refuseControlOnForeignOwnedSession("killDevice", SESSION, OTHER),
    );
    expect(reference?.toPayload()).toEqual({
      code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      deviceId: held.deviceId,
      retryable: false,
    });

    const error = await refusal(() =>
      tools!.call("setActiveDevice", {
        deviceId: free.deviceId,
        sessionUuid: SESSION,
        __mcpSessionId: OTHER,
      }),
    );

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    // The free device is held by nobody, before and after the refused call.
    expect(pool.getDevice(free.deviceId)?.sessionId ?? null).toBeNull();
    expect(manager.getSessionForDevice(free.deviceId)).toBeNull();
    expect(error?.message).not.toContain(`Device '${free.deviceId}' is already assigned`);
    expect(error?.toPayload()).toEqual(reference?.toPayload());
  });

  arranged(
    "a caller with no connection identity cannot move a live autolock session (#11235)",
    async () => {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      await pool.releaseDevice(held.deviceId, SESSION);
      const autolocked = await pool.autolockDevice(held.deviceId, "android", OWNER);
      expect(autolocked).toBeDefined();

      const error = await refusal(() =>
        tools!.call("setActiveDevice", { deviceId: free.deviceId, sessionUuid: autolocked }),
      );

      expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      // The evidence is the device the session holds; the free target stays free.
      expect(error?.toPayload()).toMatchObject({ deviceId: held.deviceId });
      expect(manager.getSessionForDevice(held.deviceId)).toBe(autolocked!);
      expect(manager.getSessionForDevice(free.deviceId)).toBeNull();
    },
  );
});

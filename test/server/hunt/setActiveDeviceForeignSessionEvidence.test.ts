import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../../src/daemon/daemonState";
import { DevicePool } from "../../../src/daemon/devicePool";
import { DeviceSessionRegistry } from "../../../src/daemon/deviceSessionRegistry";
import {
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  type InputDeviceOwnedError,
} from "../../../src/daemon/inputDeviceOwnership";
import { SessionManager } from "../../../src/daemon/sessionManager";
import type { BootedDevice } from "../../../src/models";
import { refuseControlOnForeignOwnedSession } from "../../../src/server/foreignOwnedSessionRefusal";
import { logger } from "../../../src/utils/logger";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../../helpers/realToolCallPath";

/**
 * A control call that names a session another connected client owns is refused with
 * `device_owned_by_other_session`, and the refusal's wire evidence is "the held device"
 * (`InputDeviceOwnedError.toPayload`): the device the named session holds. Every tool gets that
 * from `refuseControlOnForeignOwnedSession`. `setActiveDevice` refuses the same request in its own
 * handler and fills the evidence with the device the caller ASKED for, so a refusal about
 * session S comes back naming a free device as held and saying it "is already assigned to
 * session S". A client that reads `deviceId` (or the message) to learn what is taken skips a
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
      createDevicePoolDependencies(manager, "set-active-foreign-evidence-daemon", {
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

  test("the refusal carries the same evidence every other tool's refusal carries", async () => {
    const reference = await refusal(() =>
      refuseControlOnForeignOwnedSession("killDevice", SESSION, OTHER),
    );
    expect(reference?.toPayload()).toEqual({
      code: DEVICE_OWNED_BY_OTHER_SESSION_CODE,
      deviceId: held.deviceId,
      retryable: false,
    });

    const error = await refusal(() =>
      tools.call("setActiveDevice", {
        deviceId: free.deviceId,
        sessionUuid: SESSION,
        __mcpSessionId: OTHER,
      }),
    );

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    // The free device is held by nobody, before and after the refused call.
    expect(pool.getDevice(free.deviceId)?.sessionId ?? null).toBeNull();
    expect(manager.getSessionForDevice(free.deviceId)).toBeNull();
    // Actual: deviceId 'emulator-5556' and "Device 'emulator-5556' is already assigned to
    // session sess-a".
    expect(error?.message).not.toContain(`Device '${free.deviceId}' is already assigned`);
    expect(error?.toPayload()).toEqual(reference?.toPayload());
  });
});

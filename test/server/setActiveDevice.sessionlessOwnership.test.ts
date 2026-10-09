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
import { executionTracker } from "../../src/server/executionTracker";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { RealToolCallPath } from "../helpers/realToolCallPath";

/**
 * A sessionless `setActiveDevice` (e.g. `--cli setActiveDevice --device-id ...`) readied and
 * globally pinned a device another session held (#11071): CtrlProxy setup, appearance and settings
 * writes ran on the holder's device. It is refused before readiness, and a selection admitted on a
 * free device is cancelled when a session acquires that device mid-call.
 */
describe("sessionless setActiveDevice respects device ownership (#11071)", () => {
  const held: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const free: BootedDevice = { name: "Pixel B", deviceId: "emulator-5556", platform: "android" };
  const HOLDER = "holder-session";
  const HOLDER_CONNECTION = "holder-connection";

  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let tools: RealToolCallPath;
  let spies: Array<ReturnType<typeof spyOn>>;

  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error as InputDeviceOwnedError,
    );

  beforeEach(async () => {
    spies = [
      spyOn(logger, "info").mockImplementation(() => {}),
      spyOn(logger, "warn").mockImplementation(() => {}),
      spyOn(logger, "error").mockImplementation(() => {}),
    ];
    timer = new FakeTimer();
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), () => {
      return new FakeDbWriteBarrier();
    });
    manager.stopCleanupTimer();
    const discovery = new FakeDeviceUtils();
    discovery.setBootedDevices("android", [held, free]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "sessionless-select-daemon", {
        timer,
        deviceManager: discovery,
      }),
    );
    await pool.initializeWithDevices([held, free]);
    DaemonState.getInstance().initialize(manager, pool, new DeviceSessionRegistry(timer));
    // Production wiring (daemon.ts): acquiring a device cancels sessionless work on it (#10829).
    manager.setDeviceAcquisitionExecutionCanceller((deviceId) => {
      executionTracker.cancelSessionlessDeviceUse(deviceId);
    });
    tools = new RealToolCallPath([held, free]).install();
    await pool.bindOrReuseDeviceSession(
      HOLDER,
      held.deviceId,
      "android",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      HOLDER_CONNECTION,
    );
  });

  afterEach(() => {
    tools.uninstall();
    DaemonState.getInstance().reset();
    manager.stopCleanupTimer();
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  test("a device a live session holds is refused, typed, before readiness", async () => {
    const error = await refusal(tools.call("setActiveDevice", { deviceId: held.deviceId }));

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(error?.message).toContain(`already assigned to session ${HOLDER}`);
    expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(0);
    expect(tools.deviceSessionManager.getExplicitDevicePin()).toBeUndefined();
  });

  test("a device an autolock owner holds is refused, typed, before readiness", async () => {
    pool.getDevice(free.deviceId)!.autolockSessionId = "autolock-owner";

    const error = await refusal(tools.call("setActiveDevice", { deviceId: free.deviceId }));

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(tools.deviceSessionManager.getEnsureDeviceReadyCalls()).toBe(0);
    expect(tools.deviceSessionManager.getExplicitDevicePin()).toBeUndefined();
  });

  test("the holder's own connection selects its device as its session (#10994)", async () => {
    const result = await tools.call("setActiveDevice", {
      deviceId: held.deviceId,
      __mcpSessionId: HOLDER_CONNECTION,
    });

    expect(JSON.stringify(result)).toContain(HOLDER);
    expect(tools.deviceSessionManager.getExplicitDevicePin()).toBeUndefined();
  });

  test("a free device is still selected and pinned", async () => {
    await tools.call("setActiveDevice", { deviceId: free.deviceId });

    expect(tools.deviceSessionManager.getExplicitDevicePin()?.deviceId).toBe(free.deviceId);
  });

  test("a session acquiring the device during readiness cancels the selection before the pin", async () => {
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    tools.deviceSessionManager.setEnsureDeviceReadyHook(async () => {
      entered.resolve();
      await release.promise;
    });
    const outcome = refusal(tools.call("setActiveDevice", { deviceId: free.deviceId }));
    await entered.promise;

    await manager.createSession("late-holder", free.deviceId, "android");
    release.resolve();
    const error = await outcome;

    expect(error?.code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
    expect(tools.deviceSessionManager.getExplicitDevicePin()).toBeUndefined();
  });
});

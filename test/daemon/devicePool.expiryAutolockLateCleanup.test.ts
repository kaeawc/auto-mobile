/**
 * H13 reproduction: an EXPIRY-origin release whose device quarantine is extended
 * after the pool's release listener ran returns the device to idle, but leaves
 * `autolockSessionId` naming the dead session for good.
 *
 * Mechanism (all production code below runs for real):
 * - `DevicePool.releaseExpiredSessionDevice` (src/daemon/devicePool.ts:7218-7254)
 *   reads `getPendingDeviceCleanup(deviceId)` ONCE. It attaches a single
 *   `cleanup.then(() => clearExpiredAutolockStateWhenIdle(...))`.
 * - `clearExpiredAutolockStateWhenIdle` (src/daemon/deviceAutolockManager.ts:674-689)
 *   gives up when the device is still busy.
 * - `releaseCapturedDevice` (src/daemon/devicePool.ts:5786-5826) re-defers on the
 *   NEWER chained cleanup (`trackPendingDeviceCleanup`, src/daemon/sessionManager.ts:4908-4918).
 *   So the device is still busy when the one-shot clear runs, and its later idle
 *   transition never touches `autolockSessionId`.
 * - The non-expiry branch clears autolock eagerly at notify
 *   (src/daemon/devicePool.ts:1323-1330 -> clearReleasedAutolockState).
 *
 * The late, chained cleanup here comes from production code, not a hand call.
 * `SessionManager.trackRotationSessionSetup` (src/daemon/sessionManager.ts:5218-5245)
 * publishes the rotation restore as pending device cleanup from the setup's
 * `finally`. That happens once the setup outlives the bounded release drain.
 * The setup is started by the real rotate tool handler (`rotateHandler`) through
 * `runSessionRotationMutation`.
 *
 * Faked: FakeTimer, FakeDeviceSessionPersistence, FakeDbWriteBarrier, FakeDeviceUtils
 * (discovery), the Rotate adb work (injected with `setRotateFactory`; the fake
 * calls the real `options.sessionRotation`), and the rotation restorer (SessionManager's
 * restorer-factory seam). The SessionManager's active-execution checker is left at
 * its constructor default (`() => false`) in tests 1 and 2. The daemon installs the
 * real one (daemon.ts:711-713, 2511-2524), and test 3 shows that it blocks this
 * particular trigger.
 */
import { afterEach, expect, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import type {
  RotateOptions,
  RotationRestoreSlot,
  RotationRestoreState,
} from "../../src/features/action/Rotate";
import type { RotateResult } from "../../src/models/RotateResult";
import { ExecutionTracker } from "../../src/server/executionTracker";
import {
  resetRotateFactory,
  rotateHandler,
  setRotateFactory,
} from "../../src/server/interactionTools";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { drainUntil, drainUntilQuiescent } from "../helpers/fakeTimerStepping";

// SessionManager.CLEANUP_INTERVAL_MS (sessionManager.ts:1150): the real sweep timer fires the expiry.
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// SESSION_SETUP_DRAIN_TIMEOUT_MS (sessionManager.ts:752): release stops waiting for setup after this.
const SESSION_SETUP_DRAIN_TIMEOUT_MS = 1_000;
const HOUR_MS = 60 * 60 * 1000;
const DEVICE = { deviceId: "emulator-5554", name: "Pixel", platform: "android" as const };
const PRIOR_ROTATION: RotationRestoreState = { accelerometerRotation: 1, userRotation: 0 };
const AUTOLOCK_ENV = "AUTOMOBILE_DEVICE_POOL_AUTOLOCK";
const previousAutolockEnv = process.env[AUTOLOCK_ENV];

afterEach(() => {
  resetRotateFactory();
  DaemonState.getInstance().reset();
  if (previousAutolockEnv === undefined) {
    delete process.env[AUTOLOCK_ENV];
  } else {
    process.env[AUTOLOCK_ENV] = previousAutolockEnv;
  }
});

async function setupDaemonPool() {
  process.env[AUTOLOCK_ENV] = "1";
  const timer = new FakeTimer();
  const restoredRotations: RotationRestoreState[] = [];
  const manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
    undefined,
    undefined,
    {
      networkCondition: () => ({
        restore: async () => {
          throw new Error("no network-condition restore expected");
        },
      }),
      clock: () => ({
        restore: async () => {
          throw new Error("no clock restore expected");
        },
      }),
      rotation: () => ({
        restore: async (state) => {
          restoredRotations.push(state);
        },
      }),
    },
  );
  const utils = new FakeDeviceUtils();
  utils.setBootedDevices("android", [DEVICE]);
  const pool = new DevicePool(
    createDevicePoolDependencies(manager, "daemon-h13", {
      timer,
      deviceManager: utils,
      idGenerator: new CountingIdGenerator("autolock"),
    }),
  );
  await pool.initializeWithDevices([DEVICE]);
  // rotateHandler resolves the SessionManager through DaemonState, as in the daemon.
  DaemonState.getInstance().initialize(manager, pool);
  return { timer, manager, pool, restoredRotations };
}

/**
 * Stand-in for the Rotate feature: the adb write is a deferred. It still goes through
 * the production `options.sessionRotation` seam that rotateHandler wires to
 * runSessionRotationMutation (interactionTools.ts:2586-2588).
 */
function installSlowRotate(recordRotationSlot: boolean) {
  const adbWrite = Promise.withResolvers<void>();
  let started = false;
  setRotateFactory((_device, options?: RotateOptions) => ({
    execute: async (orientation) => {
      const mutation = async (slot?: RotationRestoreSlot): Promise<RotateResult> => {
        if (recordRotationSlot) {
          slot?.record(PRIOR_ROTATION);
        }
        started = true;
        await adbWrite.promise;
        return { success: true, orientation, value: 1, rotationPerformed: recordRotationSlot };
      };
      return options?.sessionRotation ? options.sessionRotation(mutation) : mutation();
    },
  }));
  return { adbWrite, hasStarted: () => started };
}

/** Let the real 5-min sweep expire the idle autolock session, then lapse the 1 s setup drain. */
async function expireThroughCleanupSweep(
  timer: FakeTimer,
  manager: SessionManager,
  sessionId: string,
): Promise<void> {
  timer.advanceTime(SESSION_CLEANUP_INTERVAL_MS);
  await drainUntil(() => timer.getPendingTimeouts().includes(SESSION_SETUP_DRAIN_TIMEOUT_MS), {
    description: "release parked on the bounded setup drain",
  });
  timer.advanceTime(SESSION_SETUP_DRAIN_TIMEOUT_MS);
  await manager.waitForSessionRelease(sessionId);
  await drainUntil(() => !manager.hasSession(sessionId), { description: "session removed" });
}

test("H13: expiry release whose quarantine is chained after notify leaves the idle device autolocked to the dead session", async () => {
  const { timer, manager, pool, restoredRotations } = await setupDaemonPool();
  const rotate = installSlowRotate(true);

  const sessionId = (await pool.autolockDevice(DEVICE.deviceId, "android", "mcp-client-1"))!;
  expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
    status: "busy",
    sessionId,
    autolockSessionId: sessionId,
  });

  // The rotate tool call records the session's prior rotation, then waits on a slow adb write.
  const rotateCall = rotateHandler(DEVICE, { orientation: "landscape", sessionUuid: sessionId });
  await drainUntil(rotate.hasStarted, { description: "rotation mutation started" });

  // No heartbeat or tool activity: the 60 s autolock window lapses, and the sweep
  // releases through the EXPIRY branch (expiryOrigin "cleanup-expired").
  await expireThroughCleanupSweep(timer, manager, sessionId);
  expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
    status: "busy",
    sessionId,
    autolockSessionId: sessionId,
  });
  expect(manager.getPendingDeviceCleanup(DEVICE.deviceId)).not.toBeNull();

  // The adb write lands. The setup's finally publishes the rotation restore as NEW
  // pending cleanup, chained onto the one the pool captured at notify.
  rotate.adbWrite.resolve();
  const response = (await rotateCall) as { isError?: boolean };
  expect(response.isError).toBeUndefined();
  await drainUntilQuiescent(timer, { description: "chained cleanup and deferred release" });

  expect(restoredRotations).toEqual([PRIOR_ROTATION]);
  expect(manager.getPendingDeviceCleanup(DEVICE.deviceId)).toBeNull();
  const device = pool.getDevice(DEVICE.deviceId)!;
  expect(device.status).toBe("idle");
  expect(device.sessionId).toBeNull();
  expect(pool.getStats().idle).toBe(1);

  // CURRENT (bug): the idle device is still autolocked to the released UUID.
  // AFTER FIX: expect(device.autolockSessionId).toBeUndefined();
  expect(device.autolockSessionId).toBe(sessionId);

  // Two hours of the real sweep and no client activity: no idle timeout ever clears it.
  timer.advanceTime(2 * HOUR_MS);
  await drainUntilQuiescent(timer, { description: "two hours of sweeps" });
  expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
    status: "idle",
    sessionId: null,
    autolockSessionId: sessionId,
  });

  // The device-tool gate (toolRegistry.ts:965-970) refuses every caller but the dead UUID.
  // AFTER FIX: both calls below return without throwing.
  expect(() => pool.assertAutolockAccess(DEVICE.deviceId, undefined)).toThrow(
    "locked to another session",
  );
  // A non-autolock bind (bindOrReuseDeviceSession) takes the idle device. Every tool
  // call it makes is then refused, and nothing on that path overwrites the stale lock.
  await pool.bindOrReuseDeviceSession("studio-session", DEVICE.deviceId, "android");
  expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
    status: "busy",
    sessionId: "studio-session",
    autolockSessionId: sessionId,
  });
  expect(() => pool.assertAutolockAccess(DEVICE.deviceId, "studio-session")).toThrow(
    "locked to another session",
  );
  manager.stopCleanupTimer();
});

test("H13 control: the same expiry release with NO chained cleanup clears the autolock when the device goes idle", async () => {
  const { timer, manager, pool, restoredRotations } = await setupDaemonPool();
  // The rotation was a no-op, so no slot was recorded and the setup's finally publishes nothing late.
  const rotate = installSlowRotate(false);

  const sessionId = (await pool.autolockDevice(DEVICE.deviceId, "android", "mcp-client-1"))!;
  const rotateCall = rotateHandler(DEVICE, { orientation: "landscape", sessionUuid: sessionId });
  await drainUntil(rotate.hasStarted, { description: "rotation mutation started" });

  await expireThroughCleanupSweep(timer, manager, sessionId);
  expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId });

  rotate.adbWrite.resolve();
  await rotateCall;
  await drainUntilQuiescent(timer, { description: "captured cleanup and deferred release" });

  expect(restoredRotations).toEqual([]);
  expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
    status: "idle",
    sessionId: null,
    autolockSessionId: undefined,
  });
  expect(() => pool.assertAutolockAccess(DEVICE.deviceId, undefined)).not.toThrow();
  manager.stopCleanupTimer();
});

test("H13 reachability control: with the daemon's execution gate, the in-flight rotate call keeps the session from expiring, so this trigger never fires", async () => {
  const { timer, manager, pool, restoredRotations } = await setupDaemonPool();
  // Mirror daemon.ts:711-713 + 2511-2524 with a real ExecutionTracker. index.ts:1252-1258
  // registers the tool call under its sessionUuid for the whole handler.
  const executions = new ExecutionTracker(timer, new CountingIdGenerator("exec"));
  manager.setActiveSessionExecutionChecker(
    (id, query) =>
      executions.hasActiveSessionUuidExecutions(id, query) ||
      executions.hasActiveAutolockSessionExecutions(id, query),
  );
  const rotate = installSlowRotate(true);

  const sessionId = (await pool.autolockDevice(DEVICE.deviceId, "android", "mcp-client-1"))!;
  const execution = executions.startExecution("rotate", "mcp-client-1", sessionId);
  const rotateCall = rotateHandler(DEVICE, { orientation: "landscape", sessionUuid: sessionId });
  await drainUntil(rotate.hasStarted, { description: "rotation mutation started" });

  // Five minutes pass while the call is in flight: the sweep skips the session.
  timer.advanceTime(SESSION_CLEANUP_INTERVAL_MS);
  await drainUntilQuiescent(timer, { description: "sweep with active execution" });
  expect(manager.hasSession(sessionId)).toBe(true);
  expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({ status: "busy", sessionId });

  rotate.adbWrite.resolve();
  await rotateCall;
  executions.endExecution(execution.id);

  // The next sweep releases with no setup in flight. The rotation restores inside the
  // bounded teardown, so nothing is chained late and the autolock clears.
  timer.advanceTime(SESSION_CLEANUP_INTERVAL_MS);
  await drainUntilQuiescent(timer, { description: "clean expiry release" });
  expect(manager.hasSession(sessionId)).toBe(false);
  expect(restoredRotations).toEqual([PRIOR_ROTATION]);
  expect(pool.getDevice(DEVICE.deviceId)).toMatchObject({
    status: "idle",
    sessionId: null,
    autolockSessionId: undefined,
  });
  manager.stopCleanupTimer();
});

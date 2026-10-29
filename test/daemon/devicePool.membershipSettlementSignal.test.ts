import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makePool } from "../helpers/makePool";
import { logger, LogLevel } from "../../src/utils/logger";
import type { BootedDevice } from "../../src/models";
import { SessionManager } from "../../src/daemon/sessionManager";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { drainUntil } from "../helpers/fakeTimerStepping";

// The disconnect monitor's membership settlement takes the reconcile's own signal explicitly
// (#15671): a cancel of that signal stops the settlement even with no ambient abort scope.

const original: BootedDevice = {
  deviceId: "emulator-5554",
  name: "AVD-A",
  platform: "android",
  observedAt: 1,
};
const replacement: BootedDevice = { ...original, name: "AVD-B", observedAt: 10 };

let previousLogLevel: LogLevel;
beforeEach(() => {
  previousLogLevel = logger.getLogLevel();
  logger.setLogLevel(LogLevel.NONE);
});
afterEach(() => logger.setLogLevel(previousLogLevel));

async function setup() {
  const timer = new FakeTimer();
  const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
  sessions.stopCleanupTimer();
  const manager = new FakeDeviceManager([], [original]);
  const pool = makePool(sessions, "daemon-test", { timer, deviceManager: manager });
  await pool.initializeWithDevices([original]);
  manager.bootedDevices = [replacement];
  return { sessions, pool, entry: pool.getDevice(original.deviceId)! };
}

/** Run a monitor reconcile while settlement waits on the assignment lock, then release it. */
async function reconcileBehindAssignmentLock(
  h: Awaited<ReturnType<typeof setup>>,
  signal: AbortSignal | undefined,
  whileBlocked: () => void,
): Promise<PromiseSettledResult<void>> {
  const mutex = h.pool.testHooks.assignmentMutex;
  const gate = Promise.withResolvers<void>();
  const blocked = mutex.runExclusive(() => gate.promise);
  const queued = spyOn(mutex, "runExclusive");
  const reconcile = h.pool.reconcileDiscoveryObservation([replacement], "disconnect-monitor", {
    settleMembership: true,
    signal,
  });
  await drainUntil(() => queued.mock.calls.length > 0, {
    description: "membership settlement queued on the assignment lock",
  });
  queued.mockRestore();
  whileBlocked();
  gate.resolve();
  await blocked;
  const [settled] = await Promise.allSettled([reconcile]);
  return settled;
}

describe("disconnect-monitor membership settlement signal", () => {
  test("a cancel of the reconcile signal mid-settlement keeps the pooled incarnation", async () => {
    const h = await setup();
    try {
      expect(getAbortSignal()).toBeUndefined();
      const controller = new AbortController();
      const settled = await reconcileBehindAssignmentLock(h, controller.signal, () =>
        controller.abort(new Error("monitor tick cancelled")),
      );
      expect(settled).toMatchObject({
        status: "rejected",
        reason: { message: "monitor tick cancelled" },
      });
      expect(h.pool.getDevice(original.deviceId)).toBe(h.entry);
      expect(h.entry.incarnation).toBe(1);
      expect(h.entry.name).toBe("AVD-A");
    } finally {
      h.sessions.stopCleanupTimer();
    }
  });

  test("with no signal the settlement replaces the incarnation as before", async () => {
    const h = await setup();
    try {
      const settled = await reconcileBehindAssignmentLock(h, undefined, () => {});
      expect(settled.status).toBe("fulfilled");
      const current = h.pool.getDevice(original.deviceId)!;
      expect(current).not.toBe(h.entry);
      expect(current).toMatchObject({ name: "AVD-B", status: "idle", sessionId: null });
    } finally {
      h.sessions.stopCleanupTimer();
    }
  });
});

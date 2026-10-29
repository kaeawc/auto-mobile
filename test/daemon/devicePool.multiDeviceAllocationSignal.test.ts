import { makePool } from "../helpers/makePool";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DeviceAllocation } from "../../src/daemon/deviceAllocation";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

/**
 * Multi-device allocation runs under the caller's explicit signal, not the ambient one (#15671):
 * the entry point is the allocation's only ambient read (a caller passing no signal falls back to
 * it), and the chosen signal reaches the retry wait and each criteria attempt. A cancel mid-wait
 * ends the allocation at once; a call with no signal anywhere allocates as before.
 */
for (const byCriteria of [false, true]) {
  describe(`${byCriteria ? "criteria" : "platform"} multi-device allocation signal`, () => {
    let timer: FakeTimer;
    let sessions: SessionManager;
    let pool: DevicePool;

    async function arrangeHarness(): Promise<void> {
      timer = new FakeTimer();
      sessions = new SessionManager(timer, new FakeDeviceSessionPersistence());
      const manager = new FakeDeviceManager();
      const devices = [{ deviceId: "d1", name: "d1", platform: "android" as const }];
      manager.bootedDevices = devices;
      pool = makePool(sessions, "allocation-signal-test", { timer, deviceManager: manager });
      await pool.initializeWithDevices(devices);
    }

    function arranged(name: string, fn: () => Promise<void>): void {
      test(name, async () => {
        await arrangeHarness();
        await fn();
      });
    }

    afterEach(() => {
      sessions.stopCleanupTimer();
      timer.reset();
    });

    const allocate = (signal?: AbortSignal) =>
      byCriteria
        ? pool.assignMultipleDevicesByCriteria(
            [{ sessionId: "a", criteria: { platform: "android" } }],
            60_000,
            signal,
          )
        : pool.assignMultipleDevices(["a"], 60_000, "android", signal);

    function observe(promise: Promise<unknown>): { settled: boolean; outcome: unknown } {
      const state: { settled: boolean; outcome: unknown } = { settled: false, outcome: undefined };
      promise.then(
        (value) => {
          state.settled = true;
          state.outcome = value;
        },
        (error: unknown) => {
          state.settled = true;
          state.outcome = error;
        },
      );
      return state;
    }

    /** Hold the only device on another session so the allocation waits in its retry loop. */
    const holdDevice = () =>
      pool.bindOrReuseDeviceSession({ sessionId: "owner", deviceId: "d1", platform: "android" });

    const releaseHeldDevice = async () => {
      await sessions.releaseSession("owner");
      await pool.releaseDevice("d1", "owner");
    };

    arranged("an explicit signal's cancel ends the retry wait at once", async () => {
      await holdDevice();
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const allocation = observe(allocate(controller.signal));
      await drainUntilQuiescent(timer);
      expect(allocation.settled).toBe(false);

      // No fake time passes: only the explicit signal can end the wait here.
      controller.abort(reason);
      await drainUntilQuiescent(timer);

      expect(allocation.settled).toBe(true);
      expect(allocation.outcome).toBe(reason);
      expect(sessions.getSession("a")).toBeNull();
    });

    arranged("an explicit signal aborted before the attempt claims no device", async () => {
      const controller = new AbortController();
      const reason = new Error("cancelled before allocation");
      controller.abort(reason);

      expect(await allocate(controller.signal).catch((error: unknown) => error)).toBe(reason);
      expect(sessions.getSession("a")).toBeNull();
      expect(pool.getDevice("d1")?.sessionId).toBeNull();
    });

    arranged("with no explicit signal the entry point reads the ambient signal", async () => {
      await holdDevice();
      const controller = new AbortController();
      const reason = new Error("request cancelled");
      const allocation = observe(runWithAbortSignal(controller.signal, () => allocate()));
      await drainUntilQuiescent(timer);
      expect(allocation.settled).toBe(false);

      controller.abort(reason);
      await drainUntilQuiescent(timer);

      expect(allocation.settled).toBe(true);
      expect(allocation.outcome).toBe(reason);
    });

    arranged("a call with no signal still waits for and takes a freed device", async () => {
      await holdDevice();
      const allocation = observe(allocate());
      await drainUntilQuiescent(timer);
      expect(allocation.settled).toBe(false);

      await releaseHeldDevice();
      await drainUntilQuiescent(timer);

      expect(allocation.settled).toBe(true);
      expect(allocation.outcome).toEqual(new Map([["a", "d1"]]));
    });

    if (byCriteria) {
      arranged("each criteria attempt receives the caller's signal", async () => {
        const attempt = spyOn(DeviceAllocation.prototype, "tryAssignDeviceWithCriteria");
        try {
          const controller = new AbortController();
          expect(await allocate(controller.signal)).toEqual(new Map([["a", "d1"]]));
          expect(attempt).toHaveBeenCalledTimes(1);
          expect(attempt.mock.calls[0]?.[2]).toBe(controller.signal);
        } finally {
          attempt.mockRestore();
        }
      });
    }
  });
}

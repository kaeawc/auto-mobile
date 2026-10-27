import { afterEach, beforeEach, describe, expect, spyOn, test, mock } from "bun:test";
import {
  PLAN_AUTO_RELEASE_REASON,
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { fixedBackoff } from "../../src/utils/Backoff";
import { logger } from "../../src/utils/logger";
import { BusyRewritePersistence } from "../fakes/BusyRewritePersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "s1";
const DEVICE = "emulator-5554";
const OTHER_DEVICE = "emulator-5556";
const DEVICE_LOSS = `device-disconnected:${DEVICE}`;
const IDLE_WINDOW_MS = 60_000;
const REWRITE_RETRY_DELAY_MS = 500;
const RELEASE_RETRY_DELAY_MS = 700;

async function settleMicrotasks(turns: number = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

// #11557: the row a release leaves is the release that ended the session, whatever failed,
// was parked or was forced on the way.
describe("the row of a released session (#11557)", () => {
  let timer: FakeTimer;
  let store: BusyRewritePersistence;
  let manager: SessionManager;
  let releases: string[];

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    store = new BusyRewritePersistence();
    manager = new SessionManager(timer, store, { barrier: () => new FakeDbWriteBarrier() });
    manager.stopCleanupTimer();
    manager.setSupersededRowReassertBackoff(fixedBackoff(REWRITE_RETRY_DELAY_MS));
    manager.setTerminalReleaseRetryBackoff(fixedBackoff(RELEASE_RETRY_DELAY_MS));
    releases = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => releases.push(reason));
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  const row = async () => await store.getSession(SESSION);

  async function planReleaseWithFailingWrite(failures: number): Promise<void> {
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_WINDOW_MS });
    store.failReleaseWrites = failures;
    expect(await manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON)).toBe(DEVICE);
    await settleMicrotasks();
    // The scenario was driven: the session is gone and its row still reads active.
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await row()).toMatchObject({ status: "active", release_reason: null });
  }

  /**
   * The live session of a device-loss release whose terminal write is parked: the returned
   * function lands that write (its terminal row) and runs the rewrite of the live row over it.
   * A release no longer produces this since #11799 W5 (a volatile row that landed has won, and a
   * durable release declines before it writes), so the late landing is driven directly; the rewrite
   * machinery behind it is exercised unchanged until the release-driven half is deleted.
   */
  async function supersededReleaseWithParkedWrite(): Promise<() => void> {
    const session = await manager.createSession(SESSION, DEVICE, "android", {
      timeoutMs: IDLE_WINDOW_MS,
    });
    const settleExpected = manager.testHooks.wiring.host.superseded.expectReassert(SESSION);
    manager.testHooks.wiring.host.superseded.remember(session, [DEVICE_LOSS]);
    return () => {
      void (async () => {
        const current = (await row())!;
        store.seed({ ...current, status: "released", release_reason: DEVICE_LOSS });
        const rows = manager.testHooks.wiring.supersededRows;
        if (manager.getSession(SESSION)) {
          await rows.reassertSupersededLiveRow(session, [DEVICE_LOSS]);
        } else {
          // The session it spared has ended since, for a reason that is not terminal.
          await rows.restoreNonTerminalRowOverSupersededRelease(session, [DEVICE_LOSS]);
        }
      })().finally(settleExpected);
    };
  }

  test("a non-terminal release whose write fails is retried on the release backoff until it lands", async () => {
    await planReleaseWithFailingWrite(2);
    expect(timer.getPendingTimeouts()).toEqual([RELEASE_RETRY_DELAY_MS]);

    await timer.advanceTimeAsync(RELEASE_RETRY_DELAY_MS);
    await settleMicrotasks();
    // The first retry failed too: still pending, and armed again.
    expect(await row()).toMatchObject({ status: "active" });
    expect(timer.getPendingTimeouts()).toEqual([RELEASE_RETRY_DELAY_MS]);

    await timer.advanceTimeAsync(RELEASE_RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(await row()).toMatchObject({
      status: "released",
      release_reason: PLAN_AUTO_RELEASE_REASON,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(releases).toEqual([PLAN_AUTO_RELEASE_REASON]);
  });

  test("shutdown's drain writes a pending non-terminal release instead of forgetting it", async () => {
    await planReleaseWithFailingWrite(1);

    expect(await manager.drainReleasePromises(1_000)).toBe(true);

    expect(await row()).toMatchObject({
      status: "released",
      release_reason: PLAN_AUTO_RELEASE_REASON,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("the drain's one attempt arms no timer when it fails as well", async () => {
    await planReleaseWithFailingWrite(2);

    expect(await manager.drainReleasePromises(1_000)).toBe(true);

    expect(store.failReleaseWrites).toBe(0);
    expect(await row()).toMatchObject({ status: "active" });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("the name issued again ends the retry, and its row stays live", async () => {
    await planReleaseWithFailingWrite(1);

    const reissued = await manager.createSession(SESSION, OTHER_DEVICE, "android", {
      timeoutMs: IDLE_WINDOW_MS,
    });
    expect(timer.getPendingTimeouts()).toEqual([RELEASE_RETRY_DELAY_MS]);
    await timer.advanceTimeAsync(RELEASE_RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(manager.getSession(SESSION)).toBe(reissued);
    expect(await row()).toMatchObject({
      status: "active",
      release_reason: null,
      device_id: OTHER_DEVICE,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a parked non-terminal release refuses the re-created row without warning or retry (#11129)", async () => {
    manager.attachDaemonSessionId("daemon-a");
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_WINDOW_MS });
    const gate = Promise.withResolvers<void>();
    store.park = gate.promise;
    const releaseWriteSpy = spyOn(store, "markReleased");
    try {
      const release = manager.releaseSession(SESSION, "daemon-shutdown");
      void release.catch(() => undefined);
      await settleMicrotasks();
      expect(releaseWriteSpy).toHaveBeenCalledTimes(1);
      await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await expect(release).resolves.toBe(DEVICE);
      expect(manager.getSession(SESSION)).toBeNull();

      const reissued = await manager.createSession(SESSION, DEVICE, "android", {
        timeoutMs: IDLE_WINDOW_MS,
      });
      // Drain the deadline's already-armed retry; recreation makes it obsolete.
      await timer.advanceTimeAsync(RELEASE_RETRY_DELAY_MS);
      await settleMicrotasks();
      expect(releaseWriteSpy).toHaveBeenCalledTimes(1);
      const reissuedRow = structuredClone(await row());
      const pendingTimeouts = timer.getPendingTimeoutCount();
      expect(pendingTimeouts).toBe(0);
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        store.park = undefined;
        gate.resolve();
        await settleMicrotasks();

        expect(await row()).toMatchObject({ status: "active", release_reason: null });
        expect(await row()).toEqual(reissuedRow);
        expect(manager.getSession(SESSION)).toBe(reissued);
        expect(warnSpy).not.toHaveBeenCalled();
        expect(timer.getPendingTimeoutCount()).toBe(pendingTimeouts);
        expect(releaseWriteSpy).toHaveBeenCalledTimes(1);
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      gate.resolve();
      store.park = undefined;
      releaseWriteSpy.mockRestore();
    }
  });

  test("a retry its own precondition skipped is still owed, for the generation the row has now", async () => {
    await planReleaseWithFailingWrite(1);
    let landRetryWrite!: () => void;
    store.park = new Promise<void>((resolve) => {
      landRetryWrite = resolve;
    });
    await timer.advanceTimeAsync(RELEASE_RETRY_DELAY_MS);
    await settleMicrotasks();
    // An issue of the name that failed claimed the row and handed it back under the write.
    const claimed = (await row())!;
    store.seed({
      ...claimed,
      stable_identity_generation: (claimed.stable_identity_generation ?? 0) + 2,
    });
    store.park = undefined;
    landRetryWrite();
    await settleMicrotasks();
    // The scenario was driven: the write named the generation from before, and changed nothing.
    expect(await row()).toMatchObject({ status: "active", release_reason: null });
    expect(timer.getPendingTimeouts()).toEqual([RELEASE_RETRY_DELAY_MS]);

    await timer.advanceTimeAsync(RELEASE_RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(await row()).toMatchObject({
      status: "released",
      release_reason: PLAN_AUTO_RELEASE_REASON,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a release that took the shutdown handoff's reason is not retried with its first", async () => {
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_WINDOW_MS });
    let failFirstWrite!: () => void;
    store.park = new Promise<void>((resolve) => {
      failFirstWrite = resolve;
    });
    store.failReleaseWrites = 1;
    const plan = manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON);
    await settleMicrotasks(100);
    // Shutdown joins the release while its first write is in flight, and that write then fails.
    const handoff = manager.releaseSession(SESSION, "daemon-shutdown");
    store.park = undefined;
    failFirstWrite();
    await Promise.all([plan, handoff]);
    await settleMicrotasks();

    expect(releases).toEqual([PLAN_AUTO_RELEASE_REASON, "daemon-shutdown"]);
    expect(await row()).toMatchObject({ release_reason: "daemon-shutdown" });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a superseded release's parked terminal write that lands after the plan's release leaves the name issuable", async () => {
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    await manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON);
    expect(await row()).toMatchObject({ release_reason: PLAN_AUTO_RELEASE_REASON });

    landReleaseWrite();
    await settleMicrotasks();

    // No terminal release ended the session: its row is the plan's again, not the device loss's.
    expect(await row()).toMatchObject({
      status: "released",
      release_reason: PLAN_AUTO_RELEASE_REASON,
    });
    expect(releases).toEqual([PLAN_AUTO_RELEASE_REASON]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const reissued = await manager.createSession(SESSION, DEVICE, "android", {
      timeoutMs: IDLE_WINDOW_MS,
    });
    expect(manager.getSession(SESSION)).toBe(reissued);
  });

  test("a terminal release of the handed-off session while that write is still parked is answered from its row", async () => {
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    await manager.releaseSession(SESSION, `device-restart:${DEVICE}`);

    // The parked write hides nothing: the row this release writes is read back as the release.
    expect(await manager.releaseSession(SESSION, DEVICE_LOSS)).toBe(DEVICE);

    landReleaseWrite();
    await settleMicrotasks();
    expect(await row()).toMatchObject({ release_reason: DEVICE_LOSS });
    expect(releases).toContain(DEVICE_LOSS);
    expect(
      await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_WINDOW_MS }).then(
        () => "issued",
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      ),
    ).toBe("TerminalSessionError");
  });

  test("a peer's terminal row for the same reason, written while that write is parked, still ends the name", async () => {
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    await manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON);
    const released = (await row())!;
    store.seed({ ...released, status: "released", release_reason: DEVICE_LOSS });

    expect(
      await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_WINDOW_MS }).then(
        () => "issued",
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      ),
    ).toBe("TerminalSessionError");
    landReleaseWrite();
    await settleMicrotasks();
    expect(await row()).toMatchObject({ release_reason: DEVICE_LOSS });
  });

  test("a lookup of the name while that terminal row stands does not fence it", async () => {
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    await manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON);
    let lookup: Promise<string> | undefined;
    // The row is rewritten as the session held it; the name is looked up before that lands.
    store.duringPlainUpsert = async () => {
      expect(await row()).toMatchObject({ release_reason: DEVICE_LOSS });
      lookup = manager.getOrCreateSession(SESSION).then(
        () => "issued",
        (error: unknown) => (error instanceof Error ? error.name : String(error)),
      );
      await settleMicrotasks(100);
    };

    landReleaseWrite();
    await settleMicrotasks();

    expect(await lookup).not.toBe("TerminalSessionError");
    expect(await row()).toMatchObject({ release_reason: PLAN_AUTO_RELEASE_REASON });
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_WINDOW_MS });
    expect(manager.getSession(SESSION)).not.toBeNull();
  });

  test("a rewrite still owed when the plan's release ends the session is replaced by that release's row", async () => {
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    store.failPlainUpserts = 1;
    landReleaseWrite();
    await settleMicrotasks();
    // The scenario was driven: the terminal row landed and its rewrite failed, so it is owed.
    expect(await row()).toMatchObject({ release_reason: DEVICE_LOSS });
    expect(timer.getPendingTimeouts()).toEqual([REWRITE_RETRY_DELAY_MS]);

    await manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON);
    await settleMicrotasks();

    expect(await row()).toMatchObject({
      status: "released",
      release_reason: PLAN_AUTO_RELEASE_REASON,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("that replacement, when its write fails, is retried before the release's own row", async () => {
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    await manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON);
    store.failPlainUpserts = 1;

    landReleaseWrite();
    await settleMicrotasks();
    expect(await row()).toMatchObject({ release_reason: DEVICE_LOSS });
    expect(timer.getPendingTimeouts()).toEqual([RELEASE_RETRY_DELAY_MS]);
    await timer.advanceTimeAsync(RELEASE_RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(await row()).toMatchObject({
      status: "released",
      release_reason: PLAN_AUTO_RELEASE_REASON,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a rebind's row that lands after its session was forced out is released again", async () => {
    await manager.createSession(SESSION, DEVICE, "android", { timeoutMs: IDLE_WINDOW_MS });
    let landRebindWrite!: () => void;
    store.duringPlainUpsert = () =>
      new Promise<void>((resolve) => {
        landRebindWrite = resolve;
      });
    const rebind = manager.rebindSession(SESSION, OTHER_DEVICE, "android").then(
      () => "rebound",
      () => "failed",
    );
    await settleMicrotasks(100);
    const released = manager.releaseSession(SESSION, "heartbeat-timeout").then(
      () => "released",
      () => "failed",
    );
    await settleMicrotasks(100);
    expect(manager.forceStuckRelease(SESSION)?.stage).toBe("awaiting-rebind");
    await settleMicrotasks();
    expect(await row()).toMatchObject({ release_reason: "heartbeat-timeout" });

    landRebindWrite();
    await rebind;
    await released;
    await settleMicrotasks();

    // The rebind's live row landed over the forced release's: it is the released row again.
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await row()).toMatchObject({
      status: "expired",
      release_reason: "heartbeat-timeout",
    });
    expect(releases).toEqual(["heartbeat-timeout"]);
  });

  test("a terminal row write waiting on a release stops waiting the moment that release is forced", async () => {
    await supersededReleaseWithParkedWrite();
    // The device-loss release's terminal write is parked past its deadline and then fails.
    const failParkedWrite = () =>
      manager.testHooks.wiring.releasePersistence.trackLateReleaseWrite(
        Promise.reject(new Error("SQLITE_BUSY: database is locked")),
        {
          sessionId: SESSION,
          deviceId: DEVICE,
          releaseReason: DEVICE_LOSS,
          releasedAtMs: timer.now(),
          terminal: true,
          heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
        },
      );
    // A second release of the session never starts: it waits on a rebind whose write never lands.
    store.duringPlainUpsert = () => new Promise<void>(() => {});
    const rebind = manager.rebindSession(SESSION, OTHER_DEVICE, "android");
    await settleMicrotasks(100);
    const stuck = manager.releaseSession(SESSION, "heartbeat-timeout");
    await settleMicrotasks(100);
    // The first release's parked write fails now; its retry waits for the release in flight.
    failParkedWrite();
    await settleMicrotasks();
    expect(timer.getPendingTimeouts()).not.toContain(RELEASE_RETRY_DELAY_MS);

    expect(manager.forceStuckRelease(SESSION)?.stage).toBe("awaiting-rebind");
    await settleMicrotasks();

    // Neither the release nor the rebind settled, yet the wait ended: the row that failed is
    // handed to the retry, for the fence the force raised.
    expect(await Promise.race([stuck, rebind, Promise.resolve("pending")])).toBe("pending");
    expect(timer.getPendingTimeouts()).toContain(RELEASE_RETRY_DELAY_MS);
    await timer.advanceTimeAsync(RELEASE_RETRY_DELAY_MS);
    await settleMicrotasks();
    expect(timer.getPendingTimeouts()).not.toContain(RELEASE_RETRY_DELAY_MS);
    expect(await row()).toMatchObject({
      status: "expired",
      release_reason: "heartbeat-timeout",
    });
    expect(releases).toEqual(["heartbeat-timeout"]);
  });
});

afterEach(() => {
  mock.restore();
});

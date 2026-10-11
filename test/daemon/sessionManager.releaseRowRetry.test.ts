import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  PLAN_AUTO_RELEASE_REASON,
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { fixedBackoff } from "../../src/utils/Backoff";
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
    manager = new SessionManager(timer, store, () => new FakeDbWriteBarrier());
    manager.stopCleanupTimer();
    manager.setSupersededRowReassertBackoff(fixedBackoff(REWRITE_RETRY_DELAY_MS));
    manager.setTerminalReleaseRetryBackoff(fixedBackoff(RELEASE_RETRY_DELAY_MS));
    releases = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => releases.push(reason));
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  const row = async () => await store.getSession?.(SESSION);

  async function planReleaseWithFailingWrite(failures: number): Promise<void> {
    await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    store.failReleaseWrites = failures;
    expect(await manager.releaseSession(SESSION, PLAN_AUTO_RELEASE_REASON)).toBe(DEVICE);
    await settleMicrotasks();
    // The scenario was driven: the session is gone and its row still reads active.
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await row()).toMatchObject({ status: "active", release_reason: null });
  }

  /**
   * A device-loss release is superseded at its deadline while its terminal write is parked. The
   * session lives on, its live row rewritten; the returned function lands (or fails) that write.
   */
  async function supersededReleaseWithParkedWrite(): Promise<() => void> {
    await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    let landReleaseWrite!: () => void;
    store.park = new Promise<void>((resolve) => {
      landReleaseWrite = resolve;
    });
    let superseded = false;
    const release = manager.releaseSessionUnlessSuperseded(SESSION, DEVICE_LOSS, () => !superseded);
    await settleMicrotasks(100);
    superseded = true;
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    expect(await release).toEqual({ superseded: true });
    store.park = undefined;
    expect(manager.getSession(SESSION)).not.toBeNull();
    return landReleaseWrite;
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

    const reissued = await manager.createSession(SESSION, OTHER_DEVICE, "android", IDLE_WINDOW_MS);
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

  test("a release that took the shutdown handoff's reason is not retried with its first", async () => {
    await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
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
    const reissued = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    expect(manager.getSession(SESSION)).toBe(reissued);
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
    await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
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
    await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
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
    const failParkedWrite = await supersededReleaseWithParkedWrite();
    // A second release of the session never starts: it waits on a rebind whose write never lands.
    store.duringPlainUpsert = () => new Promise<void>(() => {});
    const rebind = manager.rebindSession(SESSION, OTHER_DEVICE, "android");
    await settleMicrotasks(100);
    const stuck = manager.releaseSession(SESSION, "heartbeat-timeout");
    await settleMicrotasks(100);
    // The first release's parked write fails now; its retry waits for the release in flight.
    store.failReleaseWrites = 1;
    failParkedWrite();
    await settleMicrotasks();
    expect(store.failReleaseWrites).toBe(0);
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

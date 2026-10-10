import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import type {
  DeviceSessionRecord,
  MarkReleasedOptions,
  UpsertActiveSessionOptions,
} from "../../src/db/deviceSessionRepository";
import type { DeviceSessionStatus } from "../../src/db/types";
import { fixedBackoff } from "../../src/utils/Backoff";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "s1";
const DEVICE = "emulator-5554";
const DEVICE_LOSS = `device-disconnected:${DEVICE}`;
const IDLE_WINDOW_MS = 60_000;
const RETRY_DELAY_MS = 500;
const TERMINAL_RETRY_DELAY_MS = 700;

/**
 * A store whose release write can be parked past the release deadline, and whose plain upserts
 * (the rewrite of a live row, #11206) can be made to fail, as a busy database does.
 */
class BusyRewritePersistence extends FakeDeviceSessionPersistence {
  park: Promise<void> | undefined;
  /** Plain upserts still to fail; `Infinity` keeps the database busy. */
  failPlainUpserts = 0;
  plainUpserts = 0;
  /** Runs once, while the next plain upsert is in flight (before it lands or fails). */
  duringPlainUpsert: (() => Promise<void>) | undefined;
  /** Runs once, right after the next plain upsert has landed. */
  afterPlainUpsert: (() => Promise<void>) | undefined;
  /** Release writes still to fail, counted from the next one issued. */
  failReleaseWrites = 0;

  override async markReleased(
    sessionUuid: string,
    status: DeviceSessionStatus,
    releasedAtMs: number,
    reason: string,
    options?: MarkReleasedOptions,
  ): Promise<void> {
    await this.park;
    if (this.failReleaseWrites > 0) {
      this.failReleaseWrites--;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    await super.markReleased(sessionUuid, status, releasedAtMs, reason, options);
  }

  override async upsertActiveSession(
    record: DeviceSessionRecord,
    nowMs?: number,
    options: UpsertActiveSessionOptions = {},
  ): Promise<number> {
    if (!options.unlessTerminal) {
      this.plainUpserts++;
      const hook = this.duringPlainUpsert;
      this.duringPlainUpsert = undefined;
      await hook?.();
      if (this.failPlainUpserts > 0) {
        this.failPlainUpserts--;
        throw new Error("SQLITE_BUSY: database is locked");
      }
      const generation = await super.upsertActiveSession(record, nowMs, options);
      const landed = this.afterPlainUpsert;
      this.afterPlainUpsert = undefined;
      await landed?.();
      return generation;
    }
    return await super.upsertActiveSession(record, nowMs, options);
  }
}

async function settleMicrotasks(turns: number = 200): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

// #11557: the rewrite of a live row over its superseded release's terminal row (#11206) can fail.
describe("a failed rewrite of a live row over its superseded release's terminal row (#11557)", () => {
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
    manager.setSupersededRowReassertBackoff(fixedBackoff(RETRY_DELAY_MS));
    manager.setTerminalReleaseRetryBackoff(fixedBackoff(TERMINAL_RETRY_DELAY_MS));
    releases = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => releases.push(reason));
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  /** A tool call refreshes the session, which writes its activity row. */
  async function refresh(): Promise<string> {
    return await manager.getOrCreateSession(SESSION).then(
      () => "refreshed",
      (error: unknown) => (error instanceof Error ? error.name : String(error)),
    );
  }

  /**
   * A device-loss release is superseded while its terminal write is parked; the write then lands
   * late, under the session that lives on, and the rewrite of the live row fails `failures` times.
   */
  async function supersededReleaseWithFailingRewrite(failures: number): Promise<void> {
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
    store.plainUpserts = 0;
    store.failPlainUpserts = failures;
    landReleaseWrite();
    await settleMicrotasks();
    // The scenario was driven: the terminal row landed and the one rewrite of it failed.
    expect(store.plainUpserts).toBe(1);
    expect(await store.getSession?.(SESSION)).toMatchObject({ release_reason: DEVICE_LOSS });
    expect(manager.getSession(SESSION)).not.toBeNull();
    timer.advanceTime(1);
  }

  test("one transient failure does not end the live session, and the rewrite is retried", async () => {
    await supersededReleaseWithFailingRewrite(1);

    // The next tool call's activity write is refused against the terminal row.
    expect(await refresh()).toBe("SessionActivityPersistenceError");
    expect(manager.getSession(SESSION)).not.toBeNull();
    expect(manager.getSessionForDevice(DEVICE)).not.toBeNull();
    expect(releases).toEqual([]);

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(store.plainUpserts).toBe(2);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(await refresh()).toBe("refreshed");
    expect(releases).toEqual([]);
  });

  test("the retries are bounded, and an exhausted rewrite fails activity writes without a release", async () => {
    await supersededReleaseWithFailingRewrite(Number.POSITIVE_INFINITY);

    for (let attempt = 0; attempt < SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS + 3; attempt++) {
      await timer.advanceTimeAsync(RETRY_DELAY_MS);
      await settleMicrotasks(50);
    }

    // The first attempt plus the bounded retries, and no timer left behind.
    expect(store.plainUpserts).toBe(1 + SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(await refresh()).toBe("SessionActivityPersistenceError");
    expect(manager.getSession(SESSION)).not.toBeNull();
    expect(releases).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);

    // The database recovers: the next activity write rewrites the row it is still owed.
    store.failPlainUpserts = 0;
    timer.advanceTime(1);
    expect(await refresh()).toBe("refreshed");
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(releases).toEqual([]);
  });

  test("a peer's terminal row under the owed rewrite still ends the session and is not revived", async () => {
    await supersededReleaseWithFailingRewrite(1);
    const row = (await store.getSession?.(SESSION))!;
    store.seed({ ...row, status: "released", release_reason: "explicit-release" });

    expect(await refresh()).toBe("TerminalSessionError");

    expect(manager.getSession(SESSION)).toBeNull();
    expect(releases).toEqual(["explicit-release"]);
    await timer.advanceTimeAsync(RETRY_DELAY_MS * 4);
    await settleMicrotasks();
    expect(store.plainUpserts).toBe(1);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "explicit-release",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a retry that finds a peer's terminal row leaves it for the next activity write", async () => {
    await supersededReleaseWithFailingRewrite(1);
    const row = (await store.getSession?.(SESSION))!;
    store.seed({ ...row, status: "expired", release_reason: "heartbeat-timeout" });

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(store.plainUpserts).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(await refresh()).toBe("TerminalSessionError");
    expect(manager.getSession(SESSION)).toBeNull();
    expect(releases).toEqual(["heartbeat-timeout"]);
  });

  test("an explicit release while the retry is pending stays terminal and cancels the retry", async () => {
    await supersededReleaseWithFailingRewrite(1);

    await manager.releaseSession(SESSION, "explicit-release");

    expect(timer.getPendingTimeoutCount()).toBe(0);
    await timer.advanceTimeAsync(RETRY_DELAY_MS * 4);
    await settleMicrotasks();
    expect(store.plainUpserts).toBe(1);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "explicit-release",
    });
    expect(releases).toEqual(["explicit-release"]);
    expect(await refresh()).toBe("TerminalSessionError");
  });

  test("an explicit release that starts while a retry's write is in flight is not undone by it", async () => {
    await supersededReleaseWithFailingRewrite(1);
    let released: Promise<unknown> | undefined;
    store.duringPlainUpsert = async () => {
      released = manager.releaseSession(SESSION, "explicit-release");
      await settleMicrotasks(100);
    };

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();
    await released;
    await settleMicrotasks();

    expect(store.plainUpserts).toBe(2);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "explicit-release",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a retry whose write fails after the session ended owes nothing and arms no timer", async () => {
    await supersededReleaseWithFailingRewrite(2);
    let released: Promise<unknown> | undefined;
    store.duringPlainUpsert = async () => {
      released = manager.releaseSession(SESSION, "explicit-release");
      await settleMicrotasks(100);
    };

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();
    await released;
    await settleMicrotasks();

    // The scenario was driven: the retry's write was issued and failed, with the session gone.
    expect(store.plainUpserts).toBe(2);
    expect(store.failPlainUpserts).toBe(0);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(timer.getPendingTimeoutCount()).toBe(0);
    await timer.advanceTimeAsync(RETRY_DELAY_MS * 4);
    await settleMicrotasks();
    expect(store.plainUpserts).toBe(2);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "explicit-release",
    });
  });

  test("a retry due while a rebind is under way does not write the old binding over the rebind's row", async () => {
    const REBOUND_DEVICE = "emulator-5556";
    await supersededReleaseWithFailingRewrite(1);
    // The rebind's row has landed and the rebind has not published yet when the retry is due.
    store.afterPlainUpsert = async () => {
      await timer.advanceTimeAsync(RETRY_DELAY_MS);
      await settleMicrotasks(50);
    };

    await manager.rebindSession(SESSION, REBOUND_DEVICE, "android");

    expect(store.afterPlainUpsert).toBeUndefined();
    expect(manager.getSession(SESSION)?.assignedDevice).toBe(REBOUND_DEVICE);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      device_id: REBOUND_DEVICE,
    });
    // The deferred retry then writes the session as rebound, and nothing is left armed.
    await timer.advanceTimeAsync(RETRY_DELAY_MS * 2);
    await settleMicrotasks();
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      device_id: REBOUND_DEVICE,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(releases).toEqual([]);
  });

  test("a rebind that outlasts every retry settles the owed rewrite, so a later terminal row with the same reason ends the session", async () => {
    const REBOUND_DEVICE = "emulator-5556";
    await supersededReleaseWithFailingRewrite(1);
    const supersededRow = (await store.getSession?.(SESSION))!;
    // The rebind's write stays in flight while every retry comes due and yields to it.
    store.duringPlainUpsert = async () => {
      for (let attempt = 0; attempt < SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS + 2; attempt++) {
        await timer.advanceTimeAsync(RETRY_DELAY_MS);
        await settleMicrotasks(50);
      }
    };

    await manager.rebindSession(SESSION, REBOUND_DEVICE, "android");

    // The scenario was driven: only the rebind wrote, the retries are spent, and the row is live.
    expect(store.plainUpserts).toBe(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      device_id: REBOUND_DEVICE,
    });
    // A terminal row with the superseded release's reason lands afterwards (a peer's write).
    store.seed({ ...supersededRow, device_id: REBOUND_DEVICE });
    timer.advanceTime(1);

    expect(await refresh()).toBe("TerminalSessionError");

    expect(store.plainUpserts).toBe(2);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(releases).toEqual([DEVICE_LOSS]);
    expect(await store.getSession?.(SESSION)).toMatchObject({ release_reason: DEVICE_LOSS });
  });

  /** A device-loss release is superseded while its terminal write is parked past the deadline. */
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
    store.plainUpserts = 0;
    return landReleaseWrite;
  }

  test("a non-terminal release that completes while the rewrite is in flight does not leave an active row", async () => {
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    let released: Promise<unknown> | undefined;
    store.duringPlainUpsert = async () => {
      released = manager.releaseSession(SESSION, "plan-auto-release");
      await settleMicrotasks(100);
    };

    landReleaseWrite();
    await settleMicrotasks();
    await released;
    await settleMicrotasks();

    // The scenario was driven: the session ended while the one rewrite was in flight.
    expect(store.plainUpserts).toBe(1);
    expect(store.duringPlainUpsert).toBeUndefined();
    expect(manager.getSession(SESSION)).toBeNull();
    expect(releases).toEqual(["plan-auto-release"]);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "plan-auto-release",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a non-terminal release whose write is still in flight when the rewrite lands does not leave an active row", async () => {
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    let released: Promise<unknown> | undefined;
    let landPlanRelease!: () => void;
    store.duringPlainUpsert = async () => {
      // The release captures the row's generation and issues its write, which stays in flight.
      store.park = new Promise<void>((resolve) => {
        landPlanRelease = resolve;
      });
      released = manager.releaseSession(SESSION, "plan-auto-release");
      await settleMicrotasks(100);
    };

    landReleaseWrite();
    await settleMicrotasks();
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await store.getSession?.(SESSION)).toMatchObject({ status: "active" });
    landPlanRelease();
    await released;
    await settleMicrotasks();

    expect(store.plainUpserts).toBe(1);
    expect(releases).toEqual(["plan-auto-release"]);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "plan-auto-release",
    });
  });

  test("a terminal row whose re-write after the rewrite fails is retried with the terminal release backoff", async () => {
    await supersededReleaseWithFailingRewrite(1);
    let released: Promise<unknown> | undefined;
    store.duringPlainUpsert = async () => {
      released = manager.releaseSession(SESSION, "explicit-release");
      await settleMicrotasks(100);
      // The release's own terminal write has landed; the re-write over the rewrite fails once.
      store.failReleaseWrites = 1;
    };

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();
    await released;
    await settleMicrotasks();

    // The scenario was driven: the rewrite landed over the terminal row and the re-write failed.
    expect(store.plainUpserts).toBe(2);
    expect(store.failReleaseWrites).toBe(0);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await store.getSession?.(SESSION)).toMatchObject({ status: "active" });
    expect(timer.getPendingTimeouts()).toEqual([TERMINAL_RETRY_DELAY_MS]);

    await timer.advanceTimeAsync(TERMINAL_RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "explicit-release",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(releases).toEqual(["explicit-release"]);
  });

  test("stopping the manager cancels a pending retry", async () => {
    await supersededReleaseWithFailingRewrite(1);
    expect(timer.getPendingTimeoutCount()).toBe(1);

    manager.stopCleanupTimer();

    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("shutdown's drain rewrites an owed live row now, and arms no timer when that fails", async () => {
    await supersededReleaseWithFailingRewrite(2);

    expect(await manager.drainReleasePromises(1_000)).toBe(true);
    expect(store.plainUpserts).toBe(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(manager.getSession(SESSION)).not.toBeNull();

    // A second drain (the database answered again) lands the row before it closes.
    expect(await manager.drainReleasePromises(1_000)).toBe(true);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(releases).toEqual([]);
  });
});

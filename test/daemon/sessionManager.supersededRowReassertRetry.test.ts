import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { fixedBackoff } from "../../src/utils/Backoff";
import { BusyRewritePersistence } from "../fakes/BusyRewritePersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "s1";
const DEVICE = "emulator-5554";
const DEVICE_LOSS = `device-disconnected:${DEVICE}`;
const IDLE_WINDOW_MS = 60_000;
const RETRY_DELAY_MS = 500;
const TERMINAL_RETRY_DELAY_MS = 700;

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

  test.each(["first", "retry"])(
    "a peer's terminal row landing during the %s rewrite is left for the next activity write",
    async (attempt) => {
      let landReleaseWrite: (() => void) | undefined;
      if (attempt === "first") {
        landReleaseWrite = await supersededReleaseWithParkedWrite();
      } else {
        await supersededReleaseWithFailingRewrite(1);
      }
      store.duringPlainUpsert = async () => {
        const row = (await store.getSession?.(SESSION))!;
        store.seed({ ...row, status: "released", release_reason: "explicit-release" });
      };

      landReleaseWrite?.();
      if (attempt === "retry") {
        await timer.advanceTimeAsync(RETRY_DELAY_MS);
      }
      await settleMicrotasks();

      expect(store.plainUpserts).toBe(attempt === "first" ? 1 : 2);
      expect(await store.getSession?.(SESSION)).toMatchObject({
        status: "released",
        release_reason: "explicit-release",
      });
      timer.advanceTime(1);
      expect(await refresh()).toBe("TerminalSessionError");
      expect(manager.getSession(SESSION)).toBeNull();
      expect(releases).toEqual(["explicit-release"]);
      await timer.advanceTimeAsync(RETRY_DELAY_MS * 4);
      await settleMicrotasks();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(releases).toEqual(["explicit-release"]);
    },
  );

  test.each(["daemon-peer", "daemon-dead"])(
    "the first rewrite preserves a live peer's row and replaces a dead owner's row: %s",
    async (owner) => {
      manager.attachDaemonSessionId("daemon-1");
      manager.attachLiveDaemonSessionIds(() => new Set(["daemon-1", "daemon-peer"]));
      const landReleaseWrite = await supersededReleaseWithParkedWrite();
      let peerRow: Awaited<ReturnType<NonNullable<typeof store.getSession>>>;
      store.duringPlainUpsert = async () => {
        const row = (await store.getSession?.(SESSION))!;
        peerRow = {
          ...row,
          status: "active",
          release_reason: null,
          daemon_session_id: owner,
          device_id: "peer-device",
        };
        store.seed(peerRow);
      };

      landReleaseWrite();
      await settleMicrotasks();

      if (owner === "daemon-peer") {
        expect(await store.getSession?.(SESSION)).toEqual(peerRow!);
      } else {
        expect(await store.getSession?.(SESSION)).toMatchObject({
          status: "active",
          release_reason: null,
          daemon_session_id: "daemon-1",
          device_id: DEVICE,
        });
      }
      await timer.advanceTimeAsync(RETRY_DELAY_MS * 4);
      await settleMicrotasks();
      expect(store.plainUpserts).toBe(1);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(manager.getSession(SESSION)).not.toBeNull();
      expect(releases).toEqual([]);
      if (owner === "daemon-peer") {
        expect(await store.getSession?.(SESSION)).toEqual(peerRow!);
      }
    },
  );

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

  test("a terminal release landing during a rewrite refuses it without needing a terminal re-write", async () => {
    await supersededReleaseWithFailingRewrite(1);
    let released: Promise<unknown> | undefined;
    store.duringPlainUpsert = async () => {
      released = manager.releaseSession(SESSION, "explicit-release");
      await settleMicrotasks(100);
      // The release's own terminal write has landed; any unnecessary re-write would fail.
      store.failReleaseWrites = 1;
    };

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();
    await released;
    await settleMicrotasks();

    // The guarded rewrite wrote nothing, so the terminal row needs no repair or retry.
    expect(store.plainUpserts).toBe(2);
    expect(store.failReleaseWrites).toBe(1);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "explicit-release",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);

    await timer.advanceTimeAsync(TERMINAL_RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: "explicit-release",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(releases).toEqual(["explicit-release"]);
  });

  test("a first rewrite that is due while a rebind is under way leaves the row to the rebind", async () => {
    const REBOUND_DEVICE = "emulator-5556";
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    // The superseded release's terminal row lands while the rebind's write is in flight.
    store.duringPlainUpsert = async () => {
      landReleaseWrite();
      await settleMicrotasks();
      expect(await store.getSession?.(SESSION)).toMatchObject({ release_reason: DEVICE_LOSS });
    };

    await manager.rebindSession(SESSION, REBOUND_DEVICE, "android");
    await settleMicrotasks();

    // Only the rebind wrote the row, and its landing settled the rewrite: no retry is armed.
    expect(store.plainUpserts).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      device_id: REBOUND_DEVICE,
    });
    expect(releases).toEqual([]);
  });

  test("a rewrite that lands after a rebind's row is issued again for the new binding", async () => {
    const REBOUND_DEVICE = "emulator-5556";
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    // The rebind starts, persists and publishes while the rewrite's write is still in flight.
    store.duringPlainUpsert = async () => {
      await manager.rebindSession(SESSION, REBOUND_DEVICE, "android");
    };

    landReleaseWrite();
    await settleMicrotasks();

    // The scenario was driven: the rewrite landed last, with the binding from before the rebind.
    expect(store.plainUpserts).toBe(2);
    expect(manager.getSession(SESSION)?.assignedDevice).toBe(REBOUND_DEVICE);
    expect(await store.getSession?.(SESSION)).toMatchObject({ device_id: DEVICE });

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(store.plainUpserts).toBe(3);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      device_id: REBOUND_DEVICE,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(releases).toEqual([]);
  });

  test("a terminal write that fails as its release gives up on it at the deadline is still retried", async () => {
    await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    let failReleaseWrite!: () => void;
    store.park = new Promise<void>((resolve) => {
      failReleaseWrite = resolve;
    });
    store.failReleaseWrites = 1;
    const released = manager.releaseSession(SESSION, "explicit-release");
    await settleMicrotasks(100);

    // The deadline passes and the write fails in the same turn, before the session is removed.
    timer.advanceTime(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    failReleaseWrite();
    store.park = undefined;
    await released;
    await settleMicrotasks();

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
  });

  test("a forced release's fence write that fails past its deadline is retried though the release never settles", async () => {
    await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    // A rebind whose write never lands; the release of the session waits on it and is forced.
    store.duringPlainUpsert = () => new Promise<void>(() => {});
    const rebind = manager.rebindSession(SESSION, "emulator-5556", "android");
    await settleMicrotasks(100);
    const released = manager.releaseSession(SESSION, "heartbeat-timeout");
    await settleMicrotasks(100);
    let failFenceWrite!: () => void;
    store.park = new Promise<void>((resolve) => {
      failFenceWrite = resolve;
    });
    store.failReleaseWrites = 1;

    expect(manager.forceStuckRelease(SESSION)?.stage).toBe("awaiting-rebind");
    await settleMicrotasks(100);
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    await settleMicrotasks();
    failFenceWrite();
    store.park = undefined;
    await settleMicrotasks();

    // The scenario was driven: the fence write failed and the stuck release is still pending.
    expect(store.failReleaseWrites).toBe(0);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await store.getSession?.(SESSION)).toMatchObject({ status: "active" });
    expect(await Promise.race([released, rebind, Promise.resolve("pending")])).toBe("pending");
    expect(timer.getPendingTimeouts()).toContain(TERMINAL_RETRY_DELAY_MS);

    await timer.advanceTimeAsync(TERMINAL_RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "expired",
      release_reason: "heartbeat-timeout",
    });
  });

  test("shutdown's drain waits out a rebind that then fails, and rewrites the owed live row", async () => {
    await supersededReleaseWithFailingRewrite(1);
    let failRebindWrite!: () => void;
    store.duringPlainUpsert = async () => {
      await new Promise<void>((resolve) => {
        failRebindWrite = resolve;
      });
      store.failPlainUpserts = 1;
    };
    const rebind = manager.rebindSession(SESSION, "emulator-5556", "android").then(
      () => "rebound",
      () => "failed",
    );
    await settleMicrotasks(100);

    const drained = manager.drainReleasePromises(1_000);
    await settleMicrotasks();
    // The drain's attempt has not written under the rebind, and no retry timer is armed.
    expect(store.plainUpserts).toBe(2);
    expect(await store.getSession?.(SESSION)).toMatchObject({ release_reason: DEVICE_LOSS });

    failRebindWrite();

    expect(await rebind).toBe("failed");
    expect(await drained).toBe(true);
    expect(store.plainUpserts).toBe(3);
    expect(manager.getSession(SESSION)?.assignedDevice).toBe(DEVICE);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      device_id: DEVICE,
    });
    expect(releases).toEqual([]);
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

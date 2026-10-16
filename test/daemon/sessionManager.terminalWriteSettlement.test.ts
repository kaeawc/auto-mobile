import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { createDaemonTerminalReleaseJournal } from "../../src/daemon/terminalReleaseJournal";
import { BusyRewritePersistence } from "../fakes/BusyRewritePersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "s1";
const DEVICE = "emulator-5554";

async function settleMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 200; turn++) {
    await Promise.resolve();
  }
}

describe("terminal release waits for its own row statement settlement (#12547)", () => {
  let timer: FakeTimer;
  let store: BusyRewritePersistence;
  let manager: SessionManager;
  let journal: ReturnType<typeof createDaemonTerminalReleaseJournal>;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    store = new BusyRewritePersistence();
    manager = new SessionManager(timer, store, () => new FakeDbWriteBarrier());
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId("daemon-1");
    await manager.createSession(SESSION, DEVICE, "android", 60_000);
    journal = createDaemonTerminalReleaseJournal({
      dataDir: "/data",
      daemonSessionId: "daemon-1",
      liveDaemonSessionIds: new Set(["daemon-1"]),
      fileSystem: new FakeTerminalReleaseJournalFileSystem(),
    });
    manager.attachTerminalReleaseJournal(journal);
  });

  afterEach(() => {
    manager.stopCleanupTimer();
  });

  /** Let the DB advance, while keeping the actual statement promise unsettled. */
  function withholdActivityStatement(refuseFirst: boolean = false) {
    const landed = Promise.withResolvers<number>();
    const statement = Promise.withResolvers<number>();
    const upsert = store.upsertActiveSession.bind(store);
    store.refuseGuardedUpserts = refuseFirst ? 1 : 0;
    store.upsertActiveSession = (...args) => {
      if (store.refuseGuardedUpserts > 0) {
        return upsert(...args);
      }
      void upsert(...args).then(landed.resolve, statement.reject);
      return statement.promise;
    };
    return { landed: landed.promise, statement };
  }

  /** Observe the classifier's read, without settling the outstanding statement during it. */
  function observeRefusalRead() {
    const read = store.getSession.bind(store);
    let reads = 0;
    store.afterRefusedRelease = () => {
      store.getSession = (sessionId) => {
        store.getSession = read;
        reads++;
        return read(sessionId);
      };
    };
    return () => reads;
  }

  test.each(["first statement", "refusal retry"] as const)(
    "an own activity %s lands before the terminal classifier but settles afterwards",
    async (attempt) => {
      await store.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
      const held = withholdActivityStatement(attempt === "refusal retry");
      timer.advanceTime(1);
      const activity = manager.getOrCreateSession(SESSION);
      const generation = await held.landed;
      const refusalReads = observeRefusalRead();
      let released = false;
      const release = manager.releaseSession(SESSION, "explicit-release").then(() => {
        released = true;
      });
      await settleMicrotasks();
      const beforeSettlement = {
        reads: refusalReads(),
        released,
        status: (await store.getSession(SESSION))?.status,
        owed: journal.loadUnconfirmed().length,
      };

      // Only the test settles it, well after the classifier's read and continuations ran.
      held.statement.resolve(generation);
      await Promise.all([activity, release]);

      expect(beforeSettlement).toEqual({ reads: 1, released: false, status: "active", owed: 1 });
      expect(store.activityUpserts).toBe(attempt === "refusal retry" ? 2 : 1);
      expect(await store.getSession(SESSION)).toMatchObject({
        status: "released",
        release_reason: "explicit-release",
      });
      expect(journal.loadUnconfirmed()).toEqual([]);
      expect(manager.getSession(SESSION)).toBeNull();
    },
  );

  test("a live peer's newer row is re-read after the own statement settles", async () => {
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-1", "daemon-peer"]));
    await store.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
    const held = withholdActivityStatement();
    timer.advanceTime(1);
    const activity = manager.getOrCreateSession(SESSION);
    const generation = await held.landed;
    const refusalReads = observeRefusalRead();
    let released = false;
    const release = manager.releaseSession(SESSION, "explicit-release").then(() => {
      released = true;
    });
    await settleMicrotasks();
    expect(refusalReads()).toBe(1);
    expect(released).toBe(false);
    expect(journal.loadUnconfirmed()).toHaveLength(1);
    const snapshot = manager["terminalReleaseSnapshots"].get(SESSION)!;

    // Replace rather than mutate the fake's row: the classifier already holds the old read.
    const peerRow = {
      ...(await store.getSession(SESSION))!,
      daemon_session_id: "daemon-peer",
      stable_identity_generation: generation + 1,
    };
    store.seed(peerRow);
    // A fresh read proves permanent refusal without another statement. A stale read would
    // retry and turn that refusal into a transient database failure, leaving its intent owed.
    store.failReleaseWrites = 1;
    held.statement.resolve(generation);
    await Promise.all([activity, release]);

    expect(await store.getSession(SESSION)).toMatchObject({
      status: "active",
      daemon_session_id: "daemon-peer",
      stable_identity_generation: generation + 1,
      release_reason: null,
    });
    expect(store.failReleaseWrites).toBe(1);
    expect(manager["refusedReleaseWrites"].has(snapshot)).toBe(true);
    expect(journal.loadUnconfirmed()).toEqual([]);
    expect(manager.getSession(SESSION)).toBeNull();
  });

  test("an older release refuses a different incarnation's unsettled own write (#12515)", async () => {
    const original = manager.getSession(SESSION)!;
    const gate = Promise.withResolvers<void>();
    store.park = gate.promise;
    let superseded = false;
    const release = manager.releaseSessionUnlessSuperseded(
      SESSION,
      `device-disconnected:${DEVICE}`,
      () => !superseded,
    );
    await settleMicrotasks();
    const snapshot = manager["terminalReleaseSnapshots"].get(SESSION)!;
    superseded = true;
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS, settleMicrotasks);
    await expect(release).resolves.toEqual({ superseded: true });
    store.park = undefined;
    await manager.releaseSession(SESSION, "plan-auto-release");
    const replacement = await manager.createSession(SESSION, DEVICE, "android", 60_000);
    expect(replacement).not.toBe(original);

    await store.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
    const held = withholdActivityStatement();
    timer.advanceTime(1);
    const activity = manager.getOrCreateSession(SESSION);
    const generation = await held.landed;
    const refusalReads = observeRefusalRead();
    gate.resolve();
    await settleMicrotasks();
    // A pending write belonging to the replacement must not stall the old release's refusal.
    expect(refusalReads()).toBe(1);
    expect(manager["refusedReleaseWrites"].has(snapshot)).toBe(true);
    expect(await store.getSession(SESSION)).toMatchObject({
      status: "active",
      stable_identity_generation: generation,
      release_reason: null,
    });
    expect(manager.getSession(SESSION)).toBe(replacement);
    expect(journal.loadUnconfirmed()).toEqual([]);
    held.statement.resolve(generation);
    await activity;
    expect(await manager.drainReleasePromises(5_000)).toBe(true);
  });

  test("a wedged own statement reaches the existing deadline with its intent still owed", async () => {
    await store.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
    const held = withholdActivityStatement();
    timer.advanceTime(1);
    // Observe the activity caller without ever settling the statement in this scenario.
    void manager.getOrCreateSession(SESSION);
    await held.landed;
    const refusalReads = observeRefusalRead();
    let released = false;
    const release = manager.releaseSession(SESSION, "explicit-release").then(() => {
      released = true;
    });
    await settleMicrotasks();
    expect(refusalReads()).toBe(1);
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS - 1, settleMicrotasks);
    expect(released).toBe(false);
    expect(journal.loadUnconfirmed()).toHaveLength(1);
    await timer.advanceTimeAsync(1, settleMicrotasks);
    await release;

    expect(released).toBe(true);
    expect(await store.getSession(SESSION)).toMatchObject({ status: "active" });
    expect(journal.loadUnconfirmed()).toHaveLength(1);
    expect(manager.getSession(SESSION)).toBeNull();
  });
});

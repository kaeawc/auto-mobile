import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SUPERSEDED_ROW_REASSERT_RETRY_ATTEMPTS,
  SessionManager,
} from "../../src/daemon/sessionManager";
import { fixedBackoff } from "../../src/utils/Backoff";
import {
  createDaemonTerminalReleaseJournal,
  terminalReleaseJournalPath,
} from "../../src/daemon/terminalReleaseJournal";
import { BusyRewritePersistence } from "../fakes/BusyRewritePersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTerminalReleaseJournalFileSystem } from "../fakes/FakeTerminalReleaseJournalFileSystem";
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

  test.each(["terminal", "active-peer"])(
    "a parked terminal write preserves the peer's %s row",
    async (shape) => {
      manager.attachDaemonSessionId("daemon-1");
      manager.attachLiveDaemonSessionIds(() => new Set(["daemon-1", "daemon-peer"]));
      const landReleaseWrite = await supersededReleaseWithParkedWrite();
      const before = {
        ...(await store.getSession?.(SESSION))!,
        daemon_session_id: "daemon-peer",
        ...(shape === "terminal"
          ? { status: "released" as const, release_reason: "explicit-release" }
          : {}),
      };
      store.seed(structuredClone(before));

      landReleaseWrite();
      await settleMicrotasks();
      await timer.advanceTimeAsync(RETRY_DELAY_MS * 4);
      await settleMicrotasks();

      expect(await store.getSession?.(SESSION)).toEqual(before);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(manager.getSession(SESSION)).not.toBeNull();
      expect(releases).toEqual([]);
      if (shape === "terminal") {
        timer.advanceTime(1);
        expect(await refresh()).toBe("TerminalSessionError");
        expect(manager.getSession(SESSION)).toBeNull();
        expect(releases).toEqual(["explicit-release"]);
        expect(await store.getSession?.(SESSION)).toEqual(before);
      }
    },
  );

  test.each(["terminal", "active-peer"])(
    "a rebind refused over the peer's %s row never publishes its binding",
    async (shape) => {
      manager.attachDaemonSessionId("daemon-1");
      manager.attachLiveDaemonSessionIds(() => new Set(["daemon-1", "daemon-peer"]));
      const session = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
      const before = {
        ...(await store.getSession?.(SESSION))!,
        daemon_session_id: "daemon-peer",
        ...(shape === "terminal"
          ? { status: "released" as const, release_reason: "explicit-release" }
          : {}),
      };
      store.duringPlainUpsert = async () => {
        store.seed(structuredClone(before));
      };

      await expect(
        manager.rebindSession(SESSION, "emulator-5556", "android"),
      ).rejects.toHaveProperty(
        "name",
        shape === "terminal" ? "TerminalSessionError" : "DeviceSessionRowNotRewritableError",
      );

      expect(session.assignedDevice).toBe(DEVICE);
      expect(manager.getSessionForDevice("emulator-5556")).toBeNull();
      expect(await store.getSession?.(SESSION)).toEqual(before);
      expect(manager.getSession(SESSION)).toBe(shape === "terminal" ? null : session);
      expect(releases).toEqual(shape === "terminal" ? ["explicit-release"] : []);
    },
  );

  test("a busy rebind keeps its old binding and a retry without a peer lands", async () => {
    const session = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    store.failPlainUpserts = 1;
    await expect(manager.rebindSession(SESSION, "emulator-5556", "android")).rejects.toThrow(
      "SQLITE_BUSY",
    );
    expect(manager.getSession(SESSION)).toBe(session);
    expect(session.assignedDevice).toBe(DEVICE);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      device_id: DEVICE,
      status: "active",
    });
    expect(releases).toEqual([]);
    await manager.rebindSession(SESSION, "emulator-5556", "android");
    expect(session.assignedDevice).toBe("emulator-5556");
    expect(await store.getSession?.(SESSION)).toMatchObject({
      device_id: "emulator-5556",
      status: "active",
    });
  });

  test.each(["explicit-release", "device-killed"])(
    "a committed terminal upgrade replaces its own earlier reason with %s",
    async (reason) => {
      const session = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
      let land!: () => void;
      store.park = new Promise<void>((resolve) => {
        land = resolve;
      });
      const releasing = manager.releaseSession(SESSION, "cli-idle-timeout");
      await settleMicrotasks();
      const upgrading = manager.releaseSessionIfOwned(SESSION, session, DEVICE, reason);
      await settleMicrotasks();
      store.park = undefined;
      land();
      await Promise.all([releasing, upgrading]);
      expect(await store.getSession?.(SESSION)).toMatchObject({ release_reason: reason });
      expect(manager.getSession(SESSION)).toBeNull();
    },
  );

  test("a finalized terminal reason is upgraded to device-killed in the row too", async () => {
    const session = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    let upgraded: Promise<unknown> | undefined;
    manager.onSessionRelease((_id, _device, reason) => {
      if (reason === "explicit-release") {
        void Promise.resolve()
          .then(() => {})
          .then(() => {})
          .then(() => {
            upgraded = manager.releaseSessionIfOwned(SESSION, session, DEVICE, "device-killed");
          });
      }
    });
    await manager.releaseSession(SESSION, "explicit-release");
    await settleMicrotasks();
    await upgraded;
    expect(upgraded).toBeDefined();
    expect(await store.getSession?.(SESSION)).toMatchObject({ release_reason: "device-killed" });
    expect(releases).toEqual(["explicit-release", "device-killed"]);
  });

  test("a refused superseded release owes no live rewrite", async () => {
    manager.attachDaemonSessionId("daemon-1");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-1", "daemon-peer"]));
    const session = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    let land!: () => void;
    store.park = new Promise<void>((resolve) => {
      land = resolve;
    });
    let superseded = false;
    const released = manager.releaseSessionUnlessSuperseded(
      SESSION,
      DEVICE_LOSS,
      () => !superseded,
    );
    await settleMicrotasks();
    const before = {
      ...(await store.getSession?.(SESSION))!,
      status: "released" as const,
      release_reason: DEVICE_LOSS,
      daemon_session_id: "daemon-peer",
    };
    store.seed(structuredClone(before));
    superseded = true;
    store.park = undefined;
    store.plainUpserts = 0;
    land();
    expect(await released).toEqual({ superseded: true });
    expect(store.plainUpserts).toBe(0);
    expect(await store.getSession?.(SESSION)).toEqual(before);
    expect(manager.getSession(SESSION)).toBe(session);
    expect(releases).toEqual([]);
  });

  test("the shutdown drain joins a refused rebind's terminal adoption", async () => {
    await supersededReleaseWithFailingRewrite(1);
    let land!: () => void;
    store.duringPlainUpsert = () =>
      new Promise<void>((resolve) => {
        land = resolve;
      });
    const rebound = manager.rebindSession(SESSION, "emulator-5556", "android").then(
      () => "rebound",
      (error: unknown) => (error instanceof Error ? error.name : String(error)),
    );
    await settleMicrotasks();
    store.seed({
      ...(await store.getSession?.(SESSION))!,
      status: "released",
      release_reason: "explicit-release",
    });
    let drained = false;
    const drain = manager.drainReleasePromises(1_000).then((result) => {
      drained = true;
      return result;
    });
    await settleMicrotasks();
    let landRelease!: () => void;
    store.park = new Promise<void>((resolve) => {
      landRelease = resolve;
    });
    land();
    await settleMicrotasks();
    expect(drained).toBe(false);
    store.park = undefined;
    landRelease();
    expect(await rebound).toBe("TerminalSessionError");
    expect(await drain).toBe(true);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await store.getSession?.(SESSION)).toMatchObject({ release_reason: "explicit-release" });
  });

  test("a current activity refusal over a live peer preserves the held session", async () => {
    manager.attachDaemonSessionId("daemon-1");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-1", "daemon-peer"]));
    const session = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    await store.markReleased(SESSION, "released", timer.now(), "daemon-restart");
    const before = { ...(await store.getSession?.(SESSION))!, daemon_session_id: "daemon-peer" };
    store.seed(structuredClone(before));
    timer.advanceTime(1);
    expect(await refresh()).toBe("SessionActivityPersistenceError");
    expect(await store.getSession?.(SESSION)).toEqual(before);
    expect(manager.getSession(SESSION)).toBe(session);
    expect(releases).toEqual([]);
  });

  test.each(["peer", "this-daemon"])(
    "an old parked activity re-persist preserves a name re-issued by %s",
    async (owner) => {
      manager.attachDaemonSessionId("daemon-1");
      manager.attachLiveDaemonSessionIds(() => new Set(["daemon-1", "daemon-peer"]));
      const old = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
      await store.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
      let land!: () => void;
      let parked = false;
      store.duringActivityUpsert = () => {
        parked = true;
        return new Promise<void>((resolve) => {
          land = resolve;
        });
      };
      timer.advanceTime(1);
      const activity = refresh();
      await settleMicrotasks();
      expect(parked).toBe(true);
      await manager.releaseSession(SESSION, "plan-auto-release");
      let replacement;
      if (owner === "peer") {
        await store.upsertActiveSession({
          sessionUuid: SESSION,
          deviceId: "peer-device",
          platform: "android",
          daemonSessionId: "daemon-peer",
          createdAtMs: timer.now(),
          lastUsedAtMs: timer.now(),
          expiresAtMs: timer.now() + IDLE_WINDOW_MS,
          sessionTimeoutMs: IDLE_WINDOW_MS,
          heartbeatTimeoutMs: IDLE_WINDOW_MS,
          hasReceivedHeartbeat: true,
        });
      } else {
        replacement = await manager.createSession(
          SESSION,
          "emulator-5556",
          "android",
          IDLE_WINDOW_MS,
        );
        expect(replacement).not.toBe(old);
      }
      const before = structuredClone(await store.getSession?.(SESSION));
      land();
      await activity;
      await settleMicrotasks();
      await timer.advanceTimeAsync(RETRY_DELAY_MS * 4);
      await settleMicrotasks();

      expect(await store.getSession?.(SESSION)).toEqual(before);
      expect(manager.getSession(SESSION)).toBe(replacement ?? null);
      expect(releases).toEqual(["plan-auto-release"]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("a busy activity re-persist keeps the held session and its next write lands without a peer", async () => {
    const session = await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    await store.markReleased(SESSION, "expired", timer.now(), "daemon-restart");
    store.failActivityUpserts = 1;
    timer.advanceTime(1);
    expect(await refresh()).toBe("SessionActivityPersistenceError");
    expect(manager.getSession(SESSION)).toBe(session);
    expect(releases).toEqual([]);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "expired",
      release_reason: "daemon-restart",
    });
    expect(await refresh()).toBe("refreshed");
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      device_id: DEVICE,
    });
  });

  test("failed live-daemon discovery leaves the rewrite owed until guarded discovery succeeds", async () => {
    manager.attachDaemonSessionId("daemon-1");
    const landReleaseWrite = await supersededReleaseWithParkedWrite();
    let discoveryFails = true;
    manager.attachLiveDaemonSessionIds(() => {
      if (discoveryFails) {
        throw new Error("PID-file discovery failed");
      }
      return new Set(["daemon-1", "daemon-peer"]);
    });

    landReleaseWrite();
    await settleMicrotasks();

    expect(store.plainUpserts).toBe(0);
    expect(await store.getSession?.(SESSION)).toMatchObject({ release_reason: DEVICE_LOSS });
    expect(manager.getSession(SESSION)).not.toBeNull();
    expect(releases).toEqual([]);
    expect(timer.getPendingTimeouts()).toContain(RETRY_DELAY_MS);
    discoveryFails = false;
    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();
    expect(store.plainUpserts).toBe(1);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(manager.getSession(SESSION)).not.toBeNull();
    expect(releases).toEqual([]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

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

  /** R2 fences the session long enough to drop R1's owed entry, then is superseded too. */
  async function overlapSupersededRelease(reason: string, failLateWrite = false): Promise<void> {
    let landReleaseWrite!: () => void;
    store.park = new Promise<void>((resolve) => {
      landReleaseWrite = resolve;
    });
    let superseded = false;
    const release = manager.releaseSessionUnlessSuperseded(SESSION, reason, () => !superseded);
    await settleMicrotasks(100);
    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();
    expect(timer.getPendingTimeouts()).not.toContain(RETRY_DELAY_MS);
    superseded = true;
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    expect(await release).toEqual({ superseded: true });
    store.park = undefined;
    store.failReleaseWrites = failLateWrite ? 1 : 0;
    landReleaseWrite();
    await settleMicrotasks();
    expect(store.failReleaseWrites).toBe(0);
    await timer.advanceTimeAsync(RETRY_DELAY_MS * 4);
    await settleMicrotasks();
  }

  test.each(["cli-idle-timeout", "heartbeat-timeout"])(
    "overlapping superseded %s preserves the live session after a busy rewrite",
    async (reason) => {
      await supersededReleaseWithFailingRewrite(1);
      await overlapSupersededRelease(reason, reason === "heartbeat-timeout");

      expect(await store.getSession?.(SESSION)).toMatchObject({
        status: "active",
        release_reason: null,
      });
      expect(await refresh()).toBe("refreshed");
      expect(manager.getSession(SESSION)).not.toBeNull();
      expect(releases).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("an unrelated terminal release after overlapping superseded releases still ends the session", async () => {
    await supersededReleaseWithFailingRewrite(1);
    await overlapSupersededRelease("cli-idle-timeout");
    expect(await store.getSession?.(SESSION)).toMatchObject({ status: "active" });
    const row = (await store.getSession?.(SESSION))!;
    store.seed({ ...row, status: "released", release_reason: "explicit-release" });
    timer.advanceTime(1);

    expect(await refresh()).toBe("TerminalSessionError");
    expect(manager.getSession(SESSION)).toBeNull();
    expect(releases).toEqual(["explicit-release"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a new incarnation of the same UUID does not remember the old superseded reasons", async () => {
    await supersededReleaseWithFailingRewrite(1);
    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();
    const old = manager.getSession(SESSION);
    await manager.releaseSession(SESSION, "plan-auto-release");
    await manager.createSession(SESSION, DEVICE, "android", IDLE_WINDOW_MS);
    expect(manager.getSession(SESSION)).not.toBe(old);
    releases.length = 0;

    // This incarnation supersedes only idle expiry; the old incarnation's device loss is foreign.
    store.duringPlainUpsert = async () => {
      const row = (await store.getSession?.(SESSION))!;
      store.seed({ ...row, status: "released", release_reason: DEVICE_LOSS });
    };
    await overlapSupersededRelease("cli-idle-timeout");
    timer.advanceTime(1);

    expect(await refresh()).toBe("TerminalSessionError");
    expect(manager.getSession(SESSION)).toBeNull();
    expect(releases).toEqual([DEVICE_LOSS]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an owed retry adopts a dead owner's journal-only terminal release before rewriting", async () => {
    await supersededReleaseWithFailingRewrite(1);
    const files = new FakeTerminalReleaseJournalFileSystem();
    const live = new Set(["daemon-1", "daemon-peer"]);
    manager.attachDaemonSessionId("daemon-1");
    manager.attachLiveDaemonSessionIds(() => live);
    const options = { dataDir: "/data", fileSystem: files, liveDaemonSessionIds: live };
    const peer = createDaemonTerminalReleaseJournal({ ...options, daemonSessionId: "daemon-peer" });
    peer.record({ sessionId: SESSION, reason: "explicit-release", at: timer.now() });
    const journal = createDaemonTerminalReleaseJournal({ ...options, daemonSessionId: "daemon-1" });
    manager.attachTerminalReleaseJournal(journal);
    const row = (await store.getSession?.(SESSION))!;
    store.seed({
      ...row,
      status: "active",
      release_reason: null,
      daemon_session_id: "daemon-peer",
    });
    live.delete("daemon-peer");
    store.failReleaseWrites = 1;

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(store.failReleaseWrites).toBe(0);
    expect(store.plainUpserts).toBe(1);
    expect(files.files.has(terminalReleaseJournalPath("/data", "daemon-peer"))).toBe(true);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
      daemon_session_id: "daemon-peer",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(releases).toEqual([]);
    // The retry stopped on the journal intent even though its row write failed.
    await manager.applyRecoveredTerminalReleaseIntents();
    timer.advanceTime(1);
    expect(await refresh()).toBe("TerminalSessionError");
    expect(manager.getSession(SESSION)).toBeNull();
    expect(releases).toEqual(["explicit-release"]);
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

  test("a same-reason terminal row whose re-write fails is retried with the terminal release backoff", async () => {
    await supersededReleaseWithFailingRewrite(1);
    let released: Promise<unknown> | undefined;
    store.duringPlainUpsert = async () => {
      released = manager.releaseSession(SESSION, DEVICE_LOSS);
      await settleMicrotasks(100);
      store.failReleaseWrites = 1;
    };

    await timer.advanceTimeAsync(RETRY_DELAY_MS);
    await settleMicrotasks();
    await released;
    await settleMicrotasks();

    expect(store.failReleaseWrites).toBe(0);
    expect(timer.getPendingTimeouts()).toEqual([TERMINAL_RETRY_DELAY_MS]);
    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(manager.getSession(SESSION)).toBeNull();

    await timer.advanceTimeAsync(TERMINAL_RETRY_DELAY_MS);
    await settleMicrotasks();

    expect(await store.getSession?.(SESSION)).toMatchObject({
      status: "released",
      release_reason: DEVICE_LOSS,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(releases).toEqual([DEVICE_LOSS]);
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

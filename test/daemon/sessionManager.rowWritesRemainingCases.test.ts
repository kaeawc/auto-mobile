import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import type { Kysely } from "kysely";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SessionManager,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import {
  DeviceSessionNotActiveError,
  DeviceSessionRepository,
} from "../../src/db/deviceSessionRepository";
import type { TerminalReleaseIntent } from "../../src/daemon/terminalReleaseJournal";
import type { Database } from "../../src/db/types";
import { runWithAbortSignal } from "../../src/utils/AbortContext";
import { fixedBackoff } from "../../src/utils/Backoff";
import { logger } from "../../src/utils/logger";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "row-writes";
const DEVICE = "emulator-5554";
const PLAN = "plan-auto-release";
const RETRY_MS = 700;

async function settle(turns = 40): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
}

// Deferred seams park statements, never host I/O; the repository still executes the real SQL guards.
class DeferredRowRepository extends DeviceSessionRepository {
  activityGate?: Promise<void>;
  activityGates: Promise<void>[] = [];
  activityEntered?: (count: number) => void;
  rewriteGate?: Promise<void>;
  failRewrites = 0;
  liveRowRewrites = 0;
  releaseGate?: Promise<void>;
  releaseGates: Promise<void>[] = [];
  releaseEntered?: (count: number) => void;
  ownershipGate?: Promise<void>;
  ownershipEntered?: () => void;
  beforeOwnership?: () => Promise<void>;
  failReleases = 0;
  activityUpserts = 0;
  releases: string[] = [];
  releaseGenerations: (number | undefined)[] = [];

  override async upsertActiveSession(
    ...args: Parameters<DeviceSessionRepository["upsertActiveSession"]>
  ): Promise<number> {
    if (args[2]?.unlessTerminal) {
      this.activityUpserts++;
      this.activityEntered?.(this.activityUpserts);
      await (this.activityGates.shift() ?? this.activityGate);
    } else if (args[2]?.rewriteOverSupersededRelease) {
      this.liveRowRewrites++;
      await this.rewriteGate;
      if (this.failRewrites > 0) {
        this.failRewrites--;
        throw new Error("SQLITE_BUSY: database is locked");
      }
    }
    return await super.upsertActiveSession(...args);
  }

  override async replaceLivenessOwnership(
    ...args: Parameters<DeviceSessionRepository["replaceLivenessOwnership"]>
  ): Promise<void> {
    this.ownershipEntered?.();
    this.ownershipEntered = undefined;
    const hook = this.beforeOwnership;
    this.beforeOwnership = undefined;
    await hook?.();
    await this.ownershipGate;
    await super.replaceLivenessOwnership(...args);
  }

  override async markReleased(
    ...args: Parameters<DeviceSessionRepository["markReleased"]>
  ): Promise<void> {
    this.releases.push(args[3]);
    this.releaseGenerations.push(args[4]?.expectedRowGeneration);
    this.releaseEntered?.(this.releases.length);
    await (this.releaseGates.shift() ?? this.releaseGate);
    if (this.failReleases > 0) {
      this.failReleases--;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    await super.markReleased(...args);
  }
}

describe("remaining session row writes (#11557)", () => {
  let db: Kysely<Database>;
  let store: DeferredRowRepository;
  let peer: DeviceSessionRepository;
  let timer: FakeTimer;
  let manager: SessionManager;
  let announced: string[];

  beforeAll(async () => {
    db = await createTestDatabase();
    // Warm lifecycle modules and SQL statements once; cold initialization is not the race under test.
    const warmTimer = new FakeTimer();
    const warmStore = new DeferredRowRepository(db, warmTimer);
    const warmManager = new SessionManager(warmTimer, warmStore, {
      barrier: () => new FakeDbWriteBarrier(),
    });
    warmManager.stopCleanupTimer();
    try {
      await warmManager.createSession("warm-row-writes", DEVICE, "android", 60_000);
      await warmStore.markStaleActiveSessionsExpired("peer", warmTimer.now(), "daemon-restart");
      warmTimer.advanceTime(1);
      await warmManager.getOrCreateSession("warm-row-writes");
      await warmManager.releaseSession("warm-row-writes", PLAN);
    } finally {
      warmManager.stopCleanupTimer();
    }
  });
  afterAll(async () => await db.destroy());
  beforeEach(async () => {
    await db.deleteFrom("device_sessions").execute();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    store = new DeferredRowRepository(db, timer);
    peer = new DeviceSessionRepository(db, timer);
    manager = new SessionManager(timer, store, { barrier: () => new FakeDbWriteBarrier() });
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId("daemon-1");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-1", "daemon-peer"]));
    manager.setTerminalReleaseRetryBackoff(fixedBackoff(RETRY_MS));
    announced = [];
    manager.onSessionRelease((_id, _device, reason) => announced.push(reason));
  });
  afterEach(() => {
    manager.stopCleanupTimer();
  });

  const row = () => store.getSession(SESSION);
  const create = () => manager.createSession(SESSION, DEVICE, "android", 60_000);
  async function sweep(): Promise<void> {
    await peer.markStaleActiveSessionsExpired(
      "daemon-peer",
      timer.now(),
      "daemon-restart",
      new Set(["daemon-peer"]),
    );
  }
  async function refresh(): Promise<string> {
    timer.advanceTime(1);
    return await manager.getOrCreateSession(SESSION).then(
      () => "refreshed",
      (error: unknown) => (error instanceof Error ? error.name : String(error)),
    );
  }
  const pool = (): SessionDeviceAssigner => ({
    async assignDeviceToSession(id) {
      return (await manager.createSession(id, DEVICE, "android", 60_000)).assignedDevice;
    },
  });
  const reissue = () => manager.getOrCreateSession(SESSION, pool(), "android", undefined, true);

  test("a refused superseded release repairs an earlier superseded release's late terminal row", async () => {
    timer.setCurrentTime(41_000);
    const session = await create();
    const reason = `device-disconnected:${DEVICE}`;
    manager.setSupersededRowReassertBackoff(fixedBackoff(200));
    const firstWrite = Promise.withResolvers<void>();
    const secondWrite = Promise.withResolvers<void>();
    const restoreWrite = Promise.withResolvers<void>();
    const retryUpsert = Promise.withResolvers<void>();
    store.releaseGates = [firstWrite.promise, secondWrite.promise, restoreWrite.promise];
    store.failRewrites = 1;
    let firstSuperseded = false;
    const first = manager.releaseSessionUnlessSuperseded(SESSION, reason, () => !firstSuperseded);
    await settle();
    expect(store.releases).toEqual([reason]);
    firstSuperseded = true;
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    expect(await first).toEqual({ superseded: true });
    expect(store.liveRowRewrites).toBe(1);
    expect(timer.getPendingTimeouts()).toEqual([200]);

    store.rewriteGate = retryUpsert.promise;
    await timer.advanceTimeAsync(200);
    await settle();
    expect(store.liveRowRewrites).toBe(2);
    let secondSuperseded = false;
    const second = manager.releaseSessionUnlessSuperseded(SESSION, reason, () => !secondSuperseded);
    await settle();
    expect(store.releases).toEqual([reason, reason]);
    await timer.advanceTimeAsync(40);
    const restoring = Promise.withResolvers<void>();
    store.releaseEntered = (count) => {
      if (count === 3) {
        restoring.resolve();
      }
    };
    store.rewriteGate = undefined;
    retryUpsert.resolve();
    await restoring.promise;
    expect(await row()).toMatchObject({ status: "active", stable_identity_generation: 1 });
    expect(store.releases).toEqual([reason, reason, reason]);

    await timer.advanceTimeAsync(60);
    firstWrite.resolve();
    // Generation resolution re-reads the row before issuing its conditioned retry.
    await settle(120);
    expect(await row()).toMatchObject({ status: "released", release_reason: reason });
    await timer.advanceTimeAsync(840);
    restoreWrite.resolve();
    await settle();
    // R2's restore is refused over R1's terminal row; R2 still waits on its original statement.
    expect(await row()).toMatchObject({ status: "released", release_reason: reason });
    secondSuperseded = true;
    await timer.advanceTimeAsync(9_060);
    expect(await second).toEqual({ superseded: true });
    secondWrite.resolve();
    await settle();
    expect(await manager.drainReleasePromises(1_000)).toBe(true);
    const settledRow = await row();
    timer.advanceTime(1);
    expect(await manager.getOrCreateSession(SESSION)).toBe(session);
    expect(manager.getSession(SESSION)).toBe(session);
    expect(settledRow).toMatchObject({
      status: "active",
      release_reason: null,
      device_id: DEVICE,
    });
    expect(await row()).toMatchObject({
      status: "active",
      release_reason: null,
      device_id: DEVICE,
    });
    expect(announced).toEqual([]);
    expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a losing activity repair rejects its caller without ending the live session", async () => {
    const session = await create();
    const generation = (await row())!.stable_identity_generation;
    await sweep();
    await db
      .updateTable("device_sessions")
      .set({ daemon_session_id: "daemon-dead" })
      .where("session_uuid", "=", SESSION)
      .execute();
    const firstRetry = Promise.withResolvers<void>();
    const secondRetry = Promise.withResolvers<void>();
    store.activityGates = [
      Promise.resolve(),
      firstRetry.promise,
      Promise.resolve(),
      secondRetry.promise,
    ];
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const firstRetryEntered = Promise.withResolvers<void>();
      store.activityEntered = (count) => {
        if (count === 2) {
          firstRetryEntered.resolve();
        }
      };
      timer.advanceTime(1);
      const first = manager.getOrCreateSession(SESSION);
      await firstRetryEntered.promise;
      expect(store.activityUpserts).toBe(2);
      const firstActivity = {
        lastUsedAt: session.lastUsedAt,
        lastHeartbeat: session.lastHeartbeat,
        expiresAt: session.expiresAt,
      };
      timer.advanceTime(1);
      const secondRetryEntered = Promise.withResolvers<void>();
      store.activityEntered = (count) => {
        if (count === 4) {
          secondRetryEntered.resolve();
        }
      };
      const second = manager.getOrCreateSession(SESSION).then(
        () => "resolved",
        (error: unknown) => error,
      );
      await secondRetryEntered.promise;
      expect(store.activityUpserts).toBe(4);
      firstRetry.resolve();
      expect(await first).toBe(session);
      expect(await row()).toMatchObject({ stable_identity_generation: generation + 1 });
      secondRetry.resolve();
      expect(await second).toMatchObject({
        name: "SessionActivityPersistenceError",
        cause: expect.objectContaining({ name: "DeviceSessionRowNotRewritableError" }),
      });
      expect(session).toMatchObject(firstActivity);
      expect(manager.getSession(SESSION)).toBe(session);
      expect(announced).toEqual([]);
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toBeUndefined();
      expect(await row()).toMatchObject({
        status: "active",
        release_reason: null,
        daemon_session_id: "daemon-1",
        device_id: DEVICE,
        stable_identity_generation: generation + 1,
      });
      expect(warn.mock.calls.map(([message]) => message)).toEqual([
        `[SessionManager] Session ${SESSION} is live but its row is not active; re-persisting it`,
        `[SessionManager] Session ${SESSION} is live but its row is not active; re-persisting it`,
      ]);
      timer.advanceTime(1);
      expect(await manager.getOrCreateSession(SESSION)).toBe(session);
      expect(store.activityUpserts).toBe(4);
      expect(await row()).toMatchObject({
        status: "active",
        daemon_session_id: "daemon-1",
        device_id: DEVICE,
        stable_identity_generation: generation + 1,
        last_used_at_ms: session.lastUsedAt,
      });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      firstRetry.resolve();
      secondRetry.resolve();
      warn.mockRestore();
    }
  });

  test.each(["own", "unowned"])(
    "a parked plan release cannot overwrite the shutdown upgrade or arm another write (owner: %s)",
    async (owner) => {
      await create();
      manager.attachLiveDaemonSessionIds(() => {
        throw new Error("an own-row release must not discover peers");
      });
      const reads = spyOn(store, "getSession");
      const gate = Promise.withResolvers<void>();
      store.releaseGate = gate.promise;
      const plan = manager.releaseSession(SESSION, PLAN);
      await settle();
      expect(store.releases).toEqual([PLAN]);
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      const handoff = manager.releaseSession(SESSION, "daemon-shutdown");
      store.releaseGate = undefined;
      await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
      await Promise.all([plan, handoff]);
      expect(announced).toEqual([PLAN, "daemon-shutdown"]);
      expect(store.releases).toEqual([PLAN, "daemon-shutdown"]);
      if (owner === "unowned") {
        await db
          .updateTable("device_sessions")
          .set({ daemon_session_id: null })
          .where("session_uuid", "=", SESSION)
          .execute();
      }
      const shutdownRow = await row();
      expect(shutdownRow).toMatchObject({ release_reason: "daemon-shutdown" });
      expect(timer.getPendingTimeoutCount()).toBe(0);
      // The deadline warning happened already; the late statement refusal itself is silent.
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        let drained = false;
        const drain = manager.drainReleasePromises(1_000).then((result) => {
          drained = true;
          return result;
        });
        await settle();
        expect(drained).toBe(false);
        gate.resolve();
        expect(await drain).toBe(true);
        expect(await row()).toEqual(shutdownRow);
        expect(warn).not.toHaveBeenCalled();
        expect(timer.getPendingTimeoutCount()).toBe(0);
        await timer.advanceTimeAsync(RETRY_MS);
        await settle();
        expect(store.releases).toEqual([PLAN, "daemon-shutdown"]);
        expect(announced).toEqual([PLAN, "daemon-shutdown"]);
      } finally {
        gate.resolve();
        warn.mockRestore();
      }
    },
  );

  test("the shutdown upgrade still lands after the parked plan write lands first", async () => {
    await create();
    const gate = Promise.withResolvers<void>();
    store.releaseGate = gate.promise;
    const plan = manager.releaseSession(SESSION, PLAN);
    await settle();
    const handoff = manager.releaseSession(SESSION, "daemon-shutdown");
    gate.resolve();
    await Promise.all([plan, handoff]);
    expect(await row()).toMatchObject({ release_reason: "daemon-shutdown" });
    expect(announced).toEqual([PLAN, "daemon-shutdown"]);
    expect(store.releases).toEqual([PLAN, "daemon-shutdown"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an explicit release still replaces the shutdown handoff row", async () => {
    await create();
    await manager.releaseSession(SESSION, "daemon-shutdown");
    await manager.releaseSession(SESSION, "explicit-release");
    expect(await row()).toMatchObject({ release_reason: "explicit-release" });
    expect(announced).toEqual(["daemon-shutdown", "explicit-release"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a failed shutdown upgrade retries without the parked plan's condition", async () => {
    await create();
    const gate = Promise.withResolvers<void>();
    store.releaseGate = gate.promise;
    const plan = manager.releaseSession(SESSION, PLAN);
    await settle();
    const handoff = manager.releaseSession(SESSION, "daemon-shutdown");
    store.releaseGate = undefined;
    store.failReleases = 1;
    await timer.advanceTimeAsync(SESSION_RELEASE_PERSIST_TIMEOUT_MS);
    await Promise.all([plan, handoff]);
    await settle();
    expect(timer.getPendingTimeouts()).toEqual([RETRY_MS]);
    // Another shutdown handoff already landed before the retry: equal-reason writes stay legal.
    await peer.markReleased(SESSION, "released", timer.now(), "daemon-shutdown");
    await timer.advanceTimeAsync(RETRY_MS);
    await settle();
    gate.resolve();
    expect(await manager.drainReleasePromises(1_000)).toBe(true);
    expect(await row()).toMatchObject({ release_reason: "daemon-shutdown" });
    expect(store.releases).toEqual([PLAN, "daemon-shutdown", "daemon-shutdown"]);
    expect(announced).toEqual([PLAN, "daemon-shutdown"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["active", "daemon-restart", `device-restart:${DEVICE}`])(
    "a plan release still lands on its own generation's %s row",
    async (reason) => {
      await create();
      const generation = (await row())!.stable_identity_generation;
      if (reason === "daemon-restart") {
        await sweep();
      } else if (reason !== "active") {
        await peer.markReleased(SESSION, "released", timer.now(), reason);
      }
      await manager.releaseSession(SESSION, PLAN);
      expect(await row()).toMatchObject({
        status: "released",
        release_reason: PLAN,
        stable_identity_generation: generation,
      });
      expect(store.releases).toEqual([PLAN]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("a parked activity repair refuses its own released row without warning, compensation or retry", async () => {
    await create();
    await sweep();
    const gate = Promise.withResolvers<void>();
    store.activityGate = gate.promise;
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const activity = refresh();
      await settle();
      expect(store.activityUpserts).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        `[SessionManager] Session ${SESSION} is live but its row is not active; re-persisting it`,
      );
      warn.mockClear();
      await manager.releaseSession(SESSION, "daemon-shutdown");
      expect(store.releases).toEqual(["daemon-shutdown"]);
      const released = await row();
      gate.resolve();
      await activity;
      await settle();
      expect(await row()).toEqual(released);
      expect(store.releases).toEqual(["daemon-shutdown"]);
      expect(warn).not.toHaveBeenCalled();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      gate.resolve();
      warn.mockRestore();
    }
  });

  test("a release refused by the repair's newer generation is compensated before the drain finishes", async () => {
    await create();
    await sweep();
    const upsert = Promise.withResolvers<void>();
    const ownership = Promise.withResolvers<void>();
    const ownershipEntered = Promise.withResolvers<void>();
    store.ownershipEntered = ownershipEntered.resolve;
    const releaseRow = Promise.withResolvers<void>();
    store.activityGate = upsert.promise;
    store.ownershipGate = ownership.promise;
    const activity = refresh();
    await settle();
    store.releaseGate = releaseRow.promise;
    const release = manager.releaseSession(SESSION, "daemon-shutdown");
    await settle();
    expect(store.releases).toEqual(["daemon-shutdown"]);
    upsert.resolve();
    await ownershipEntered.promise;
    expect(await row()).toMatchObject({ status: "active" });
    store.releaseGate = undefined;
    releaseRow.resolve();
    await release;
    let drained = false;
    const drain = manager.drainReleasePromises(1_000).then((result) => {
      drained = true;
      return result;
    });
    await settle();
    expect(drained).toBe(false);
    ownership.resolve();
    await activity;
    expect(await drain).toBe(true);
    expect(store.releases).toEqual(["daemon-shutdown", "daemon-shutdown"]);
    expect(await row()).toMatchObject({ status: "released", release_reason: "daemon-shutdown" });
    await settle();
    expect(store.releases).toHaveLength(2);
  });

  test("activity repair still revives a peer sweep's expired row while its owner is live", async () => {
    const session = await create();
    await sweep();
    expect(await row()).toMatchObject({ status: "expired" });
    expect(await refresh()).toBe("refreshed");
    expect(await row()).toMatchObject({ status: "active", daemon_session_id: "daemon-1" });
    expect(manager.getSession(SESSION)).toBe(session);
    expect(store.releases).toEqual([]);
  });

  test("the drain waits for activity refusal and its terminal adoption, with no writes after it", async () => {
    await create();
    await sweep();
    const gate = Promise.withResolvers<void>();
    store.activityGate = gate.promise;
    const activity = refresh();
    await settle();
    await peer.markReleased(SESSION, "released", timer.now(), "owner-disconnected");
    await db
      .updateTable("device_sessions")
      .set({ daemon_session_id: "daemon-peer" })
      .where("session_uuid", "=", SESSION)
      .execute();
    let drained = false;
    const drain = manager.drainReleasePromises(1_000).then((result) => {
      drained = true;
      return result;
    });
    await settle();
    expect(drained).toBe(false);
    gate.resolve();
    expect(await drain).toBe(true);
    expect(await activity).toBe("TerminalSessionError");
    expect(manager.getSession(SESSION)).toBeNull();
    const writesAtDrain = store.releases.length;
    await settle();
    expect(store.releases.length).toBe(writesAtDrain);
    expect(store.releases).toEqual(["owner-disconnected"]);
    expect(await row()).toMatchObject({ release_reason: "owner-disconnected" });
  });

  test("a wedged activity repair cannot extend the drain deadline", async () => {
    await create();
    await sweep();
    const gate = Promise.withResolvers<void>();
    store.activityGate = gate.promise;
    const activity = refresh();
    await settle();
    const drain = manager.drainReleasePromises(50);
    await timer.advanceTimeAsync(50);
    expect(await drain).toBe(false);
    // The drain timed out, but the SQL guard still fences a repair landing after release.
    await manager.releaseSession(SESSION, "daemon-shutdown");
    gate.resolve();
    await activity;
    await settle();
    expect(store.releases).toEqual(["daemon-shutdown"]);
    expect(await row()).toMatchObject({ status: "released", release_reason: "daemon-shutdown" });
  });

  test("a failed unpublished creation retires the generation its upsert wrote", async () => {
    const failure = new DeviceSessionNotActiveError(SESSION);
    store.beforeOwnership = async () => {
      throw failure;
    };
    await expect(create()).rejects.toBe(failure);
    expect(manager.getSession(SESSION)).toBeNull();
    expect(await row()).toMatchObject({
      status: "released",
      release_reason: "allocation-rollback",
    });
    expect(await store.listRecoverableSessions()).toEqual([]);
    expect(announced).toEqual([]);
  });

  test("a sweep between a re-issue's statements rolls its row back to the claimed plan reason", async () => {
    await create();
    await manager.releaseSession(SESSION, PLAN);
    store.beforeOwnership = sweep;
    await expect(reissue()).rejects.toBeInstanceOf(DeviceSessionNotActiveError);
    expect(await row()).toMatchObject({ status: "released", release_reason: PLAN });
    expect(await store.listRecoverableSessions()).toEqual([]);
    expect(announced).toEqual([PLAN]);
  });

  test("a rollback storage failure stays owed and is retried without replacing the creation error", async () => {
    const failure = new DeviceSessionNotActiveError(SESSION);
    store.beforeOwnership = async () => {
      throw failure;
    };
    store.failReleases = 1;
    await expect(create()).rejects.toBe(failure);
    await settle();
    expect(await row()).toMatchObject({ status: "active" });
    expect(timer.getPendingTimeouts()).toEqual([RETRY_MS]);
    await timer.advanceTimeAsync(RETRY_MS);
    await settle();
    expect(await row()).toMatchObject({
      status: "released",
      release_reason: "allocation-rollback",
    });
    expect(store.releases).toEqual(["allocation-rollback", "allocation-rollback"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a failed creation cannot roll back a newer peer incarnation", async () => {
    const failure = new DeviceSessionNotActiveError(SESSION);
    store.beforeOwnership = async () => {
      await peer.upsertActiveSession({
        sessionUuid: SESSION,
        deviceId: "emulator-5556",
        platform: "android",
        daemonSessionId: "daemon-peer",
        createdAtMs: 1_000,
        lastUsedAtMs: 1_000,
        expiresAtMs: 61_000,
        sessionTimeoutMs: 60_000,
        heartbeatTimeoutMs: 60_000,
        hasReceivedHeartbeat: false,
      });
      throw failure;
    };
    await expect(create()).rejects.toBe(failure);
    expect(await row()).toMatchObject({
      status: "active",
      daemon_session_id: "daemon-peer",
      device_id: "emulator-5556",
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a successful creation writes no release", async () => {
    const session = await create();
    expect(manager.getSession(SESSION)).toBe(session);
    expect(await row()).toMatchObject({ status: "active" });
    expect(store.releases).toEqual([]);
  });

  test.each([false, true])(
    "a plan re-issue refused at shutdown restores the plan row (upsert landed: %p)",
    async (landed) => {
      await create();
      await manager.releaseSession(SESSION, PLAN);
      if (landed) {
        store.beforeOwnership = async () => {
          manager.stopAcceptingSessionCreations();
        };
      }
      const assigner: SessionDeviceAssigner = {
        async assignDeviceToSession(id) {
          const creating = manager.createSession(id, DEVICE, "android", 60_000);
          if (!landed) {
            manager.stopAcceptingSessionCreations();
          }
          return (await creating).assignedDevice;
        },
      };
      const writesBefore = store.releases.length;
      await expect(
        manager.getOrCreateSession(SESSION, assigner, "android", undefined, true),
      ).rejects.toMatchObject({
        name: "DaemonSessionCreationRejectedError",
        release: expect.objectContaining({ releaseReason: "daemon-shutdown", terminal: true }),
      });
      expect(announced).toEqual([PLAN, "daemon-shutdown"]);
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toMatchObject({
        releaseReason: "daemon-shutdown",
        terminal: true,
      });
      expect(await row()).toMatchObject({ status: "released", release_reason: PLAN });
      expect(store.releases.length).toBe(writesBefore + (landed ? 1 : 0));
      expect(await store.listRecoverableSessions()).toEqual([]);
    },
  );

  test.each([
    ["daemon-shutdown", false],
    ["daemon-shutdown", true],
    [PLAN, false],
    [PLAN, true],
  ] as const)(
    "a cancelled recovery terminalizes its %s row (upsert landed: %p)",
    async (reason, landed) => {
      await manager.createSession(SESSION, DEVICE, "android", 60_000, undefined, "stable-row");
      await manager.releaseSession(SESSION, reason);
      announced.length = 0;
      const controller = new AbortController();
      const failure = new Error("client cancelled");
      if (landed) {
        store.beforeOwnership = async () => controller.abort(failure);
      }
      const assigner: SessionDeviceAssigner = {
        async assignDeviceToSession(id) {
          const creating = manager.createSession(id, DEVICE, "android", 60_000);
          if (!landed) {
            controller.abort(failure);
          }
          return (await creating).assignedDevice;
        },
      };
      const writesBefore = store.releases.length;
      await expect(
        runWithAbortSignal(controller.signal, () =>
          manager.getOrCreateSession(SESSION, assigner, "android", undefined, true),
        ),
      ).rejects.toBe(failure);
      expect(await row()).toMatchObject({
        status: "released",
        release_reason: "session-creation-cancelled",
      });
      expect(announced).toEqual(["session-creation-cancelled"]);
      expect(store.releases.slice(writesBefore)).toEqual(["session-creation-cancelled"]);
      expect(store.releaseGenerations.slice(writesBefore)).toEqual([undefined]);
      expect(manager.getTerminalReleaseSnapshot(SESSION)).toMatchObject({ terminal: true });
      const later = new SessionManager(timer, peer, { barrier: () => new FakeDbWriteBarrier() });
      later.stopCleanupTimer();
      later.attachDaemonSessionId("daemon-later");
      later.attachLiveDaemonSessionIds(() => new Set(["daemon-later"]));
      try {
        await expect(later.createSession(SESSION, DEVICE, "android", 60_000)).rejects.toMatchObject(
          {
            name: "TerminalSessionError",
            release: expect.objectContaining({ releaseReason: "session-creation-cancelled" }),
          },
        );
      } finally {
        later.stopCleanupTimer();
      }
    },
  );

  test.each([`device-restart:${DEVICE}`, "daemon-shutdown"])(
    "a failed recovery preserves its claimed %s release time",
    async (reason) => {
      await manager.createSession(SESSION, DEVICE, "android", 60_000, undefined, "stable-row");
      await manager.releaseSession(SESSION, reason);
      const claimed = await row();
      timer.advanceTime(100);
      // A new daemon reads persisted stamps on its own session clock, including after a wall step.
      manager.stopCleanupTimer();
      manager = new SessionManager(timer, store, { barrier: () => new FakeDbWriteBarrier() });
      manager.stopCleanupTimer();
      manager.attachDaemonSessionId("daemon-recovery");
      manager.attachLiveDaemonSessionIds(() => new Set(["daemon-recovery"]));
      timer.stepWallClock(200);
      const failure = new DeviceSessionNotActiveError(SESSION);
      store.beforeOwnership = async () => {
        timer.advanceTime(100);
        throw failure;
      };
      await expect(reissue()).rejects.toBe(failure);
      expect(await row()).toMatchObject({
        status: "released",
        release_reason: reason,
        released_at_ms: claimed!.released_at_ms,
      });
      expect(await store.listRecoverableSessions()).toHaveLength(1);
    },
  );

  test("a new creation refused after upsert keeps the shutdown row with its generation guard", async () => {
    store.beforeOwnership = async () => {
      manager.stopAcceptingSessionCreations();
    };
    await expect(create()).rejects.toMatchObject({ name: "DaemonSessionCreationRejectedError" });
    expect(await row()).toMatchObject({ status: "released", release_reason: "daemon-shutdown" });
    expect(announced).toEqual(["daemon-shutdown"]);
  });

  test("shutdown plan rollback records and resolves no terminal journal intent", async () => {
    await create();
    await manager.releaseSession(SESSION, PLAN);
    const intents: TerminalReleaseIntent[] = [];
    const recorded: string[] = [];
    const resolved: string[] = [];
    manager.attachTerminalReleaseJournal({
      loadUnconfirmed: () => intents,
      record(intent) {
        intents.push(intent);
        recorded.push(intent.reason);
        return "volatile";
      },
      resolve(_id, reason) {
        resolved.push(reason!);
        intents.splice(0, intents.length);
      },
    });
    store.beforeOwnership = async () => {
      manager.stopAcceptingSessionCreations();
    };
    store.failReleases = 1;
    await expect(reissue()).rejects.toMatchObject({ name: "DaemonSessionCreationRejectedError" });
    await settle();
    expect(recorded).toEqual([]);
    expect(intents).toEqual([]);
    expect(resolved).toEqual([]);
    await timer.advanceTimeAsync(RETRY_MS);
    await settle();
    expect(await row()).toMatchObject({ release_reason: PLAN });
    expect(recorded).toEqual([]);
    expect(resolved).toEqual([]);
    expect(intents).toEqual([]);
  });

  test("a second sweep after the upsert settles starts another repair before the first caller resumes", async () => {
    await create();
    await sweep();
    const gate = Promise.withResolvers<void>();
    store.ownershipGate = gate.promise;
    const entered = Promise.withResolvers<void>();
    store.ownershipEntered = entered.resolve;
    const first = refresh();
    await entered.promise;
    expect(store.activityUpserts).toBe(1);
    expect(await row()).toMatchObject({ status: "active" });
    await sweep();
    const secondEntered = Promise.withResolvers<void>();
    store.ownershipEntered = secondEntered.resolve;
    const second = refresh();
    await settle();
    expect(store.activityUpserts).toBe(2);
    await secondEntered.promise;
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual(["refreshed", "refreshed"]);
    expect(await row()).toMatchObject({ status: "active" });
  });

  test("overlapping activity writes still share one in-flight upsert", async () => {
    await create();
    await sweep();
    const gate = Promise.withResolvers<void>();
    store.activityGate = gate.promise;
    const first = refresh();
    await settle();
    const second = refresh();
    await settle();
    expect(store.activityUpserts).toBe(1);
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual(["refreshed", "refreshed"]);
    expect(store.activityUpserts).toBe(1);
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  ManagedExecutionRelease,
  type ManagedExecutionSessions,
  type ManagedExecutionWork,
} from "../../../../src/daemon/managedSlots/managedExecutionRelease";
import { SlotJournalInFlight } from "../../../../src/daemon/managedSlots/slotJournal";
import {
  InFlightSlotReservations,
  withLiveExecutionSessions,
} from "../../../../src/daemon/managedSlots/slotOwnerLiveness";
import type {
  SlotExecOwnerLiveness,
  SlotKey,
  SlotRegistry,
} from "../../../../src/daemon/managedSlots/slotRegistry";
import { openSqliteSlotRegistry } from "../../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { logger } from "../../../../src/utils/logger";
import { FakeSlotRegistry } from "../../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Hunt (managed slots, third pass). The end-of-execution drain's slot bookkeeping is single-shot
// against the host-wide registry, which several daemons share and which surfaces contention as a
// thrown busy error (the trigger #11339 and #11545 accepted as realistic):
//
// 1. The settlement watcher returns a `settling` slot to `ready` with ONE registry read and ONE
//    write once the released work has settled. If either throws, `restoreReady` logs "it stays
//    settling" and reports `done`, so the watcher ends. Nothing else returns the slot: the journal
//    redrive blocks on "the slot's settler is still watching its work" (the settler is this live
//    daemon), `recoverSettledSlots` needs a dead settler, and `reset-slot-scope --force` refuses
//    inside the 5-minute cap. Every later execution of the slot gets `slot_settling` although the
//    work it waits for ended long ago. #11608 made the watcher re-check a slot a live owner record
//    still holds; a failed read or write is not re-checked.
//
// 2. The drain's `settling` mark is also attempted once. If it throws, the drain goes on to
//    release the session and clear the slot's owner, so the slot is `ready` and unowned while the
//    execution's cancelled work is still running: the fence the drain exists to place is missing
//    and the next execution claims the slot at once.

const DAEMON_PID = 4242;
const SETTLER = { daemonId: "daemon-a", pid: DAEMON_PID, processGenerationToken: "linux:boot:1" };
const S1 = "session-1";
const S2 = "session-2";
const DEVICE = "emulator-5554";
const AVD = "amslot-test-0-g1";
const BINDING = { generation: 1, stableDeviceId: AVD };
const SCOPE = {
  managedHostScope: "host",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};

type RegistryMethod = "getAssignment" | "advanceSlotJournal" | "openSlotJournal";

/** The host-wide registry under contention: the next `fail[method]` calls throw busy. */
function makeBusy(registry: SlotRegistry): Record<RegistryMethod, number> {
  const fail: Record<RegistryMethod, number> = {
    getAssignment: 0,
    advanceSlotJournal: 0,
    openSlotJournal: 0,
  };
  const busyOnce = (method: RegistryMethod): void => {
    if (fail[method] > 0) {
      fail[method] -= 1;
      throw new Error("SQLITE_BUSY: database is locked");
    }
  };
  const getAssignment = registry.getAssignment.bind(registry);
  registry.getAssignment = async (key) => {
    busyOnce("getAssignment");
    return getAssignment(key);
  };
  const advanceSlotJournal = registry.advanceSlotJournal.bind(registry);
  registry.advanceSlotJournal = async (id, input) => {
    busyOnce("advanceSlotJournal");
    return advanceSlotJournal(id, input);
  };
  const openSlotJournal = registry.openSlotJournal.bind(registry);
  registry.openSlotJournal = async (key, input) => {
    busyOnce("openSlotJournal");
    return openSlotJournal(key, input);
  };
  return fail;
}

type RegistryFactory = (
  timer: FakeTimer,
  liveness: SlotExecOwnerLiveness,
) => SlotRegistry | Promise<SlotRegistry>;

const REGISTRIES: Array<[string, RegistryFactory]> = [
  ["FakeSlotRegistry", (timer, liveness) => new FakeSlotRegistry(timer, liveness)],
  [
    "SqliteSlotRegistry (:memory:)",
    (timer, liveness) =>
      openSqliteSlotRegistry({ dbPath: ":memory:", timer, isExecOwnerLive: liveness }),
  ],
];

class FakeWork implements ManagedExecutionWork {
  readonly active = new Map<string, number>();

  constructor(private readonly timer: FakeTimer) {}

  async cancelDeviceSessionExecutions(sessionId: string): Promise<number> {
    // The action ignores its abort: cancelled work keeps running.
    return this.active.get(sessionId) ?? 0;
  }

  async waitForDeviceSessionExecutionsToEnd(
    sessionId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!this.active.has(sessionId)) {
      return true;
    }
    await this.timer.sleep(timeoutMs);
    return !this.active.has(sessionId);
  }

  hasActiveDeviceSessionExecutions(sessionId: string): boolean {
    return this.active.has(sessionId);
  }
}

class FakeSessions implements ManagedExecutionSessions {
  readonly live = new Map<string, string>();

  isSessionLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  deviceOf(sessionId: string): string | null {
    return this.live.get(sessionId) ?? null;
  }

  async releaseSession(sessionId: string): Promise<string | null> {
    const device = this.live.get(sessionId) ?? null;
    this.live.delete(sessionId);
    return device;
  }

  async forceStuckRelease(): Promise<boolean> {
    return false;
  }

  hasDeviceCleanupInProgress(): boolean {
    return false;
  }
}

describe.each(REGISTRIES)(
  "the drain's slot bookkeeping under a busy registry: %s",
  (_name, open) => {
    let timer: FakeTimer;
    let registry: SlotRegistry;
    let fail: Record<RegistryMethod, number>;
    let work: FakeWork;
    let sessions: FakeSessions;
    let drain: ManagedExecutionRelease;
    let key: SlotKey;
    let warn: ReturnType<typeof spyOn>;

    beforeEach(async () => {
      timer = new FakeTimer();
      timer.setCurrentTime(1_000_000);
      timer.enableAutoAdvance();
      work = new FakeWork(timer);
      sessions = new FakeSessions();
      // The daemon's own wiring (daemon.ts managedSlotOwnerLiveness): this process is alive, and a
      // record it wrote is judged by its session alone.
      const liveness = withLiveExecutionSessions(
        (owner) => owner.pid === DAEMON_PID,
        { isLiveManagedExecutionSession: (sessionUuid) => sessions.live.has(sessionUuid) },
        { thisProcess: { pid: DAEMON_PID }, reservations: new InFlightSlotReservations() },
      );
      registry = await open(timer, liveness);
      fail = makeBusy(registry);
      drain = new ManagedExecutionRelease({
        registry: async () => registry,
        journal: { inFlight: new SlotJournalInFlight() },
        settler: SETTLER,
        work,
        sessions,
        timer,
        isExecOwnerLive: liveness,
      });
      warn = spyOn(logger, "warn").mockImplementation(() => {});

      const scope = await registry.ensureScope(SCOPE);
      if (scope.kind !== "ready") {
        throw new Error(`scope not ready: ${scope.kind}`);
      }
      key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
      await registry.initSlot(key, { role: "primary", platform: "android", requestedSpec: {} });
      await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: AVD,
          deviceName: AVD,
          resolvedSpec: {},
          specFingerprint: "fp",
          state: "ready",
        },
      );
      const claimed = await registry.claimExecution(key, BINDING, {
        daemonId: SETTLER.daemonId,
        pid: DAEMON_PID,
        sessionUuid: S1,
      });
      expect(claimed.kind).toBe("claimed");
      sessions.live.set(S1, DEVICE);
    });

    afterEach(async () => {
      drain.close();
      await drain.whenIdle();
      warn.mockRestore();
      await registry.close();
    });

    /** Execution 1 ends with one cancelled action still running: the slot is fenced `settling`. */
    async function releaseWithUnsettledWork(): Promise<void> {
      work.active.set(S1, 1);
      const result = await drain.releaseExecution(S1);
      expect(result).toMatchObject({ outcome: "cleanup_pending", settlement: "settling" });
      expect(result.slotFailures).toEqual([]);
      expect(await registry.getAssignment(key)).toMatchObject({
        state: "settling",
        execOwner: null,
      });
    }

    /** Execution 2's claim of the slot, as the reconciler makes it. */
    async function claimForNextExecution() {
      const current = (await registry.getAssignment(key))!;
      return registry.claimExecution(
        key,
        { generation: current.generation, stableDeviceId: current.stableDeviceId },
        { daemonId: SETTLER.daemonId, pid: DAEMON_PID, sessionUuid: S2 },
      );
    }

    test("control: the watcher returns the slot to ready when its work settles", async () => {
      await releaseWithUnsettledWork();

      work.active.delete(S1);
      await drain.whenIdle();

      expect(await registry.getAssignment(key)).toMatchObject({ state: "ready", execOwner: null });
      expect(await registry.listOpenSlotJournal(key)).toEqual([]);
      expect((await claimForNextExecution()).kind).toBe("claimed");
    });

    test.each<[RegistryMethod, string]>([
      ["advanceSlotJournal", "the write that returns the slot to ready"],
      ["getAssignment", "the read before it"],
    ])("one busy error on %s (%s) must not leave the settled slot settling", async (method) => {
      await releaseWithUnsettledWork();

      // The released work ends; the registry is busy for the watcher's one attempt.
      fail[method] = 1;
      work.active.delete(S1);
      await drain.whenIdle();

      // The registry is free again and the watcher has finished. Nothing is still running for
      // session 1, so the slot must be claimable by the next execution.
      expect(fail[method]).toBe(0);
      expect(work.hasActiveDeviceSessionExecutions(S1)).toBe(false);
      const slot = await registry.getAssignment(key);
      expect(slot).toMatchObject({ state: "ready", execOwner: null });
      expect(await registry.listOpenSlotJournal(key)).toEqual([]);
      expect((await claimForNextExecution()).kind).toBe("claimed");
    });

    test("a busy settling mark must not leave the slot ready and unowned under running work", async () => {
      work.active.set(S1, 1);
      fail.openSlotJournal = 1;

      const result = await drain.releaseExecution(S1);

      // The drain itself reports the work unsettled...
      expect(result).toMatchObject({ outcome: "cleanup_pending", settlement: "settling" });
      expect(work.hasActiveDeviceSessionExecutions(S1)).toBe(true);
      // ...so the slot must not be handed to the next execution while that work runs.
      const next = await claimForNextExecution();
      expect(next.kind).not.toBe("claimed");
    });
  },
);

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  MANAGED_EXECUTION_SETTLEMENT_CAP_MS,
  ManagedExecutionRelease,
  type ManagedExecutionSessions,
  type ManagedExecutionWork,
} from "../../../src/daemon/managedSlots/managedExecutionRelease";
import { SlotJournalInFlight } from "../../../src/daemon/managedSlots/slotJournal";
import {
  InFlightSlotReservations,
  withLiveExecutionSessions,
} from "../../../src/daemon/managedSlots/slotOwnerLiveness";
import type {
  SlotExecOwnerLiveness,
  SlotKey,
  SlotRegistry,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { openSqliteSlotRegistry } from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { SlotScopeReset } from "../../../src/daemon/managedSlots/slotScopeReset";
import { logger } from "../../../src/utils/logger";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

// #11545 item 1 (found by the second managed-slots hunt): #11456 judges an owner record this daemon wrote by its
// session, so a record whose clear failed (SQLITE_BUSY on the host-wide registry, the trigger
// #11339 accepted as realistic) no longer pins a `ready` slot. A slot the drain marked `settling`
// before that failed clear was still pinned: the settlement watcher (#11456) and
// `reset-slot-scope --force` (#11517) both tested `execOwner !== null` instead of owner liveness,
// so the dead session's leftover record read as "the slot gained an execution" / "the slot is in
// use". The slot then stayed `settling` (its release journal entry open and guarded in flight) for
// the daemon's lifetime, and the scope could never be reset. Both now judge the record by the
// registry's liveness predicate; a live owner is still never cut.

const DAEMON_PID = 4242;
const SETTLER = { daemonId: "daemon-a", pid: DAEMON_PID, processGenerationToken: "linux:boot:1" };
const S1 = "session-1";
const DEVICE = "emulator-5554";
const AVD = "amslot-test-0-g1";
const BINDING = { generation: 1, stableDeviceId: AVD };
const SCOPE = {
  managedHostScope: "host",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};

/** The host-wide registry under contention: the next `failReleases` owner clears throw busy. */
interface BusyReleases {
  failReleases: number;
}

function makeReleasesBusy(registry: SlotRegistry): BusyReleases {
  const busy: BusyReleases = { failReleases: 0 };
  const release = registry.releaseExecution.bind(registry);
  registry.releaseExecution = async (key, sessionUuid) => {
    if (busy.failReleases > 0) {
      busy.failReleases -= 1;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return release(key, sessionUuid);
  };
  return busy;
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
  "a settling slot whose owner clear failed (#11545): %s",
  (_name, open) => {
    let timer: FakeTimer;
    let registry: SlotRegistry;
    let busy: BusyReleases;
    let work: FakeWork;
    let sessions: FakeSessions;
    let inFlight: SlotJournalInFlight;
    let drain: ManagedExecutionRelease;
    let liveness: SlotExecOwnerLiveness;
    let key: SlotKey;
    let warn: ReturnType<typeof spyOn>;

    beforeEach(async () => {
      timer = new FakeTimer();
      timer.setCurrentTime(1_000_000);
      timer.enableAutoAdvance();
      work = new FakeWork(timer);
      sessions = new FakeSessions();
      // The daemon's own wiring (daemon.ts openManagedSlotRegistry): this process is alive, and a
      // record it wrote is judged by its session alone.
      liveness = withLiveExecutionSessions(
        (owner) => owner.pid === DAEMON_PID,
        { isLiveManagedExecutionSession: (sessionUuid) => sessions.live.has(sessionUuid) },
        { thisProcess: { pid: DAEMON_PID }, reservations: new InFlightSlotReservations() },
      );
      registry = await open(timer, liveness);
      busy = makeReleasesBusy(registry);
      inFlight = new SlotJournalInFlight();
      drain = new ManagedExecutionRelease({
        registry: async () => registry,
        journal: { inFlight },
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

    /** Release S1 with one action still running; the registry is busy for the owner clear. */
    async function releaseWithFailedOwnerClear(): Promise<void> {
      work.active.set(S1, 1);
      busy.failReleases = 1;
      const result = await drain.releaseExecution(S1);
      // Preconditions: the slot was fenced `settling`, the clear failed, and the session is gone, so
      // the leftover record names no live execution by the daemon's own liveness rule (#11339).
      expect(result).toMatchObject({ outcome: "cleanup_pending", settlement: "settling" });
      expect(result.slotFailures).toHaveLength(1);
      const left = await registry.getAssignment(key);
      expect(left).toMatchObject({ state: "settling", execOwner: { sessionUuid: S1 } });
      expect(sessions.isSessionLive(S1)).toBe(false);
      expect(liveness(left!.execOwner!)).toBe(false);
    }

    function newReset(): SlotScopeReset {
      return new SlotScopeReset({
        registry: async () => registry,
        timer,
        isExecOwnerLive: liveness,
      });
    }

    const RESET = {
      runnerNamespace: SCOPE.runnerNamespace,
      runnerIncarnation: SCOPE.runnerIncarnation,
      waitMs: 0,
      force: true,
    };

    test("returns to ready once the released work settles, with the dead record cleared", async () => {
      await releaseWithFailedOwnerClear();

      work.active.delete(S1);
      await drain.whenIdle();

      expect(await registry.getAssignment(key)).toMatchObject({ state: "ready", execOwner: null });
      expect(await registry.listOpenSlotJournal(key)).toEqual([]);
    });

    test("returns to ready even when the retried owner clear fails again", async () => {
      await releaseWithFailedOwnerClear();
      busy.failReleases = 1;

      work.active.delete(S1);
      await drain.whenIdle();

      // The dead record stays, and pins nothing: the next execution claims the ready slot (#11339).
      const restored = await registry.getAssignment(key);
      expect(restored).toMatchObject({ state: "ready", execOwner: { sessionUuid: S1 } });
      expect(await registry.listOpenSlotJournal(key)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Retrying the owner clear"),
        expect.any(Error),
      );
      const next = await registry.claimExecution(
        key,
        { generation: restored!.generation, stableDeviceId: AVD },
        { daemonId: SETTLER.daemonId, pid: DAEMON_PID, sessionUuid: "session-2" },
      );
      expect(next.kind).toBe("claimed");
    });

    test("a leftover owner that is live again is never cleared and keeps the slot settling", async () => {
      await releaseWithFailedOwnerClear();
      // The same session is held by this daemon again before the work settles.
      sessions.live.set(S1, DEVICE);

      work.active.delete(S1);
      await drain.whenIdle();

      expect(await registry.getAssignment(key)).toMatchObject({
        state: "settling",
        execOwner: { sessionUuid: S1 },
      });
      expect(await registry.listOpenSlotJournal(key)).toHaveLength(1);
    });

    test("reset-slot-scope --force past the cap overrides it: the leftover owner is not a live execution", async () => {
      await releaseWithFailedOwnerClear();
      // The released work never settles: exactly the stuck settlement --force exists for.
      drain.close();
      await drain.whenIdle();
      timer.setCurrentTime(timer.now() + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);

      const forced = await newReset().reset(RESET);

      expect(forced.scopes[0]?.pending?.liveOwners ?? []).toEqual([]);
      expect(forced.outcome).toBe("invalidated");
    });

    test("--force inside the cap says how long remains instead of skipping the slot (#11539)", async () => {
      await releaseWithFailedOwnerClear();
      drain.close();
      await drain.whenIdle();

      const forced = await newReset().reset(RESET);

      expect(forced.outcome).toBe("pending");
      expect(forced.scopes[0]?.forceRefusals?.map((refusal) => refusal.reason)).toEqual([
        "within_settlement_cap",
      ]);
      expect((await registry.getAssignment(key))?.state).toBe("settling");
    });

    test("--force past the cap never cuts a settling slot whose owner is live", async () => {
      await releaseWithFailedOwnerClear();
      drain.close();
      await drain.whenIdle();
      sessions.live.set(S1, DEVICE);
      timer.setCurrentTime(timer.now() + MANAGED_EXECUTION_SETTLEMENT_CAP_MS);

      const forced = await newReset().reset(RESET);

      expect(forced.outcome).toBe("pending");
      expect(forced.scopes[0]?.pending?.liveOwners).toEqual([
        { slotIndex: 0, sessionUuid: S1, pid: DAEMON_PID },
      ]);
      expect(await registry.getAssignment(key)).toMatchObject({
        state: "settling",
        execOwner: { sessionUuid: S1 },
      });
      expect(await registry.listOpenSlotJournal(key)).toHaveLength(1);
    });
  },
);

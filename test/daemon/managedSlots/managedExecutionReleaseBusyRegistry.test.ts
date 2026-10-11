import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../../src/daemon/managedExecutionLiveness";
import {
  ManagedExecutionRelease,
  type ManagedExecutionReleaseOptions,
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
import { SlotScopeReset } from "../../../src/daemon/managedSlots/slotScopeReset";
import { openSqliteSlotRegistry } from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { logger } from "../../../src/utils/logger";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";

// The end-of-execution drain's slot bookkeeping against the host-wide registry, which several
// daemons share and which surfaces contention as a thrown busy error (the trigger #11339 and
// #11545 accepted as realistic). #11616 found two single-shot steps:
//
// 1. The settlement watcher returned a `settling` slot to `ready` with ONE registry read and ONE
//    write once the released work had settled. If either threw, the watcher ended and nothing
//    else returned the slot: the journal redrive leaves a live settler's entry alone,
//    `recoverSettledSlots` needs a dead settler, and `reset-slot-scope --force` refuses inside
//    the 5-minute cap.
//
// 2. The drain's `settling` mark was attempted once. If it threw, the drain went on to release
//    the session and clear the slot's owner, so the slot was `ready` and unowned while the
//    execution's cancelled work was still running.
//
// The table at the end states the invariant for every registry step of the drain.

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

/** Every registry method the drain and its settlement watcher call. */
const DRAIN_STEPS = [
  "findExecutionAssignments",
  "openSlotJournal",
  "updateSlotState",
  "releaseExecution",
  "getAssignment",
  "advanceSlotJournal",
] as const;
type RegistryMethod = (typeof DRAIN_STEPS)[number];

/** How long each method stays busy: a number of calls, or until a fake time. */
interface Busy {
  calls: Record<RegistryMethod, number>;
  untilMs: Partial<Record<RegistryMethod, number>>;
}

/**
 * The host-wide registry under contention, as the drain sees it: a busy method throws. The
 * registry itself is untouched, so a test reads and claims through it without tripping a fault.
 */
function makeBusy(registry: SlotRegistry, timer: FakeTimer): { busy: Busy; faulty: SlotRegistry } {
  const busy: Busy = {
    calls: {
      findExecutionAssignments: 0,
      openSlotJournal: 0,
      updateSlotState: 0,
      releaseExecution: 0,
      getAssignment: 0,
      advanceSlotJournal: 0,
    },
    untilMs: {},
  };
  const isStep = (name: string | symbol): name is RegistryMethod =>
    DRAIN_STEPS.some((step) => step === name);
  const faulty = new Proxy(registry, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]): Promise<unknown> => {
        if (isStep(property)) {
          const until = busy.untilMs[property];
          if (busy.calls[property] > 0 || (until !== undefined && timer.now() < until)) {
            busy.calls[property] = Math.max(0, busy.calls[property] - 1);
            throw new Error("SQLITE_BUSY: database is locked");
          }
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  return { busy, faulty };
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
    let busy: Busy;
    let faulty: SlotRegistry;
    let liveness: SlotExecOwnerLiveness;
    let ownerHolds: InFlightSlotReservations;
    const drains: ManagedExecutionRelease[] = [];
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
      // record it wrote is judged by its session alone, or by a hold the drain keeps on it (the
      // daemon shares one process-wide set between its liveness and the drain).
      ownerHolds = new InFlightSlotReservations();
      liveness = withLiveExecutionSessions(
        (owner) => owner.pid === DAEMON_PID,
        { isLiveManagedExecutionSession: (sessionUuid) => sessions.live.has(sessionUuid) },
        { thisProcess: { pid: DAEMON_PID }, reservations: ownerHolds },
      );
      registry = await open(timer, liveness);
      ({ busy, faulty } = makeBusy(registry, timer));
      fail = busy.calls;
      drain = newDrain();
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
      for (const each of drains.splice(0)) {
        each.close();
        await each.whenIdle();
      }
      warn.mockRestore();
      await registry.close();
    });

    function newDrain(overrides: Partial<ManagedExecutionReleaseOptions> = {}) {
      const created = new ManagedExecutionRelease({
        registry: async () => faulty,
        journal: { inFlight: new SlotJournalInFlight() },
        settler: SETTLER,
        work,
        sessions,
        timer,
        isExecOwnerLive: liveness,
        ownerHolds,
        ...overrides,
      });
      drains.push(created);
      return created;
    }

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

    // The drain's invariant, for every registry step it takes and every way that step can be
    // busy: a slot is never claimable while released work runs, and once nothing is running
    // and the drain is idle the slot is `ready` and claimable, its release entry closed.
    const CAP_MS = 8_000;
    const SLOW_POLL_MS = 2_000;
    const TABLE = (["explicit release", "release by the session manager"] as const).flatMap(
      (path) =>
        DRAIN_STEPS.flatMap((step) =>
          (["succeeds", "throws once", "throws until the cap"] as const).flatMap((mode) =>
            (
              [
                ["ends inside the cap", 3_000],
                ["outlives the cap", CAP_MS + 3_000],
              ] as const
            ).map(([work, workMs]) => ({ path, step, mode, work, workMs })),
          ),
        ),
    );

    /** A table drain with a short cap; `updateSlotState` is the unjournaled mark and restore. */
    function newTableDrain(step: RegistryMethod): ManagedExecutionRelease {
      return newDrain({
        settlementCapMs: CAP_MS,
        settlementSlowPollMs: SLOW_POLL_MS,
        ...(step === "updateSlotState" ? { journal: undefined } : {}),
      });
    }

    /** Execution 2 asks for the slot twice a second for as long as execution 1's work runs. */
    async function claimedWhileWorkRuns(): Promise<boolean> {
      while (work.active.has(S1)) {
        if ((await claimForNextExecution()).kind === "claimed") {
          return true;
        }
        await timer.sleep(500);
      }
      return false;
    }

    function releasedBySessionManager(tableDrain: ManagedExecutionRelease): void {
      sessions.live.delete(S1);
      tableDrain.onSessionReleased({
        sessionId: S1,
        deviceId: DEVICE,
        livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY,
      });
    }

    test.each(TABLE)(
      "$path, $step $mode, work $work: never claimable under running work, ready once idle",
      async ({ path, step, mode, workMs }) => {
        const tableDrain = newTableDrain(step);
        work.active.set(S1, 1);
        busy.calls[step] = mode === "throws once" ? 1 : 0;
        if (mode === "throws until the cap") {
          busy.untilMs[step] = timer.now() + CAP_MS;
        }
        timer.setTimeout(() => work.active.delete(S1), workMs);
        const claimedUnderWork = claimedWhileWorkRuns();

        let released = true;
        if (path === "explicit release") {
          released = await tableDrain.releaseExecution(S1).then(
            () => true,
            () => false,
          );
        } else {
          releasedBySessionManager(tableDrain);
        }

        expect(await claimedUnderWork).toBe(false);
        await tableDrain.whenIdle();
        expect(work.hasActiveDeviceSessionExecutions(S1)).toBe(false);
        // An explicit release whose slot lookup is busy fails closed: it rejects before it
        // cancels or releases anything, and the execution keeps its slot.
        const failedClosed = path === "explicit release" && step === "findExecutionAssignments";
        expect(released).toBe(!(failedClosed && mode !== "succeeds"));
        expect(sessions.live.has(S1)).toBe(!released);
        sessions.live.delete(S1);
        expect(await registry.getAssignment(key)).toMatchObject({ state: "ready" });
        expect(await registry.listOpenSlotJournal(key)).toEqual([]);
        expect((await claimForNextExecution()).kind).toBe("claimed");
      },
    );

    test.each(DRAIN_STEPS)(
      "%s busy until the cap under work that never ends: still fenced past the cap, and --force recovers the slot or says why not",
      async (step) => {
        const tableDrain = newTableDrain(step);
        work.active.set(S1, 1);
        busy.untilMs[step] = timer.now() + CAP_MS;
        releasedBySessionManager(tableDrain);

        await timer.sleep(CAP_MS + 2 * SLOW_POLL_MS + 500);
        expect((await claimForNextExecution()).kind).not.toBe("claimed");

        const reset = new SlotScopeReset({
          registry: async () => registry,
          timer,
          isExecOwnerLive: liveness,
          thisProcess: { pid: DAEMON_PID },
          settlementCapMs: CAP_MS,
        });
        const result = await reset.reset({
          runnerNamespace: SCOPE.runnerNamespace,
          runnerIncarnation: SCOPE.runnerIncarnation,
          waitMs: 0,
          force: true,
        });
        const refusals = result.scopes[0]?.forceRefusals ?? [];
        expect(result.outcome === "invalidated" || refusals.length > 0).toBe(true);
        expect(refusals.map((refusal) => refusal.reason)).toEqual(
          refusals.map(() => expect.stringMatching(/^(live_owner|within_settlement_cap)$/)),
        );
        expect(refusals.every((refusal) => refusal.message.length > 0)).toBe(true);
        work.active.delete(S1);
      },
    );
  },
);

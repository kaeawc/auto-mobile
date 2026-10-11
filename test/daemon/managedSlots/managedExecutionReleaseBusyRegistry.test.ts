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
//
// Follow-up findings, same table:
//
// 3. The hold that keeps an owed mark's owner record live was read only for records carrying
//    THIS daemon's pid, and only by this daemon. A record still naming a previous (dead) daemon,
//    or another running one, was claimable under running work. The drain now re-stamps such a
//    record with itself before it marks, so every daemon reads the hold from the registry.
// 4. A mark whose transaction committed and whose call then rejected left the slot `settling`
//    with no watcher.
// 5. Closing the drain dropped the hold while the released work was still running.

const DAEMON_PID = 4242;
/** The daemon this one replaced: exited, its records not re-owned yet. */
const PREVIOUS_DAEMON_PID = 4100;
/** A second daemon running on the host. */
const OTHER_DAEMON_PID = 4300;
/** A daemon started while this one is still shutting down. */
const NEXT_DAEMON_PID = 4400;
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
/** Plus the re-stamp of an owner record that another daemon wrote. */
const HOLD_STEPS = [...DRAIN_STEPS, "claimExecution"] as const;
type RegistryMethod = (typeof HOLD_STEPS)[number];

/** How long each method stays busy: a number of calls, or until a fake time. */
interface Busy {
  calls: Record<RegistryMethod, number>;
  untilMs: Partial<Record<RegistryMethod, number>>;
  /** Calls that reach the registry (the write commits) and then reject. */
  commitsThenThrows: Record<RegistryMethod, number>;
}

const noCalls = (): Record<RegistryMethod, number> => ({
  findExecutionAssignments: 0,
  openSlotJournal: 0,
  updateSlotState: 0,
  releaseExecution: 0,
  getAssignment: 0,
  advanceSlotJournal: 0,
  claimExecution: 0,
});

/**
 * The host-wide registry under contention, as the drain sees it: a busy method throws. The
 * registry itself is untouched, so a test reads and claims through it without tripping a fault.
 */
function makeBusy(registry: SlotRegistry, timer: FakeTimer): { busy: Busy; faulty: SlotRegistry } {
  const busy: Busy = { calls: noCalls(), untilMs: {}, commitsThenThrows: noCalls() };
  const isStep = (name: string | symbol): name is RegistryMethod =>
    HOLD_STEPS.some((step) => step === name);
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
          if (busy.commitsThenThrows[property] > 0) {
            busy.commitsThenThrows[property] -= 1;
            await Reflect.apply(value, target, args);
            throw new Error("SQLITE_BUSY: database is locked (after the commit)");
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
    /** The daemon whose view the registry judges owners by; this daemon unless a test says so. */
    let judge: SlotExecOwnerLiveness;
    /** The daemon processes running on the host. */
    let alive: Set<number>;
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
      alive = new Set([DAEMON_PID, OTHER_DAEMON_PID, NEXT_DAEMON_PID]);
      liveness = withLiveExecutionSessions(
        (owner) => alive.has(owner.pid),
        { isLiveManagedExecutionSession: (sessionUuid) => sessions.live.has(sessionUuid) },
        { thisProcess: { pid: DAEMON_PID }, reservations: ownerHolds },
      );
      judge = liveness;
      registry = await open(timer, (owner) => judge(owner));
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
      return claimAs(DAEMON_PID);
    }

    /**
     * Owner liveness as another daemon on the host judges it: it shares the registry and the
     * process table, and none of this daemon's sessions or in-memory holds.
     */
    function viewOf(pid: number): SlotExecOwnerLiveness {
      if (pid === DAEMON_PID) {
        return liveness;
      }
      return withLiveExecutionSessions(
        (owner) => alive.has(owner.pid),
        { isLiveManagedExecutionSession: () => false },
        { thisProcess: { pid }, reservations: new InFlightSlotReservations() },
      );
    }

    /** Run one registry call as the daemon `pid` would: the registry judges owners its way. */
    async function asDaemon<T>(pid: number, call: () => Promise<T>): Promise<T> {
      judge = viewOf(pid);
      try {
        return await call();
      } finally {
        judge = liveness;
      }
    }

    /** Execution 2's claim of the slot through the daemon `pid`. */
    async function claimAs(pid: number) {
      const current = (await registry.getAssignment(key))!;
      return asDaemon(pid, () =>
        registry.claimExecution(
          key,
          { generation: current.generation, stableDeviceId: current.stableDeviceId },
          { daemonId: `daemon-${pid}`, pid, sessionUuid: `${S2}-${pid}` },
        ),
      );
    }

    /** Session 1's owner record as the daemon `pid` wrote it (this daemon holds the session). */
    async function recordOwnedBy(pid: number): Promise<void> {
      const stamped = await registry.claimExecution(
        key,
        BINDING,
        { daemonId: `daemon-${pid}`, pid, sessionUuid: S1 },
        { supersedesSessionUuid: S1 },
      );
      expect(stamped.kind).toBe("claimed");
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
    /** Whose pid session 1's owner record carries when its execution is released. */
    const OWNERS = [
      ["this daemon", DAEMON_PID],
      ["the previous daemon (dead)", PREVIOUS_DAEMON_PID],
      ["another running daemon", OTHER_DAEMON_PID],
    ] as const;
    const MODES = [
      "succeeds",
      "throws once",
      "commits then throws",
      "throws until the cap",
      "throws until a cap after the work ends",
    ] as const;
    const TABLE = (["explicit release", "release by the session manager"] as const)
      .flatMap((path) =>
        OWNERS.flatMap(([owner, ownerPid]) =>
          // A record this daemon wrote is never re-stamped: that row would be vacuous.
          HOLD_STEPS.filter((step) => step !== "claimExecution" || ownerPid !== DAEMON_PID).flatMap(
            (step) =>
              MODES.flatMap((mode) =>
                (
                  [
                    ["ends inside the cap", 3_000],
                    ["outlives the cap", CAP_MS + 3_000],
                  ] as const
                ).map(([work, workMs]) => ({ path, owner, ownerPid, step, mode, work, workMs })),
              ),
          ),
        ),
      )
      // The watcher's read and write first run when the work ends. Busy only until a cap the
      // work outlives, they would never be busy when called: that row would be vacuous too (the
      // "cap after the work ends" mode is the one that faults them).
      .filter(
        ({ step, mode, workMs }) =>
          !(
            (step === "getAssignment" || step === "advanceSlotJournal") &&
            mode === "throws until the cap" &&
            workMs > CAP_MS
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

    /**
     * Execution 2 asks for the slot twice a second, through each daemon of `views`, for as long
     * as execution 1's work runs. Resolves to the pid of the daemon that handed the slot out.
     *
     * Another daemon is asked only about RELEASED work: while this daemon still holds the
     * session, a record it has not re-owned yet reads dead elsewhere (#11275), which is the
     * re-own gap and not the drain's. It is first asked one tick after the release started,
     * once the drain has had its turn at the registry.
     */
    async function claimedWhileWorkRuns(
      views: readonly number[] = [DAEMON_PID],
    ): Promise<number | null> {
      let releaseHadItsTurn = false;
      while (work.active.has(S1)) {
        for (const pid of views) {
          if (pid !== DAEMON_PID && (!releaseHadItsTurn || sessions.live.has(S1))) {
            continue;
          }
          if ((await claimAs(pid)).kind === "claimed") {
            return pid;
          }
        }
        await timer.sleep(500);
        releaseHadItsTurn = true;
      }
      return null;
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
      "$path, record of $owner, $step $mode, work $work: never claimable under running work, ready once idle",
      async ({ path, ownerPid, step, mode, workMs }) => {
        const tableDrain = newTableDrain(step);
        if (ownerPid !== DAEMON_PID) {
          await recordOwnedBy(ownerPid);
        }
        work.active.set(S1, 1);
        busy.calls[step] = mode === "throws once" ? 1 : 0;
        busy.commitsThenThrows[step] = mode === "commits then throws" ? 1 : 0;
        // The mark and the lookup are busy from the release on; the watcher's read and write
        // only start once the work has ended, so their cap of contention is counted from there.
        if (mode === "throws until the cap") {
          busy.untilMs[step] = timer.now() + CAP_MS;
        }
        if (mode === "throws until a cap after the work ends") {
          busy.untilMs[step] = timer.now() + workMs + CAP_MS;
        }
        timer.setTimeout(() => work.active.delete(S1), workMs);
        // Every daemon on the host must refuse the slot. The one exception is a session the
        // session manager already released whose slots this daemon cannot even look up: until
        // the lookup lands nothing durable can be written, so only this daemon's own hold
        // stands (and a record this daemon wrote, which the others read live by its pid).
        const lookupBusy =
          path !== "explicit release" &&
          step === "findExecutionAssignments" &&
          mode.startsWith("throws until") &&
          ownerPid !== DAEMON_PID;
        const claimedUnderWork = claimedWhileWorkRuns(
          lookupBusy ? [DAEMON_PID] : [DAEMON_PID, OTHER_DAEMON_PID, NEXT_DAEMON_PID],
        );

        let released = true;
        if (path === "explicit release") {
          released = await tableDrain.releaseExecution(S1).then(
            () => true,
            () => false,
          );
        } else {
          releasedBySessionManager(tableDrain);
        }

        expect(await claimedUnderWork).toBeNull();
        await tableDrain.whenIdle();
        expect(work.hasActiveDeviceSessionExecutions(S1)).toBe(false);
        // An explicit release whose slot lookup is busy fails closed: it rejects before it
        // cancels or releases anything, and the execution keeps its slot.
        const failedClosed =
          path === "explicit release" && step === "findExecutionAssignments" && mode !== "succeeds";
        expect(released).toBe(!failedClosed);
        expect(sessions.live.has(S1)).toBe(!released);
        if (failedClosed) {
          // The execution it left alone ends later, by heartbeat loss.
          releasedBySessionManager(tableDrain);
          await tableDrain.whenIdle();
        }
        expect(await registry.getAssignment(key)).toMatchObject({ state: "ready" });
        expect(await registry.listOpenSlotJournal(key)).toEqual([]);
        expect((await claimForNextExecution()).kind).toBe("claimed");
      },
    );

    test.each(OWNERS.slice(1))(
      "a busy mark and a busy re-stamp under a record of %s: this daemon still refuses the slot while the work runs",
      async (_owner, ownerPid) => {
        await recordOwnedBy(ownerPid);
        work.active.set(S1, 1);
        const never = timer.now() + 1_000_000_000;
        busy.untilMs.openSlotJournal = never;
        busy.untilMs.claimExecution = never;
        releasedBySessionManager(drain);

        await timer.sleep(1_000);

        expect(await registry.getAssignment(key)).toMatchObject({
          state: "ready",
          execOwner: { pid: ownerPid, sessionUuid: S1 },
        });
        expect((await claimForNextExecution()).kind).not.toBe("claimed");
      },
    );

    test.each(OWNERS.slice(1))(
      "a busy mark under a record of %s: the record names this daemon, so every daemon refuses the slot",
      async (_owner, ownerPid) => {
        await recordOwnedBy(ownerPid);
        work.active.set(S1, 1);
        busy.untilMs.openSlotJournal = timer.now() + 1_000_000_000;
        releasedBySessionManager(drain);

        await timer.sleep(1_000);

        expect(await registry.getAssignment(key)).toMatchObject({
          state: "ready",
          execOwner: { ...SETTLER, sessionUuid: S1 },
        });
        for (const pid of [DAEMON_PID, OTHER_DAEMON_PID, NEXT_DAEMON_PID]) {
          expect((await claimAs(pid)).kind).toBe("slot_in_use");
        }
      },
    );

    // Shutdown and restart mid-drain. The closing daemon starts no registry step, so what the
    // next daemon reads is what was already written: the `settling` mark, or the owner record
    // naming the closing daemon. Either holds for as long as that process runs, and neither
    // outlives it.
    const RESTARTS = OWNERS.flatMap(([owner, ownerPid]) =>
      (["lands", "is still owed"] as const).map((mark) => ({ owner, ownerPid, mark })),
    );

    test.each(RESTARTS)(
      "close while the work runs, record of $owner, mark $mark: no daemon hands the slot out until this process is gone, then the next one does",
      async ({ ownerPid, mark }) => {
        if (ownerPid !== DAEMON_PID) {
          await recordOwnedBy(ownerPid);
        }
        work.active.set(S1, 1);
        if (mark === "is still owed") {
          busy.untilMs.openSlotJournal = timer.now() + 1_000_000_000;
        }
        releasedBySessionManager(drain);
        await timer.sleep(1_000);

        const warnedBeforeClose = warn.mock.calls.length;
        drain.close();
        await drain.whenIdle();

        expect(warn.mock.calls.length).toBe(warnedBeforeClose);
        expect(work.hasActiveDeviceSessionExecutions(S1)).toBe(true);
        expect(await asDaemon(NEXT_DAEMON_PID, () => registry.recoverSettledSlots())).toEqual([]);
        for (const pid of [DAEMON_PID, OTHER_DAEMON_PID, NEXT_DAEMON_PID]) {
          expect((await claimAs(pid)).kind).not.toBe("claimed");
        }

        // The process exits, and its work with it: the next daemon's startup recovery and the
        // ordinary liveness rule return the slot, with no operator action.
        alive.delete(DAEMON_PID);
        work.active.delete(S1);
        await asDaemon(NEXT_DAEMON_PID, () => registry.recoverSettledSlots());
        expect(await registry.getAssignment(key)).toMatchObject({ state: "ready" });
        expect((await claimAs(NEXT_DAEMON_PID)).kind).toBe("claimed");
      },
    );

    test("a registry step in flight when the drain closes logs nothing after the close", async () => {
      let warnedAtClose = -1;
      let clears = 0;
      const closesOnLeftoverClear = new Proxy(faulty, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (property !== "releaseExecution") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => {
            clears += 1;
            if (clears === 2) {
              // The watcher's retry of the owner clear is in flight when the daemon shuts down.
              warnedAtClose = warn.mock.calls.length;
              closing.close();
            }
            throw new Error("SQLITE_BUSY: database is locked");
          };
        },
      });
      const closing: ManagedExecutionRelease = newDrain({
        registry: async () => closesOnLeftoverClear,
      });
      work.active.set(S1, 1);
      await closing.releaseExecution(S1);

      work.active.delete(S1);
      await closing.whenIdle();

      expect(clears).toBe(2);
      expect(warn.mock.calls.length).toBe(warnedAtClose);
    });

    test("a slot whose read stays busy past the cap does not hold up the re-check of another slot", async () => {
      // Execution 1 holds two slots; both owner clears fail, so each settling slot keeps its
      // owner record and the watcher has to wait for that owner to read dead.
      const second: SlotKey = { scopeKey: key.scopeKey, slotIndex: 1 };
      await registry.initSlot(second, {
        role: "secondary",
        platform: "android",
        requestedSpec: {},
      });
      await registry.commitBinding(
        second,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: "amslot-test-1-g1",
          deviceName: "amslot-test-1-g1",
          resolvedSpec: {},
          specFingerprint: "fp",
          state: "ready",
        },
      );
      const claimed = await registry.claimExecution(
        second,
        { generation: 1, stableDeviceId: "amslot-test-1-g1" },
        { daemonId: SETTLER.daemonId, pid: DAEMON_PID, sessionUuid: S1 },
      );
      expect(claimed.kind).toBe("claimed");
      // Slot 0's read is busy until well past the cap; slot 1's registry is fine.
      const busyUntilMs = timer.now() + CAP_MS + 4_000;
      const slotZeroBusy = new Proxy(faulty, {
        get(target, property) {
          if (property !== "getAssignment") {
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (slot: SlotKey) => {
            if (slot.slotIndex === 0 && timer.now() < busyUntilMs) {
              throw new Error("SQLITE_BUSY: database is locked");
            }
            return target.getAssignment(slot);
          };
        },
      });
      const tableDrain = newDrain({
        registry: async () => slotZeroBusy,
        settlementCapMs: CAP_MS,
        settlementSlowPollMs: SLOW_POLL_MS,
      });
      work.active.set(S1, 1);
      busy.calls.releaseExecution = 2;
      await tableDrain.releaseExecution(S1);
      // The same session id is held again when the work ends, then ends for good two seconds on.
      timer.setTimeout(() => {
        sessions.live.set(S1, DEVICE);
        work.active.delete(S1);
      }, 1_000);
      timer.setTimeout(() => sessions.live.delete(S1), 3_000);

      await timer.sleep(4_000);

      // Inside the cap, with slot 0 still retrying: slot 1 was re-checked on its own.
      expect(timer.now()).toBeLessThan(busyUntilMs - 4_000);
      expect(await registry.getAssignment(second)).toMatchObject({ state: "ready" });
      expect(await registry.getAssignment(key)).toMatchObject({ state: "settling" });
      await tableDrain.whenIdle();
      expect(await registry.getAssignment(key)).toMatchObject({ state: "ready" });
    });

    const NEVER_ENDING = OWNERS.flatMap(([owner, ownerPid]) =>
      HOLD_STEPS.filter((step) => step !== "claimExecution" || ownerPid !== DAEMON_PID).map(
        (step) => ({ owner, ownerPid, step }),
      ),
    );

    test.each(NEVER_ENDING)(
      "record of $owner, $step busy until the cap under work that never ends: still fenced past the cap, and --force recovers the slot or says why not",
      async ({ ownerPid, step }) => {
        const tableDrain = newTableDrain(step);
        if (ownerPid !== DAEMON_PID) {
          await recordOwnedBy(ownerPid);
        }
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
        // A record this daemon could not even look up yet, and so not re-stamp, still names the
        // other running daemon: the refusal says that this daemon cannot judge it.
        const reasons =
          ownerPid === OTHER_DAEMON_PID && step === "findExecutionAssignments"
            ? /^(live_owner|within_settlement_cap|owner_liveness_unknown)$/
            : /^(live_owner|within_settlement_cap)$/;
        expect(refusals.map((refusal) => refusal.reason)).toEqual(
          refusals.map(() => expect.stringMatching(reasons)),
        );
        expect(refusals.every((refusal) => refusal.message.length > 0)).toBe(true);
        work.active.delete(S1);
      },
    );
  },
);

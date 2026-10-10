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
  ReleaseExecutionResult,
  SlotExecOwnerLiveness,
  SlotKey,
} from "../../../../src/daemon/managedSlots/slotRegistry";
import { SlotScopeReset } from "../../../../src/daemon/managedSlots/slotScopeReset";
import { logger } from "../../../../src/utils/logger";
import { FakeSlotRegistry } from "../../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";

// Hunt (managed slots, second pass): #11456 judges an owner record this daemon wrote by its
// session, so a record whose clear failed (SQLITE_BUSY on the host-wide registry, the trigger
// #11339 accepted as realistic) no longer pins a `ready` slot. A slot the drain marked `settling`
// before that failed clear is still pinned: the settlement watcher (#11456) and
// `reset-slot-scope --force` (#11517) both test `execOwner !== null` instead of owner liveness, so
// the dead session's leftover record reads as "the slot gained an execution" / "the slot is in
// use". The slot then stays `settling` (its release journal entry open and guarded in flight) for
// the daemon's lifetime, and the scope can never be reset.

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
class BusyRegistry extends FakeSlotRegistry {
  failReleases = 0;

  override async releaseExecution(
    key: SlotKey,
    sessionUuid: string,
  ): Promise<ReleaseExecutionResult> {
    if (this.failReleases > 0) {
      this.failReleases -= 1;
      throw new Error("SQLITE_BUSY: database is locked");
    }
    return super.releaseExecution(key, sessionUuid);
  }
}

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

describe("hunt: a settling slot whose owner clear failed", () => {
  let timer: FakeTimer;
  let registry: BusyRegistry;
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
    registry = new BusyRegistry(timer, liveness);
    inFlight = new SlotJournalInFlight();
    drain = new ManagedExecutionRelease({
      registry: async () => registry,
      journal: { inFlight },
      settler: SETTLER,
      work,
      sessions,
      timer,
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

  afterEach(() => {
    drain.close();
    warn.mockRestore();
  });

  /** Release S1 with one action still running; the registry is busy for the owner clear. */
  async function releaseWithFailedOwnerClear(): Promise<void> {
    work.active.set(S1, 1);
    registry.failReleases = 1;
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

  test("returns to ready once the released work settles", async () => {
    await releaseWithFailedOwnerClear();

    work.active.delete(S1);
    await drain.whenIdle();

    // Actual: still `settling`, entry open and guarded, so every later acquisition of this slot
    // is refused `slot_settling` until the daemon restarts.
    expect(await registry.getAssignment(key)).toMatchObject({ state: "ready" });
    expect(await registry.listOpenSlotJournal(key)).toEqual([]);
  });

  test("reset-slot-scope --force overrides it: the leftover owner is not a live execution", async () => {
    await releaseWithFailedOwnerClear();
    // The released work never settles: exactly the stuck settlement --force exists for.
    drain.close();
    await drain.whenIdle();
    const reset = new SlotScopeReset({ registry: async () => registry, timer });

    const forced = await reset.reset({
      runnerNamespace: SCOPE.runnerNamespace,
      runnerIncarnation: SCOPE.runnerIncarnation,
      waitMs: 0,
      force: true,
    });

    // Actual: `pending` forever (no live owner listed, one settling slot), on every retry.
    expect(forced.scopes[0]?.pending?.liveOwners ?? []).toEqual([]);
    expect(forced.outcome).toBe("invalidated");
  });
});

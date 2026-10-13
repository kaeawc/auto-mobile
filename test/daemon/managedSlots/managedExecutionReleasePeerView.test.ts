import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { ManagedExecutionReowner } from "../../../src/daemon/managedSlots/managedExecutionReowner";
import { ManagedSlotOwnershipUnconfirmedError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { ManagedExecutionRelease } from "../../../src/daemon/managedSlots/managedExecutionRelease";
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
import { exponentialBackoff } from "../../../src/utils/Backoff";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
import { useScratchRoot } from "../../helpers/scratchRoot";

const OWNER = { daemonId: "draining-daemon", pid: 4201, processGenerationToken: "test:owner" };
const PREVIOUS = { daemonId: "previous-daemon", pid: 4101, processGenerationToken: "test:dead" };
const PEER = { daemonId: "peer-daemon", pid: 4301, processGenerationToken: "test:peer" };
const SESSION = "released-managed-session";
const PEER_SESSION = "peer-managed-session";
const DEVICE = "managed-device";
const BINDING = { generation: 1, stableDeviceId: DEVICE };
const SCOPE = {
  managedHostScope: "host",
  runnerNamespace: "peer-view",
  runnerIncarnation: "boot-1",
};
type FaultStep =
  | "findExecutionAssignments"
  | "claimExecution"
  | "openSlotJournal"
  | "getAssignment"
  | "updateSlotState";

/** Fault injection applies only through the draining daemon's connection. */
function makeFaults(registry: SlotRegistry) {
  const busy: Partial<Record<FaultStep, number>> = {};
  const commitsThenThrows: Partial<Record<FaultStep, number>> = {};
  const calls: Partial<Record<FaultStep, number>> = {};
  const hooks: { afterFind?: () => Promise<void> } = {};
  const faulty = new Proxy(registry, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]): Promise<unknown> => {
        const step = property as FaultStep;
        calls[step] = (calls[step] ?? 0) + 1;
        if ((busy[step] ?? 0) > 0) {
          busy[step]! -= 1;
          throw new Error("SQLITE_BUSY: database is locked");
        }
        const result: unknown = await Reflect.apply(value, target, args);
        if (property === "findExecutionAssignments") {
          await hooks.afterFind?.();
        }
        if ((commitsThenThrows[step] ?? 0) > 0) {
          commitsThenThrows[step]! -= 1;
          throw new Error("SQLITE_BUSY: acknowledgment lost after commit");
        }
        return result;
      };
    },
  });
  return { faulty, busy, commitsThenThrows, calls, hooks };
}

describe("managed execution release peer view", () => {
  const scratch = useScratchRoot("managed-release-peer-view-");
  let timer: FakeTimer;
  let ownerRegistry: SlotRegistry;
  let peerRegistry: SlotRegistry;
  let faults: ReturnType<typeof makeFaults>;
  let drain: ManagedExecutionRelease;
  let reowner: ManagedExecutionReowner | undefined;
  let key: SlotKey;
  let liveSessions: Set<string>;
  let livePids: Set<number>;
  let active: boolean;
  const reservations = new InFlightSlotReservations();
  let confirmations: string[];
  let losses: string[];

  function viewOf(pid: number): SlotExecOwnerLiveness {
    return withLiveExecutionSessions(
      (owner) => livePids.has(owner.pid),
      {
        isLiveManagedExecutionSession: (sessionUuid) =>
          pid === OWNER.pid && liveSessions.has(sessionUuid),
      },
      {
        thisProcess: { pid },
        reservations: pid === OWNER.pid ? reservations : new InFlightSlotReservations(),
      },
    );
  }

  async function setUp(
    owner: typeof OWNER | typeof PREVIOUS = OWNER,
    journaled = true,
  ): Promise<void> {
    timer = new FakeTimer();
    reowner = undefined;
    confirmations = [];
    losses = [];
    liveSessions = new Set([SESSION]);
    livePids = new Set([OWNER.pid, PEER.pid]);
    active = true;
    const dbPath = join(scratch.next(), "slots.sqlite");
    ownerRegistry = await openSqliteSlotRegistry({
      dbPath,
      timer,
      isExecOwnerLive: viewOf(OWNER.pid),
    });
    peerRegistry = await openSqliteSlotRegistry({
      dbPath,
      timer,
      isExecOwnerLive: viewOf(PEER.pid),
    });
    faults = makeFaults(ownerRegistry);
    const scope = await ownerRegistry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error(`scope not ready: ${scope.kind}`);
    }
    key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
    await ownerRegistry.initSlot(key, { role: "app", platform: "android", requestedSpec: {} });
    await ownerRegistry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: DEVICE,
        deviceName: DEVICE,
        resolvedSpec: {},
        specFingerprint: "fp",
        state: "ready",
      },
    );
    const claimed = await ownerRegistry.claimExecution(key, BINDING, {
      ...owner,
      sessionUuid: SESSION,
    });
    expect(claimed.kind).toBe("claimed");
    drain = new ManagedExecutionRelease({
      registry: async () => faults.faulty,
      journal: journaled ? { inFlight: new SlotJournalInFlight() } : undefined,
      settler: OWNER,
      timer,
      drainBudgetMs: 1,
      releaseBudgetMs: 1,
      settlementPollMs: 1,
      settlementCapMs: 100,
      registryRetryBackoff: exponentialBackoff({ initialDelayMs: 1, maxDelayMs: 1 }),
      isExecOwnerLive: viewOf(OWNER.pid),
      ownerHolds: reservations,
      ownership: {
        isReleaseHeld: (id) => reowner?.isReleaseHeld(id) ?? false,
        confirmOwnership: (id) => {
          confirmations.push(id);
          reowner?.confirmOwnership(id);
        },
        loseOwnership: (id) => {
          losses.push(id);
          reowner?.loseOwnership(id);
        },
      },
      work: {
        cancelDeviceSessionExecutions: async () => 1,
        waitForDeviceSessionExecutionsToEnd: async () => !active,
        hasActiveDeviceSessionExecutions: () => active,
      },
      sessions: {
        isSessionLive: (id) => liveSessions.has(id),
        deviceOf: () => DEVICE,
        releaseSession: async (id) => {
          liveSessions.delete(id);
          return DEVICE;
        },
        forceStuckRelease: async () => false,
        hasDeviceCleanupInProgress: () => false,
      },
    });
  }

  async function tearDown(): Promise<void> {
    active = false;
    timer.advanceTime(1_000);
    await drainMicrotasks(100);
    reowner?.close();
    drain.close();
    await reowner?.whenIdle();
    await drain.whenIdle();
    await Promise.all([ownerRegistry.close(), peerRegistry.close()]);
  }

  function testWithFreshSlot(
    name: string,
    run: () => Promise<void>,
    owner: typeof OWNER | typeof PREVIOUS = OWNER,
    journaled = true,
  ): void {
    describe("shared SQLite slot fixture", () => {
      beforeAll(() => setUp(owner, journaled));
      afterAll(tearDown);
      test(name, run);
    });
  }

  async function peerClaim() {
    const current = (await peerRegistry.getAssignment(key))!;
    return peerRegistry.claimExecution(
      key,
      { generation: current.generation, stableDeviceId: current.stableDeviceId },
      { ...PEER, sessionUuid: PEER_SESSION },
    );
  }

  function expectPeerRefused(kind: string): void {
    expect(["slot_in_use", "slot_not_ready"]).toContain(kind);
  }

  for (const journaled of [true, false]) {
    testWithFreshSlot(
      `a peer claim between lookup and settling is loss, never ownership proof (journal=${journaled})`,
      async () => {
        // Both the inline and hold-triggered re-own must leave this session unconfirmed.
        faults.busy.claimExecution = Infinity;
        const lost: string[] = [];
        reowner = new ManagedExecutionReowner({
          registry: async () => faults.faulty,
          owner: () => OWNER,
          timer,
          isSessionHeld: () => true,
          onOwnershipLost: (id) => lost.push(id),
        });
        await reowner.reown([SESSION], { rehydrated: true });
        const hold = reowner.releaseDeviceHold(SESSION);
        expect(hold && "settled" in hold).toBe(true);
        if (!hold || !("settled" in hold)) {
          throw new Error("expected pending hold");
        }
        await drainUntil(() => timer.getPendingTimeouts().includes(50), {
          description: "failed expedited re-own parking on its second backoff wait",
        });
        expect(faults.calls.claimExecution).toBe(2);
        expect(reowner.ownershipState(SESSION)).toBe("unconfirmed");
        const writes: string[] = [];
        const manager = new SessionManager(
          timer,
          new FakeDeviceSessionPersistence(),
          () => new FakeDbWriteBarrier(),
          () => ({
            restore: async () => {
              writes.push("restore");
            },
          }),
        );
        manager.stopCleanupTimer();
        await manager.createSession(SESSION, DEVICE, "android");
        manager.setKeepScreenAwake(SESSION, { applied: true });
        manager.setReleaseDeviceHold((id) => reowner?.releaseDeviceHold(id));
        const release = manager.releaseSession(SESSION);
        let peerClaimKind = "";
        faults.hooks.afterFind = async () => {
          faults.hooks.afterFind = undefined;
          expect(reowner?.ownershipState(SESSION)).toBe("unconfirmed");
          peerClaimKind = (await peerClaim()).kind;
          // The drain can now observe the peer's claim as loss, rather than another busy write.
          faults.busy.claimExecution = 0;
        };
        await drain.releaseExecution(SESSION);
        expect(peerClaimKind).toBe("claimed");
        expect(confirmations).toEqual([]);
        expect(losses).toEqual([SESSION]);
        expect(await hold.settled).toBe("skip-device-writes");
        await release;
        expect(writes).toEqual([]);
        expect(lost).toEqual([SESSION]);
        reowner.loseOwnership(SESSION);
        expect(lost).toEqual([SESSION]);
        expect(reowner.ownershipState(SESSION)).toBe("lost");
        // The pre-existing mark still lands on the peer; it is never ownership proof.
        expect(await peerRegistry.getAssignment(key)).toMatchObject({
          state: "settling",
          execOwner: { sessionUuid: PEER_SESSION },
        });
      },
      PREVIOUS,
      journaled,
    );

    testWithFreshSlot(
      `a thrown post-mark read is no ownership proof (journal=${journaled})`,
      async () => {
        faults.busy.claimExecution = 1_000;
        reowner = new ManagedExecutionReowner({
          registry: async () => faults.faulty,
          owner: () => OWNER,
          timer,
          isSessionHeld: () => true,
        });
        await reowner.reown([SESSION], { rehydrated: true });
        const hold = reowner.releaseDeviceHold(SESSION);
        if (!hold || !("settled" in hold)) {
          throw new Error("expected pending hold");
        }
        // The mark commits, loses its acknowledgment, and cannot be read back yet.
        faults.commitsThenThrows[journaled ? "openSlotJournal" : "updateSlotState"] = 1;
        faults.busy.getAssignment = 1_000;
        await drain.releaseExecution(SESSION);
        expect(await peerRegistry.getAssignment(key)).toMatchObject({ state: "settling" });
        expect(confirmations).toEqual([]);
        expect(losses).toEqual([]);
        expect(reowner.isReleaseHeld(SESSION)).toBe(true);
        expect(reowner.ownershipState(SESSION)).toBe("unconfirmed");
        reowner.close();
        expect(await hold.settled).toBe("skip-device-writes");
      },
      PREVIOUS,
      journaled,
    );

    testWithFreshSlot(
      `a settling mark still naming the session confirms ownership (journal=${journaled})`,
      async () => {
        faults.busy.claimExecution = 1_000;
        reowner = new ManagedExecutionReowner({
          registry: async () => faults.faulty,
          owner: () => OWNER,
          timer,
          isSessionHeld: () => true,
        });
        await reowner.reown([SESSION], { rehydrated: true });
        const hold = reowner.releaseDeviceHold(SESSION);
        if (!hold || !("settled" in hold)) {
          throw new Error("expected pending hold");
        }
        await drain.releaseExecution(SESSION);
        expect(confirmations).toEqual([SESSION]);
        expect(losses).toEqual([]);
        expect(await hold.settled).toBe("teardown");
      },
      PREVIOUS,
      journaled,
    );
  }

  testWithFreshSlot(
    "a busy settling journal mark stays peer-visible until released work settles",
    async () => {
      // Keep the owed mark busy while work remains active; the retry sees settlement only after
      // the test releases the work below.
      faults.busy.openSlotJournal = 1_000;
      const result = await drain.releaseExecution(SESSION);
      expect(result).toMatchObject({ outcome: "cleanup_pending", settlement: "settling" });
      expect(active).toBe(true);
      const assignment = await peerRegistry.getAssignment(key);
      expect(assignment?.execOwner).toMatchObject({ pid: OWNER.pid, sessionUuid: SESSION });
      expectPeerRefused((await peerClaim()).kind);
      for (let attempt = 0; attempt < 2; attempt++) {
        timer.advanceTime(1);
        await drainMicrotasks(40);
        expectPeerRefused((await peerClaim()).kind);
      }
      expect(faults.calls.openSlotJournal).toBeGreaterThan(1);

      active = false;
      faults.busy.openSlotJournal = 0;
      timer.advanceTime(1);
      await drainMicrotasks(40);
      timer.advanceTime(1_000);
      await drain.whenIdle();
      expect(await peerRegistry.getAssignment(key)).toMatchObject({
        state: "ready",
        execOwner: null,
      });
      expect((await peerClaim()).kind).toBe("claimed");
    },
  );

  testWithFreshSlot(
    "a committed settling mark with a lost acknowledgment remains fenced",
    async () => {
      faults.commitsThenThrows.openSlotJournal = 1;
      const result = await drain.releaseExecution(SESSION);
      expect(result).toMatchObject({ outcome: "cleanup_pending", settlement: "settling" });
      expect(await peerRegistry.getAssignment(key)).toMatchObject({ state: "settling" });
      for (let attempt = 0; attempt < 2; attempt++) {
        expectPeerRefused((await peerClaim()).kind);
      }
      active = false;
      timer.advanceTime(1_000);
      await drain.whenIdle();
    },
  );

  testWithFreshSlot(
    "a busy assignment lookup leaves the live owner visible to a peer",
    async () => {
      faults.busy.findExecutionAssignments = 1;
      await expect(drain.releaseExecution(SESSION)).rejects.toThrow("SQLITE_BUSY");
      expect(active).toBe(true);
      expect(await peerRegistry.getAssignment(key)).toMatchObject({
        state: "ready",
        execOwner: { pid: OWNER.pid, sessionUuid: SESSION },
      });
      expectPeerRefused((await peerClaim()).kind);
      active = false;
    },
  );

  testWithFreshSlot(
    "closing the drain keeps a peer fenced while its owner process is live",
    async () => {
      const result = await drain.releaseExecution(SESSION);
      expect(result).toMatchObject({ outcome: "cleanup_pending", settlement: "settling" });
      drain.close();
      timer.advanceTime(1_000);
      await drain.whenIdle();
      expect(active).toBe(true);
      expect(livePids.has(OWNER.pid)).toBe(true);
      expect(await peerRegistry.getAssignment(key)).toMatchObject({ state: "settling" });
      for (let attempt = 0; attempt < 3; attempt++) {
        expectPeerRefused((await peerClaim()).kind);
      }
    },
  );

  testWithFreshSlot(
    "unconfirmed recovery admits no resumed work when both release writes fail and a peer claims the dead owner",
    async () => {
      faults.busy.claimExecution = 1_000;
      faults.busy.openSlotJournal = 1_000;
      reowner = new ManagedExecutionReowner({
        registry: async () => faults.faulty,
        owner: () => OWNER,
        timer,
        retryBackoff: exponentialBackoff({ initialDelayMs: 1, maxDelayMs: 1 }),
        isSessionHeld: (id) => liveSessions.has(id),
      });
      await reowner.reown([SESSION], { rehydrated: true });
      reowner.close();
      expect(reowner.automationRefusal(SESSION)).toBeInstanceOf(
        ManagedSlotOwnershipUnconfirmedError,
      );
      expect(reowner.automationRefusal(SESSION)?.message).toContain("not recorded");
      let admitted = false;
      if (reowner.automationRefusal(SESSION) === undefined) {
        admitted = true;
      }
      expect(admitted).toBe(false);

      // Active work is synthetic drain stress only; the gate above proves resumed work is not admitted.
      await drain.releaseExecution(SESSION);
      expect(faults.calls.claimExecution).toBeGreaterThan(0);
      expect(faults.calls.openSlotJournal).toBeGreaterThan(0);
      expect((await peerClaim()).kind).toBe("claimed");
      // The drain stress is not a session teardown; keep the rehydrated session held for the
      // admission assertion after the peer has taken over its stale slot record.
      liveSessions.add(SESSION);
      expect(await peerRegistry.getAssignment(key)).toMatchObject({
        execOwner: { pid: PEER.pid, sessionUuid: PEER_SESSION },
      });
      expect(reowner.automationRefusal(SESSION)).toBeInstanceOf(
        ManagedSlotOwnershipUnconfirmedError,
      );
    },
    PREVIOUS,
  );
});

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../../src/daemon/managedExecutionLiveness";
import { ManagedExecutionReowner } from "../../../src/daemon/managedSlots/managedExecutionReowner";
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
import { logger } from "../../../src/utils/logger";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks } from "../../helpers/fakeTimerStepping";

const PREVIOUS = { daemonId: "previous", pid: 4100 };
const OWNER = { daemonId: "current", pid: 4200 };
const PEERS = [4300, 4400];
const S = "resumed-session";
const S2 = "fresh-session";
const DEVICE = "slot-device";
const BINDING = { generation: 1, stableDeviceId: DEVICE };
type Step = "findExecutionAssignments" | "claimExecution" | "openSlotJournal";

// Faults affect only the current daemon's handle; peers read the real shared SQLite registry.
function makeBusy(registry: SlotRegistry) {
  const busy: Partial<Record<Step, number>> = {};
  const commitsThenThrows: Partial<Record<Step, number>> = {};
  const calls: Partial<Record<Step, number>> = {};
  const hooks: { beforeClaim?: () => Promise<void>; afterLookup?: () => void } = {};
  const faulty = new Proxy(registry, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        const step = property as Step;
        calls[step] = (calls[step] ?? 0) + 1;
        if ((busy[step] ?? 0) > 0) {
          busy[step]! -= 1;
          throw new Error("SQLITE_BUSY: database is locked");
        }
        if (property === "claimExecution") {
          await hooks.beforeClaim?.();
        }
        const result: unknown = await Reflect.apply(value, target, args);
        if (property === "findExecutionAssignments") {
          hooks.afterLookup?.();
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

describe("rehydrated managed execution peer claim fence", () => {
  let timer: FakeTimer;
  let registry: SlotRegistry;
  let faults: ReturnType<typeof makeBusy>;
  let reowner: ManagedExecutionReowner;
  let drain: ManagedExecutionRelease;
  let key: SlotKey;
  let judge: SlotExecOwnerLiveness;
  let liveSessions: Set<string>;
  let held: boolean;
  let active: boolean;
  let warn: ReturnType<typeof spyOn>;
  let info: ReturnType<typeof spyOn>;
  const holds = new InFlightSlotReservations();

  function viewOf(pid: number): SlotExecOwnerLiveness {
    return withLiveExecutionSessions(
      (owner) => [OWNER.pid, ...PEERS].includes(owner.pid),
      {
        isLiveManagedExecutionSession: (id) =>
          (pid === OWNER.pid && liveSessions.has(id)) ||
          (pid !== OWNER.pid && id === `${S2}-${pid}`),
      },
      {
        thisProcess: { pid },
        reservations: pid === OWNER.pid ? holds : new InFlightSlotReservations(),
      },
    );
  }

  async function setUp(): Promise<void> {
    timer = new FakeTimer();
    liveSessions = new Set([S]);
    held = true;
    active = false;
    judge = viewOf(OWNER.pid);
    registry = await openSqliteSlotRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: (owner) => judge(owner),
    });
    faults = makeBusy(registry);
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "runner",
      runnerIncarnation: "boot",
    });
    if (scope.kind !== "ready") {
      throw new Error(scope.kind);
    }
    key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
    await registry.initSlot(key, { role: "app", platform: "android", requestedSpec: {} });
    await registry.commitBinding(
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
    expect(
      (await registry.claimExecution(key, BINDING, { ...PREVIOUS, sessionUuid: S })).kind,
    ).toBe("claimed");
    reowner = new ManagedExecutionReowner({
      registry: async () => faults.faulty,
      owner: () => OWNER,
      timer,
      retryBackoff: exponentialBackoff({ initialDelayMs: 10, maxDelayMs: 40 }),
      isSessionHeld: () => held,
    });
    drain = new ManagedExecutionRelease({
      registry: async () => faults.faulty,
      journal: { inFlight: new SlotJournalInFlight() },
      settler: OWNER,
      timer,
      isExecOwnerLive: viewOf(OWNER.pid),
      ownerHolds: holds,
      work: {
        cancelDeviceSessionExecutions: async () => (active ? 1 : 0),
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
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    info = spyOn(logger, "info").mockImplementation(() => {});
  }

  async function tearDown(): Promise<void> {
    reowner.close();
    drain.close();
    await reowner.whenIdle();
    await drain.whenIdle();
    holds.delete(S);
    warn.mockRestore();
    info.mockRestore();
    await registry.close();
  }

  function testWithFreshSlot(name: string, run: () => Promise<void>): void {
    describe("fresh SQLite slot fixture", () => {
      // Each case owns a new registry; schema initialization is fixture setup, not test work.
      beforeAll(setUp);
      afterAll(tearDown);
      test(name, run);
    });
  }

  async function claimAs(pid: number) {
    const admitted = reowner.automationRefusal(S) === undefined;
    const assignment = (await registry.getAssignment(key))!;
    judge = viewOf(pid);
    try {
      const result = await registry.claimExecution(
        key,
        { generation: assignment.generation, stableDeviceId: assignment.stableDeviceId },
        { daemonId: `peer-${pid}`, pid, sessionUuid: `${S2}-${pid}` },
      );
      expect(admitted && result.kind === "claimed").toBe(false);
      if (result.kind === "claimed") {
        expect(reowner.automationRefusal(S)).toBeDefined();
      }
      return result;
    } finally {
      judge = viewOf(OWNER.pid);
    }
  }

  async function advance(ms: number) {
    timer.advanceTime(ms);
    await drainMicrotasks(80);
  }

  testWithFreshSlot(
    "double write failure admits no work before a peer claims; retry loses the slot permanently",
    async () => {
      faults.busy.claimExecution = 1;
      faults.busy.openSlotJournal = 100;
      const attempt = reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toContain("not recorded");
      await attempt;
      expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
      await advance(10);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toContain("no longer owns");
      await reowner.reown([S]);
      expect(reowner.automationRefusal(S)).toContain("no longer owns");
      expect(
        warn.mock.calls.filter(([message]) => String(message).includes("no longer owns")),
      ).toHaveLength(1);
      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: { sessionUuid: `${S2}-${PEERS[0]}` },
        generation: 1,
      });
    },
  );

  testWithFreshSlot(
    "busy claims follow injected exponential backoff before admission and fence both peers",
    async () => {
      faults.busy.claimExecution = 3;
      await reowner.reown([S], { rehydrated: true });
      expect(timer.getPendingTimeouts()).toEqual([10]);
      expect(faults.calls.claimExecution).toBe(1);
      await advance(9);
      expect(faults.calls.claimExecution).toBe(1);
      await advance(1);
      expect(timer.getPendingTimeouts()).toEqual([20]);
      expect(reowner.automationRefusal(S)).toBeDefined();
      await advance(20);
      expect(timer.getPendingTimeouts()).toEqual([40]);
      expect(reowner.automationRefusal(S)).toBeDefined();
      await advance(40);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: { ...OWNER, sessionUuid: S },
      });
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
    },
  );

  testWithFreshSlot(
    "failed lookup remains gated until the retry reads and claims the slot",
    async () => {
      faults.busy.findExecutionAssignments = 1;
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(faults.calls.claimExecution).toBeUndefined();
      await advance(10);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
    },
  );

  testWithFreshSlot(
    "lost acknowledgment keeps the gate closed although both peers already see the committed owner",
    async () => {
      faults.commitsThenThrows.claimExecution = 1;
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
      await advance(10);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(faults.calls.claimExecution).toBe(1);
    },
  );

  testWithFreshSlot(
    "shutdown aborts retries, preserves the gate, and leaves only never-admitted work claimable",
    async () => {
      faults.busy.claimExecution = 100;
      await reowner.reown([S], { rehydrated: true });
      const calls = { ...faults.calls };
      const warnings = warn.mock.calls.length;
      const infos = info.mock.calls.length;
      reowner.close();
      await reowner.whenIdle();
      await advance(1_000);
      await reowner.reown([S]);
      expect(faults.calls).toEqual(calls);
      expect(warn.mock.calls.length).toBe(warnings);
      expect(info.mock.calls.length).toBe(infos);
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect((await claimAs(PEERS[1]!)).kind).toBe("claimed");
      expect((await claimAs(PEERS[0]!)).kind).toBe("slot_in_use");
    },
  );

  testWithFreshSlot(
    "closing during a lookup starts no claim and leaves ownership unconfirmed",
    async () => {
      faults.hooks.afterLookup = () => reowner.close();
      await reowner.reown([S], { rehydrated: true });
      await reowner.whenIdle();
      expect(faults.calls.claimExecution).toBeUndefined();
      expect(warn.mock.calls).toEqual([]);
      expect(info.mock.calls).toEqual([]);
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
    },
  );

  testWithFreshSlot(
    "delayed explicit and listener releases of the lost session cannot change the fresh peer session",
    async () => {
      faults.busy.claimExecution = 1;
      await reowner.reown([S], { rehydrated: true });
      expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
      await advance(10);
      await reowner.whenIdle();
      const fresh = await registry.getAssignment(key);
      await drain.releaseExecution(S);
      drain.onSessionReleased({
        sessionId: S,
        deviceId: DEVICE,
        livenessPolicy: MANAGED_EXECUTION_LIVENESS_POLICY,
      });
      await drain.whenIdle();
      expect(await registry.getAssignment(key)).toEqual(fresh);
      expect(fresh).toMatchObject({
        state: "ready",
        generation: 1,
        execOwner: { sessionUuid: `${S2}-${PEERS[0]}` },
      });
      expect(await registry.listOpenSlotJournal(key)).toEqual([]);
      expect(faults.calls.openSlotJournal).toBeUndefined();
      expect(reowner.automationRefusal(S)).toBeDefined();
    },
  );

  testWithFreshSlot(
    "confirmed ownership fences every daemon when both release writes fail under active work",
    async () => {
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeUndefined();
      active = true;
      faults.busy.openSlotJournal = 100;
      faults.busy.claimExecution = 100;
      await drain.releaseExecution(S);
      expect(active).toBe(true);
      expect(await registry.getAssignment(key)).toMatchObject({
        state: "ready",
        execOwner: { ...OWNER, sessionUuid: S },
      });
      for (const pid of [OWNER.pid, ...PEERS]) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
      drain.close();
      await drain.whenIdle();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
    },
  );

  testWithFreshSlot(
    "a peer winning between read and claim reports slot_in_use and warns once",
    async () => {
      faults.hooks.beforeClaim = async () => {
        faults.hooks.beforeClaim = undefined;
        expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
      };
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toContain("no longer owns");
      expect(timer.getPendingTimeouts()).toEqual([]);
      await reowner.reown([S]);
      expect(warn.mock.calls).toHaveLength(1);
      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: { sessionUuid: `${S2}-${PEERS[0]}` },
      });
    },
  );

  testWithFreshSlot(
    "every slot must be confirmed before a multi-slot session is admitted",
    async () => {
      const second = { ...key, slotIndex: 1 };
      await registry.initSlot(second, { role: "other", platform: "android", requestedSpec: {} });
      await registry.commitBinding(
        second,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: "second-device",
          deviceName: "second-device",
          resolvedSpec: {},
          specFingerprint: "fp",
          state: "ready",
        },
      );
      await registry.claimExecution(
        second,
        { generation: 1, stableDeviceId: "second-device" },
        { ...PREVIOUS, sessionUuid: S },
      );
      faults.hooks.beforeClaim = async () => {
        faults.hooks.beforeClaim = undefined;
        faults.busy.claimExecution = 1;
      };
      expect(await reowner.reown([S], { rehydrated: true })).toEqual([]);
      expect(reowner.automationRefusal(S)).toBeDefined();
      await advance(10);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(await registry.getAssignment(second)).toMatchObject({
        execOwner: { ...OWNER, sessionUuid: S },
      });
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
    },
  );

  testWithFreshSlot(
    "non-rehydration failures mark nothing, gate nothing, and retry nothing",
    async () => {
      faults.busy.claimExecution = 1;
      expect(await reowner.reown([S])).toEqual([]);
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(reowner.automationRefusal("never-rehydrated")).toBeUndefined();
      expect(timer.getPendingTimeouts()).toEqual([]);
    },
  );

  testWithFreshSlot(
    "a failed registry open backs off by default and absent held-session predicate keeps the gate",
    async () => {
      reowner.close();
      let opens = 0;
      reowner = new ManagedExecutionReowner({
        registry: async () => {
          opens += 1;
          if (opens === 1) {
            throw new Error("SQLITE_BUSY: open failed");
          }
          return faults.faulty;
        },
        owner: () => OWNER,
        timer,
      });
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(timer.getPendingTimeouts()).toEqual([250]);
      await advance(249);
      expect(opens).toBe(1);
      await advance(1);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
    },
  );

  testWithFreshSlot("a host without a registry marks and gates nothing", async () => {
    const absent = new ManagedExecutionReowner({
      registry: async () => {
        throw new Error("must not open");
      },
      registryExists: () => false,
      owner: () => OWNER,
      timer,
    });
    expect(await absent.reown([S], { rehydrated: true })).toEqual([]);
    expect(absent.automationRefusal(S)).toBeUndefined();
    absent.close();
    await absent.whenIdle();
  });

  testWithFreshSlot(
    "stale binding between lookup and claim is retried with a fresh binding",
    async () => {
      let moved = false;
      faults.hooks.beforeClaim = async () => {
        if (!moved) {
          moved = true;
          expect(
            (await registry.updateSlotState(key, BINDING, "settling", { settler: PREVIOUS })).kind,
          ).toBe("updated");
          expect(
            (await registry.updateSlotState(key, { ...BINDING, generation: 2 }, "ready")).kind,
          ).toBe("updated");
        }
      };
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(timer.getPendingTimeouts()).toEqual([10]);
      await advance(10);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
    },
  );

  testWithFreshSlot(
    "slot_not_ready settles the gate and remains unclaimable by peers",
    async () => {
      await registry.updateSlotState(key, BINDING, "settling", { settler: PREVIOUS });
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(timer.getPendingTimeouts()).toEqual([]);
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_not_ready");
      }
    },
  );

  testWithFreshSlot(
    "a session no longer held drops its gate and stops registry retries",
    async () => {
      faults.busy.claimExecution = 100;
      await reowner.reown([S], { rehydrated: true });
      held = false;
      expect(reowner.automationRefusal(S)).toBeUndefined();
      const calls = { ...faults.calls };
      await advance(10);
      await reowner.whenIdle();
      expect(faults.calls).toEqual(calls);
      expect(timer.getPendingTimeouts()).toEqual([]);
    },
  );

  testWithFreshSlot(
    "a registerSession attempt can confirm a previously marked session before its retry",
    async () => {
      faults.busy.claimExecution = 1;
      await reowner.reown([S], { rehydrated: true });
      await reowner.reown([S]);
      expect(reowner.automationRefusal(S)).toBeUndefined();
      const calls = { ...faults.calls };
      await advance(10);
      await reowner.whenIdle();
      expect(faults.calls).toEqual(calls);
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("slot_in_use");
      }
    },
  );

  testWithFreshSlot(
    "one session's thrown lookup does not stop another session's inline attempt",
    async () => {
      faults.busy.findExecutionAssignments = 1;
      await reowner.reown(["missing", S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(reowner.automationRefusal("missing")).toBeDefined();
      await advance(10);
      await reowner.whenIdle();
      expect(reowner.automationRefusal("missing")).toContain("no longer owns");
    },
  );
});

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { timedHold } from "../../../helpers/timedReleaseHold";
import { MANAGED_EXECUTION_LIVENESS_POLICY } from "../../../../src/models/managedExecutionLiveness";
import { ManagedExecutionReowner } from "../../../helpers/deferredProvisioningFixtures";
import {
  BindingOwnershipLostError,
  BindingOwnershipUnconfirmedError,
} from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import { BrokerExecutionRelease } from "../../../../src/daemon/sessionBroker/provisioning/executionRelease";
import { BindingJournalInFlight } from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import {
  InFlightBindingReservations,
  withLiveExecutionSessions,
} from "../../../../src/daemon/sessionBroker/registry/ownerLiveness";
import type {
  BindingExecOwnerLiveness,
  BindingKey,
  BindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { openSqliteBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS } from "../../../../src/daemon/sessionBroker/provisioning/executionReowner";
import { exponentialBackoff } from "../../../../src/utils/Backoff";
import { logger } from "../../../../src/utils/logger";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../../helpers/fakeTimerStepping";

const PREVIOUS = { daemonId: "previous", pid: 4100 };
const OWNER = { daemonId: "current", pid: 4200 };
const PEERS = [4300, 4400];
const S = "resumed-session";
const S2 = "fresh-session";
const DEVICE = "binding-device";
const BINDING = { generation: 1, stableDeviceId: DEVICE };
type Step = "findExecutionAssignments" | "claimExecution" | "openBindingJournal";

// Faults affect only the current daemon's handle; peers read the real shared SQLite registry.
function makeBusy(registry: BindingRegistry) {
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
  let registry: BindingRegistry;
  let faults: ReturnType<typeof makeBusy>;
  let reowner: ManagedExecutionReowner;
  let drain: BrokerExecutionRelease;
  let key: BindingKey;
  let judge: BindingExecOwnerLiveness;
  let liveSessions: Set<string>;
  let held: boolean;
  let active: boolean;
  let warn: ReturnType<typeof spyOn>;
  let info: ReturnType<typeof spyOn>;
  const holds = new InFlightBindingReservations();

  function viewOf(pid: number): BindingExecOwnerLiveness {
    return withLiveExecutionSessions(
      (owner) => [OWNER.pid, ...PEERS].includes(owner.pid),
      {
        isLiveManagedExecutionSession: (id) =>
          (pid === OWNER.pid && liveSessions.has(id)) ||
          (pid !== OWNER.pid && id === `${S2}-${pid}`),
      },
      {
        thisProcess: { pid },
        reservations: pid === OWNER.pid ? holds : new InFlightBindingReservations(),
      },
    );
  }

  async function setUp(): Promise<void> {
    timer = new FakeTimer();
    liveSessions = new Set([S]);
    held = true;
    active = false;
    judge = viewOf(OWNER.pid);
    registry = await openSqliteBindingRegistry({
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
    key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    await registry.initBinding(key, { role: "app", platform: "android", requestedSpec: {} });
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
    drain = new BrokerExecutionRelease({
      registry: async () => faults.faulty,
      journal: { inFlight: new BindingJournalInFlight() },
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

  function testWithFreshBinding(name: string, run: () => Promise<void>): void {
    describe("fresh SQLite binding fixture", () => {
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

  testWithFreshBinding(
    "double write failure admits no work before a peer claims; retry loses the binding permanently",
    async () => {
      faults.busy.claimExecution = 1;
      faults.busy.openBindingJournal = 100;
      const attempt = reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeInstanceOf(BindingOwnershipUnconfirmedError);
      expect(reowner.automationRefusal(S)?.message).toContain("not recorded");
      await attempt;
      expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)?.message).toContain(
        "terminal after binding-ownership-lost",
      );
      expect(reowner.automationRefusal(S)).toBeInstanceOf(BindingOwnershipLostError);
      await reowner.reown([S]);
      expect(reowner.automationRefusal(S)?.message).toContain(
        "terminal after binding-ownership-lost",
      );
      expect(
        warn.mock.calls.filter(([message]: unknown[]) =>
          String(message).includes("no longer owns"),
        ),
      ).toHaveLength(1);
      expect(warn.mock.calls).toHaveLength(1);
      expect(info.mock.calls).toHaveLength(0);
      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: { sessionUuid: `${S2}-${PEERS[0]}` },
        generation: 1,
      });
    },
  );

  testWithFreshBinding(
    "busy claims follow injected exponential backoff before admission and fence both peers",
    async () => {
      faults.busy.claimExecution = 3;
      await reowner.reown([S], { rehydrated: true });
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 25]);
      expect(faults.calls.claimExecution).toBe(1);
      await advance(24);
      expect(faults.calls.claimExecution).toBe(1);
      await advance(1);
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 25]);
      expect(reowner.automationRefusal(S)).toBeDefined();
      await advance(25);
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 40]);
      expect(reowner.automationRefusal(S)).toBeDefined();
      await advance(40);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: { ...OWNER, sessionUuid: S },
      });
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
      expect(warn.mock.calls).toHaveLength(0);
      expect(info.mock.calls).toHaveLength(1);
      expect(info.mock.calls[0][0]).toContain("4 attempts");
    },
  );

  testWithFreshBinding(
    "failed lookup remains gated until the retry reads and claims the binding",
    async () => {
      faults.busy.findExecutionAssignments = 1;
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(faults.calls.claimExecution).toBeUndefined();
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
    },
  );

  testWithFreshBinding(
    "lost acknowledgment keeps the gate closed although both peers already see the committed owner",
    async () => {
      faults.commitsThenThrows.claimExecution = 1;
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(faults.calls.claimExecution).toBe(1);
    },
  );

  testWithFreshBinding(
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
      expect((await claimAs(PEERS[0]!)).kind).toBe("binding_in_use");
    },
  );

  testWithFreshBinding(
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

  testWithFreshBinding(
    "delayed explicit and listener releases of the lost session cannot change the fresh peer session",
    async () => {
      faults.busy.claimExecution = 1;
      await reowner.reown([S], { rehydrated: true });
      expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
      await advance(25);
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
      expect(await registry.listOpenBindingJournal(key)).toEqual([]);
      expect(faults.calls.openBindingJournal).toBeUndefined();
      expect(reowner.automationRefusal(S)).toBeDefined();
    },
  );

  testWithFreshBinding(
    "confirmed ownership fences every daemon when both release writes fail under active work",
    async () => {
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeUndefined();
      active = true;
      faults.busy.openBindingJournal = 100;
      faults.busy.claimExecution = 100;
      await drain.releaseExecution(S);
      expect(active).toBe(true);
      expect(await registry.getAssignment(key)).toMatchObject({
        state: "ready",
        execOwner: { ...OWNER, sessionUuid: S },
      });
      for (const pid of [OWNER.pid, ...PEERS]) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
      drain.close();
      await drain.whenIdle();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
    },
  );

  testWithFreshBinding(
    "a peer winning between read and claim reports binding_in_use and warns once",
    async () => {
      faults.hooks.beforeClaim = async () => {
        faults.hooks.beforeClaim = undefined;
        expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
      };
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)?.message).toContain(
        "terminal after binding-ownership-lost",
      );
      expect(timer.getPendingTimeouts()).toEqual([]);
      await reowner.reown([S]);
      expect(warn.mock.calls).toHaveLength(1);
      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: { sessionUuid: `${S2}-${PEERS[0]}` },
      });
    },
  );

  testWithFreshBinding(
    "every binding must be confirmed before a multi-binding session is admitted",
    async () => {
      const second = { ...key, bindingIndex: 1 };
      await registry.initBinding(second, { role: "other", platform: "android", requestedSpec: {} });
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
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(await registry.getAssignment(second)).toMatchObject({
        execOwner: { ...OWNER, sessionUuid: S },
      });
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
    },
  );

  testWithFreshBinding(
    "non-rehydration failures mark nothing, gate nothing, and retry nothing",
    async () => {
      faults.busy.findExecutionAssignments = 1;
      expect(await reowner.reown([S])).toEqual([]);
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(reowner.automationRefusal("never-rehydrated")).toBeUndefined();
      expect(timer.getPendingTimeouts()).toEqual([]);
    },
  );

  testWithFreshBinding(
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
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 25]);
      await advance(24);
      expect(opens).toBe(1);
      await advance(1);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
    },
  );

  testWithFreshBinding("a host without a registry marks and gates nothing", async () => {
    const absent = new ManagedExecutionReowner({
      registry: async () => {
        throw new Error("must not open");
      },
      registryExists: () => false,
      owner: () => OWNER,
      timer,
    });
    absent.noteRecovering(S, Promise.resolve());
    expect(await absent.reown([S], { rehydrated: true })).toEqual([]);
    expect(absent.automationRefusal(S)).toBeUndefined();
    absent.close();
    await absent.whenIdle();
  });

  testWithFreshBinding(
    "stale binding between lookup and claim is retried with a fresh binding",
    async () => {
      let moved = false;
      faults.hooks.beforeClaim = async () => {
        if (!moved) {
          moved = true;
          expect(
            (await registry.updateBindingState(key, BINDING, "settling", { settler: PREVIOUS }))
              .kind,
          ).toBe("updated");
          expect(
            (await registry.updateBindingState(key, { ...BINDING, generation: 2 }, "ready")).kind,
          ).toBe("updated");
        }
      };
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 25]);
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
    },
  );

  testWithFreshBinding(
    "binding_not_ready stays gated through dead-settler recovery and a peer claim, then loses ownership",
    async () => {
      await registry.updateBindingState(key, BINDING, "settling", { settler: PREVIOUS });
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 25]);
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_not_ready");
      }
      judge = viewOf(PEERS[0]!);
      expect(await registry.recoverSettledBindings(key.scopeKey)).toHaveLength(1);
      judge = viewOf(OWNER.pid);
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)?.message).toContain(
        "terminal after binding-ownership-lost",
      );
      expect(timer.getPendingTimeouts()).toEqual([]);
    },
  );

  testWithFreshBinding(
    "binding_not_ready stays gated until the ready binding is re-owned",
    async () => {
      await registry.updateBindingState(key, BINDING, "settling", { settler: PREVIOUS });
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeDefined();
      await advance(25);
      await drainUntil(() => timer.getPendingTimeouts().includes(25), {
        description: "the second binding_not_ready attempt to schedule its backoff",
      });
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 25]);
      const assignment = (await registry.getAssignment(key))!;
      await registry.updateBindingState(
        key,
        { ...BINDING, generation: assignment.generation },
        "ready",
      );
      expect(reowner.automationRefusal(S)).toBeDefined();
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(await registry.getAssignment(key)).toMatchObject({
        execOwner: { ...OWNER, sessionUuid: S },
      });
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
    },
  );

  testWithFreshBinding(
    "foreign-owner evidence gates an unmarked failed claim until retry confirms",
    async () => {
      faults.busy.claimExecution = 1;
      await reowner.reown([S]);
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 25]);
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
    },
  );

  testWithFreshBinding(
    "foreign-owner evidence gates an unmarked binding_not_ready refusal",
    async () => {
      await registry.updateBindingState(key, BINDING, "settling", { settler: PREVIOUS });
      await reowner.reown([S]);
      expect(reowner.automationRefusal(S)).toBeDefined();
      expect(timer.getPendingTimeouts()).toEqual([MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, 25]);
      judge = viewOf(PEERS[0]!);
      await registry.recoverSettledBindings(key.scopeKey);
      judge = viewOf(OWNER.pid);
      expect((await claimAs(PEERS[0]!)).kind).toBe("claimed");
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)?.message).toContain(
        "terminal after binding-ownership-lost",
      );
    },
  );

  testWithFreshBinding(
    "records already naming this daemon never mark an unmarked session",
    async () => {
      await registry.claimExecution(
        key,
        BINDING,
        { ...OWNER, sessionUuid: S },
        { supersedesSessionUuid: S },
      );
      faults.busy.claimExecution = 1;
      await reowner.reown([S]);
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(faults.calls.claimExecution).toBeUndefined();
      expect(timer.getPendingTimeouts()).toEqual([]);
    },
  );

  testWithFreshBinding(
    "foreign-owner evidence marks an unmarked binding_in_use refusal lost",
    async () => {
      faults.hooks.beforeClaim = async () => {
        faults.hooks.beforeClaim = undefined;
        judge = viewOf(PEERS[0]!);
        try {
          expect(
            (
              await registry.claimExecution(key, BINDING, {
                daemonId: `peer-${PEERS[0]}`,
                pid: PEERS[0]!,
                sessionUuid: `${S2}-${PEERS[0]}`,
              })
            ).kind,
          ).toBe("claimed");
        } finally {
          judge = viewOf(OWNER.pid);
        }
      };
      await reowner.reown([S]);
      expect(reowner.automationRefusal(S)).toBeInstanceOf(BindingOwnershipLostError);
      expect(timer.getPendingTimeouts()).toEqual([]);
      expect(warn.mock.calls).toHaveLength(1);
    },
  );

  testWithFreshBinding("an inline failure after close is not logged", async () => {
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      faults.hooks.afterLookup = () => reowner.close();
      faults.commitsThenThrows.findExecutionAssignments = 1;
      await reowner.reown([S], { rehydrated: true });
      await reowner.whenIdle();
      expect(warn.mock.calls).toEqual([]);
      expect(debug.mock.calls).toHaveLength(0);
      expect(reowner.automationRefusal(S)).toBeDefined();
    } finally {
      debug.mockRestore();
    }
  });

  testWithFreshBinding(
    "a background attempt interrupted before lookup cannot confirm ownership or release its hold",
    async () => {
      reowner.close();
      const opened = Promise.withResolvers<BindingRegistry>();
      const recovering = Promise.withResolvers<void>();
      const confirmed: string[] = [];
      let opens = 0;
      reowner = new ManagedExecutionReowner({
        registry: async () => (++opens === 1 ? faults.faulty : opened.promise),
        owner: () => OWNER,
        timer,
        retryBackoff: exponentialBackoff({ initialDelayMs: 10, maxDelayMs: 40 }),
        isSessionHeld: () => held,
        onOwnershipConfirmed: (id) => {
          confirmed.push(id);
        },
      });
      faults.busy.claimExecution = 1;
      await reowner.reown([S], { rehydrated: true });
      const hold = timedHold(reowner.releaseDeviceHold(S));
      let settled: string | undefined;
      void hold.settled.then((outcome) => {
        settled = outcome;
      });
      await advance(25);
      expect(opens).toBe(2);
      reowner.noteRecovering(S, recovering.promise);
      opened.resolve(faults.faulty);
      await drainMicrotasks(80);
      expect(reowner.ownershipState(S)).toBe("unconfirmed");
      expect(confirmed).toEqual([]);
      expect(settled).toBeUndefined();
      expect(faults.calls.findExecutionAssignments).toBe(1);
      expect((await registry.getAssignment(key))?.execOwner?.daemonId).toBe("previous");
      reowner.close();
      expect(await hold.settled).toBe("skip-device-writes");
      recovering.reject(new Error("interrupted recovery"));
      await reowner.whenIdle();
    },
  );

  testWithFreshBinding(
    "a session no longer held drops its gate and stops registry retries",
    async () => {
      faults.busy.claimExecution = 100;
      await reowner.reown([S], { rehydrated: true });
      held = false;
      expect(reowner.automationRefusal(S)).toBeUndefined();
      const calls = { ...faults.calls };
      await advance(25);
      await reowner.whenIdle();
      expect(faults.calls).toEqual(calls);
      expect(timer.getPendingTimeouts()).toEqual([]);
    },
  );

  testWithFreshBinding(
    "a registerSession attempt can confirm a previously marked session before its retry",
    async () => {
      faults.busy.claimExecution = 1;
      await reowner.reown([S], { rehydrated: true });
      await reowner.reown([S]);
      expect(reowner.automationRefusal(S)).toBeUndefined();
      const calls = { ...faults.calls };
      await advance(25);
      await reowner.whenIdle();
      expect(faults.calls).toEqual(calls);
      for (const pid of PEERS) {
        expect((await claimAs(pid)).kind).toBe("binding_in_use");
      }
    },
  );

  testWithFreshBinding(
    "one session's thrown lookup does not stop another session's inline attempt",
    async () => {
      faults.busy.findExecutionAssignments = 1;
      await reowner.reown(["missing", S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(reowner.automationRefusal("missing")).toBeDefined();
      await advance(25);
      await reowner.whenIdle();
      expect(reowner.automationRefusal("missing")?.message).toContain(
        "terminal after binding-ownership-lost",
      );
    },
  );
  testWithFreshBinding(
    "recovering before publication keeps its gate through early pruning and starts its own claim",
    async () => {
      held = false;
      const recovered = Promise.withResolvers<void>();
      reowner.noteRecovering(S, recovered.promise);
      expect(reowner.ownershipState(S)).toBe("unconfirmed");
      expect(reowner.automationRefusal(S)).toBeInstanceOf(BindingOwnershipUnconfirmedError);
      await reowner.reown(["other"], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeInstanceOf(BindingOwnershipUnconfirmedError);
      expect(faults.calls.findExecutionAssignments).toBeUndefined();
      held = true;
      recovered.resolve();
      await drainMicrotasks(80);
      await reowner.whenIdle();
      expect(reowner.automationRefusal(S)).toBeUndefined();
      expect(faults.calls.claimExecution).toBe(1);
      await reowner.reown([S], { rehydrated: true });
      expect(reowner.automationRefusal(S)).toBeUndefined();
    },
  );

  testWithFreshBinding(
    "a failed unpublished recovery drops its gate without registry work",
    async () => {
      held = false;
      const recovered = Promise.withResolvers<void>();
      reowner.noteRecovering(S, recovered.promise);
      expect(reowner.automationRefusal(S)).toBeDefined();
      recovered.reject(new Error("creation rolled back"));
      await drainMicrotasks(80);
      expect(reowner.ownershipState(S)).toBeUndefined();
      expect(faults.calls.findExecutionAssignments).toBeUndefined();
    },
  );

  testWithFreshBinding(
    "a rejected recovery retains its gate only while a session is still held",
    async () => {
      const recovered = Promise.withResolvers<void>();
      reowner.noteRecovering(S, recovered.promise);
      recovered.reject(new Error("creation failed while another holder remained"));
      await drainMicrotasks(80);
      expect(reowner.ownershipState(S)).toBe("unconfirmed");
      held = false;
      expect(reowner.automationRefusal(S)).toBeUndefined();
      reowner.close();
      reowner.noteRecovering(S, Promise.resolve());
      expect(reowner.ownershipState(S)).toBeUndefined();
    },
  );

  testWithFreshBinding(
    "only a marked confirmation notifies warm-up once; loss never does",
    async () => {
      reowner.close();
      const confirmed: string[] = [];
      const lost: string[] = [];
      reowner = new ManagedExecutionReowner({
        registry: async () => faults.faulty,
        owner: () => OWNER,
        timer,
        isSessionHeld: () => held,
        onOwnershipConfirmed: (id) => {
          confirmed.push(id);
        },
        onOwnershipLost: (id) => {
          lost.push(id);
        },
      });
      await reowner.reown([S], { rehydrated: true });
      await reowner.reown([S]);
      expect(confirmed).toEqual([S]);
      expect(warn.mock.calls).toHaveLength(0);
      expect(info.mock.calls).toHaveLength(1);
      await reowner.reown(["missing"], { rehydrated: true });
      expect(confirmed).toEqual([S]);
      expect(reowner.ownershipState("missing")).toBe("lost");
      expect(lost).toEqual(["missing"]);
      expect(warn.mock.calls).toHaveLength(1);
      expect(info.mock.calls).toHaveLength(1);
    },
  );
});

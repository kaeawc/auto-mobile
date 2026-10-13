import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  ManagedSlotAcquisition,
  type ManagedSlotAcquisitionDependencies,
  type ManagedSlotAcquisitionSessions,
} from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
} from "../../../src/daemon/managedSlots/reconciler";
import {
  InFlightSlotReservations,
  withLiveExecutionSessions,
} from "../../../src/daemon/managedSlots/slotOwnerLiveness";
import {
  computeSlotScopeKey,
  type SlotExecOwnerLiveness,
  type SlotKey,
  type SlotRegistry,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { openSqliteSlotRegistry } from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { RegistryRetryPacing } from "../../../src/daemon/managedSlots/registryRetryPacing";
import { MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS } from "../../../src/daemon/managedSlots/managedExecutionRelease";
import { parseManagedSlotConfig } from "../../../src/models/managedSlotConfig";
import { logger } from "../../../src/utils/logger";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

const OWNER = { daemonId: "daemon-a", pid: 4242, processGenerationToken: "linux:boot:1" };
const PEER = { daemonId: "daemon-b", pid: 4300, processGenerationToken: "linux:boot:2" };
const CONFIG = parseManagedSlotConfig({
  contractVersion: 1,
  managedHostScope: "host",
  runnerNamespace: "runner",
  runnerIncarnation: "inc-1",
  localSlotCapacity: 1,
  requests: [
    {
      slotIndex: 0,
      role: "app",
      platform: "ios",
      requestedSpec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      },
    },
  ],
});
const KEY = { scopeKey: computeSlotScopeKey(CONFIG), slotIndex: 0 };
const OPTIONS = { livenessOwnerToken: "proxy-token" };
type FailureCase = "refused" | "cancelled" | "policy" | "group";

class Sessions implements ManagedSlotAcquisitionSessions {
  readonly live = new Set<string>();
  readonly managed = new Set<string>();
  readonly releases: string[] = [];
  refuse: string | undefined;
  policyThrows = false;
  releaseFailures = 0;
  releaseCommitsThenThrows = false;
  readonly events: string[] = [];

  async claimLivenessOwnership(session: string) {
    return this.refuse === session ? ("conflict" as const) : ("claimed" as const);
  }
  async adoptManagedExecutionLivenessPolicy(session: string): Promise<void> {
    if (this.policyThrows) {
      throw new Error("policy failed");
    }
    this.managed.add(session);
  }
  async releaseSession(session: string): Promise<void> {
    this.releases.push(session);
    this.events.push(`session:${session}`);
    if (this.releaseFailures-- > 0) {
      if (this.releaseCommitsThenThrows) {
        this.live.delete(session);
      }
      throw new Error("session release busy");
    }
    this.live.delete(session);
  }
}

describe("ManagedSlotAcquisition back-out retry", () => {
  let timer: FakeTimer;
  let registry: SlotRegistry;
  let sessions: Sessions;
  let provisioner: FakeProvisioner;
  let deps: ManagedSlotAcquisitionDependencies;
  let acquisition: ManagedSlotAcquisition;
  let judge: SlotExecOwnerLiveness;
  let local: SlotExecOwnerLiveness;
  let peer: SlotExecOwnerLiveness;
  let busy: number;
  let busyUntilMs: number;
  let blockedMs: number;
  let lostAck: boolean;
  let clearCalls: Array<{ key: SlotKey; session: string; at: number }>;
  let afterRead: (() => void) | undefined;
  let readFailures: number;
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
  let debug: ReturnType<typeof spyOn<typeof logger, "debug">>;
  let info: ReturnType<typeof spyOn<typeof logger, "info">>;
  let warnedAt: number[];

  async function setUp(): Promise<void> {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    sessions = new Sessions();
    const processLive = (owner: { pid: number }) => [OWNER.pid, PEER.pid].includes(owner.pid);
    const view = (pid: number) =>
      withLiveExecutionSessions(
        processLive,
        { isLiveManagedExecutionSession: (session) => sessions.live.has(session) },
        { thisProcess: { pid }, reservations: new InFlightSlotReservations() },
      );
    local = view(OWNER.pid);
    peer = view(PEER.pid);
    judge = local;
    registry = await openSqliteSlotRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: (owner) => judge(owner),
    });
    busy = 0;
    busyUntilMs = 0;
    blockedMs = 0;
    lostAck = false;
    clearCalls = [];
    afterRead = undefined;
    readFailures = 0;
    const faulty = new Proxy(registry, {
      get(target, property) {
        if (property === "releaseExecution") {
          return async (key: SlotKey, session: string) => {
            clearCalls.push({ key, session, at: timer.now() });
            sessions.events.push(`owner:${session}`);
            if (busy-- > 0 || timer.now() < busyUntilMs) {
              timer.setCurrentTime(timer.now() + blockedMs);
              if (lostAck) {
                await target.releaseExecution(key, session);
              }
              throw new Error("SQLITE_BUSY: database is locked");
            }
            return target.releaseExecution(key, session);
          };
        }
        if (property === "getAssignment") {
          return async (key: SlotKey) => {
            if (readFailures-- > 0) {
              throw new Error("SQLITE_BUSY: owner read is locked");
            }
            const assignment = await target.getAssignment(key);
            afterRead?.();
            return assignment;
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    const reconciler = new ManagedSlotReconciler({
      registry: faulty,
      inventory,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter: new FakeDeleter(inventory),
      claims: new FakeClaims(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: (owner) => judge(owner),
    });
    deps = {
      registry: async () => faulty,
      reconcile: async (_registry, request) => {
        const result = await reconciler.reconcile(request);
        if (result.outcome === "ready") {
          sessions.live.add(result.sessionUuid);
        }
        return result;
      },
      sessions,
      owner: () => OWNER,
      timer,
    };
    acquisition = new ManagedSlotAcquisition(deps);
    warnedAt = [];
    warn = spyOn(logger, "warn").mockImplementation(() => {
      warnedAt.push(timer.now());
    });
    debug = spyOn(logger, "debug").mockImplementation(() => {});
    info = spyOn(logger, "info").mockImplementation(() => {});
  }

  async function tearDown(): Promise<void> {
    // Also usable for the pre-fix probe, before lifecycle methods exist.
    if ("close" in acquisition) {
      acquisition.close();
      await acquisition.whenIdle();
    }
    await registry.close();
    warn.mockRestore();
    debug.mockRestore();
    info.mockRestore();
  }

  // Each scenario has an isolated in-memory database. Migration/driver setup is fixture work,
  // outside the measured test body; the real acquisition and all recovery assertions stay inside.
  function scenario(name: string, body: () => Promise<void>): void {
    describe(name, () => {
      beforeAll(setUp);
      afterAll(tearDown);
      test(name, body);
    });
  }

  function scenarios<T>(
    cases: readonly T[],
    name: (item: T) => string,
    body: (item: T) => Promise<void>,
  ): void {
    for (const item of cases) {
      scenario(name(item), () => body(item));
    }
  }

  async function fail(kind: FailureCase) {
    const abort = new AbortController();
    sessions.refuse = kind === "group" ? "session-2" : kind === "refused" ? "session-1" : undefined;
    sessions.policyThrows = kind === "policy";
    if (kind === "cancelled") {
      provisioner.beforeReturn = async () => {
        abort.abort();
      };
    }
    const config =
      kind === "group"
        ? {
            ...CONFIG,
            requests: [
              ...CONFIG.requests,
              { ...CONFIG.requests[0]!, slotIndex: 1, role: "secondary" },
            ],
          }
        : CONFIG;
    return acquisition.acquire(config, { ...OPTIONS, signal: abort.signal });
  }

  async function claim(view: SlotExecOwnerLiveness, session: string, key = KEY) {
    judge = view;
    try {
      const assignment = (await registry.getAssignment(key))!;
      return await registry.claimExecution(
        key,
        {
          generation: assignment.generation,
          stableDeviceId: assignment.stableDeviceId,
        },
        { ...(view === peer ? PEER : OWNER), sessionUuid: session },
      );
    } finally {
      judge = local;
    }
  }

  const CASES = (["refused", "cancelled", "policy", "group"] as const).flatMap((kind) =>
    ([false, true] as const).map((ackLost) => ({ kind, ackLost })),
  );
  scenarios(
    CASES,
    ({ kind, ackLost }) =>
      `${kind}, committed-but-lost-ack=${ackLost}: peer and local recover without restart`,
    async ({ kind, ackLost }) => {
      busy = kind === "group" ? 2 : 1;
      lostAck = ackLost;
      const result = await fail(kind);
      expect(result.outcome).toBe("failed");
      expect(result.failure?.code).toBe(
        {
          refused: "liveness_owner_conflict",
          cancelled: "cancelled",
          policy: "execution_policy_failed",
          group: "liveness_owner_conflict",
        }[kind],
      );
      expect(sessions.releases).toContain("session-1");
      expect(sessions.managed.has("session-1")).toBe(kind === "cancelled" || kind === "group");
      const before = (await registry.getAssignment(KEY))!;
      expect(before.state).toBe("ready");
      expect(before.stableDeviceId).not.toBeNull();
      const inlineCalls = kind === "group" ? 2 : 1;
      expect(clearCalls).toHaveLength(inlineCalls);
      expect(timer.now()).toBe(1_000_000);
      if (!ackLost) {
        expect(before.execOwner?.sessionUuid).toBe("session-1");
        expect((await claim(peer, "peer-probe")).kind).toBe("slot_in_use");
      }
      expect(acquisition.pendingBackOutCleanups()).toHaveLength(inlineCalls);
      await tick();
      await acquisition.whenIdle();
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
      expect(await registry.getAssignment(KEY)).toMatchObject({
        state: "ready",
        stableDeviceId: before.stableDeviceId,
        execOwner: null,
      });
      expect(clearCalls).toHaveLength(ackLost ? inlineCalls : inlineCalls * 2);
      if (kind === "group") {
        expect(await registry.getAssignment({ ...KEY, slotIndex: 1 })).toMatchObject({
          execOwner: null,
          state: "ready",
        });
      }
      expect((await claim(peer, "peer-next")).kind).toBe("claimed");
      await registry.releaseExecution(KEY, "peer-next");
      expect((await claim(local, "local-next")).kind).toBe("claimed");
    },
  );

  scenario("pin: successful inline clear and release schedule no work", async () => {
    await fail("refused");
    expect(clearCalls).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(timer.getPendingSleepCount()).toBe(0);
    expect(await registry.getAssignment(KEY)).toMatchObject({ execOwner: null, state: "ready" });
    if ("pendingBackOutCleanups" in acquisition) {
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  async function tick(ms = 25): Promise<void> {
    timer.advanceTime(ms);
    // Two group-slot retries share serialized transactions and per-step deadline races.
    await drainMicrotasks(120);
  }

  async function hangGroupRelease() {
    busy = 2;
    sessions.refuse = "session-2";
    sessions.releaseFailures = 1;
    // Put slot 0 last so its failed hand-off retains cleanup before slot 1's group unwind.
    expect(
      (
        await acquisition.acquire(
          {
            ...CONFIG,
            requests: [{ ...CONFIG.requests[0]!, slotIndex: 1 }, ...CONFIG.requests],
          },
          OPTIONS,
        )
      ).outcome,
    ).toBe("failed");
    expect(acquisition.pendingBackOutCleanups().map((entry) => entry.key.slotIndex)).toEqual([
      0, 1,
    ]);
    const pending = Promise.withResolvers<void>();
    const release = sessions.releaseSession.bind(sessions);
    const calls: string[] = [];
    sessions.releaseSession = (session) => {
      calls.push(session);
      return session === "session-2" ? pending.promise : release(session);
    };
    return { pending, calls, release };
  }

  scenario("back-out gives the shared turn back at one total attempt deadline", async () => {
    sessions.releaseFailures = 1;
    busy = 1;
    await fail("refused");
    const release = Promise.withResolvers<void>();
    const read = Promise.withResolvers<Awaited<ReturnType<SlotRegistry["getAssignment"]>>>();
    let releaseCalls = 0;
    sessions.releaseSession = () => {
      releaseCalls++;
      return release.promise;
    };
    const reads = spyOn(registry, "getAssignment").mockImplementation(() => read.promise);
    const pacing = new RegistryRetryPacing({
      timer,
    });
    const expedite = new AbortController();
    expedite.abort();
    let started: number | undefined;
    let queued: Promise<boolean> | undefined;
    try {
      await tick(25);
      const start = timer.now();
      queued = pacing.run(
        async () => {
          started = timer.now();
          return true;
        },
        (r) => r,
        undefined,
        expedite.signal,
      );
      await tick(400);
      release.resolve();
      await drainUntil(() => reads.mock.calls.length === 1, {
        description: "ownership read after release",
      });
      await tick(MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS - 401);
      expect(started).toBeUndefined();
      await tick(1);
      expect(started).toBe(start + MANAGED_EXECUTION_SESSION_RELEASE_BUDGET_MS);
      await queued;
      expect(releaseCalls).toBe(1);
      expect(acquisition.pendingBackOutCleanups()[0]?.sessionReleaseOwed).toBe(false);
    } finally {
      acquisition.close();
      pacing.close();
      release.resolve();
      read.resolve(null);
      await Promise.allSettled(queued ? [queued] : []);
      reads.mockRestore();
    }
  });

  scenarios(
    [300, 6_000],
    (n) => `inline back-out shares ${n} ms blocked quiet time`,
    async (n) => {
      busy = 1;
      blockedMs = n;
      const pacing = new RegistryRetryPacing({
        timer,
      });
      let started = false;
      let next: Promise<boolean> | undefined;
      try {
        await fail("refused");
        const end = timer.now();
        next = pacing.run(
          async () => {
            started = true;
            return true;
          },
          (r) => r,
        );
        await tick(Math.min(n, 5_000) - 1);
        expect(started).toBe(false);
        await tick(1);
        await next;
        expect(timer.now()).toBe(end + Math.min(n, 5_000));
      } finally {
        pacing.close();
        await Promise.allSettled(next ? [next] : []);
      }
    },
  );

  scenario(
    "back-out and another pacer serialize and share each blocked attempt's quiet time",
    async () => {
      sessions.releaseFailures = 1;
      busy = 1;
      await fail("refused");
      const release = Promise.withResolvers<void>();
      sessions.releaseSession = () => release.promise;
      const pacing = new RegistryRetryPacing({
        timer,
      });
      let otherStarted = false;
      let other: Promise<boolean> | undefined;
      try {
        await tick(25);
        const start = timer.now();
        other = pacing.run(
          async () => {
            otherStarted = true;
            timer.setCurrentTime(timer.now() + 100);
            return false;
          },
          (r) => r,
        );
        await tick(100);
        expect(otherStarted).toBe(false);
        release.reject(new Error("session busy"));
        await drainMicrotasks(100);
        await tick(99);
        expect(otherStarted).toBe(false);
        await tick(1);
        await other;
        expect(timer.now()).toBe(start + 300);
        expect(acquisition.pendingBackOutCleanups()[0]?.attempts).toBe(1);
        sessions.releaseSession = async () => {};
        await tick(99);
        expect(acquisition.pendingBackOutCleanups()[0]?.attempts).toBe(1);
        await tick(1);
        await acquisition.whenIdle();
        expect(acquisition.pendingBackOutCleanups()).toEqual([]);
      } finally {
        acquisition.close();
        pacing.close();
        release.resolve();
        await Promise.allSettled(other ? [other] : []);
      }
    },
  );

  scenario("back-out does not share turns or quiet time with a different timer", async () => {
    sessions.releaseFailures = 1;
    busy = 1;
    await fail("refused");
    const release = Promise.withResolvers<void>();
    sessions.releaseSession = () => release.promise;
    const pacing = new RegistryRetryPacing({
      timer: new FakeTimer(),
    });
    try {
      await tick(25);
      expect(
        await pacing.run(
          async () => true,
          (r) => r,
        ),
      ).toBe(true);
      expect(acquisition.pendingBackOutCleanups()[0]?.attempts).toBe(1);
    } finally {
      acquisition.close();
      pacing.close();
      release.resolve();
    }
  });

  scenario("hung session release frees the shared turn and never piles up calls", async () => {
    const { pending, calls } = await hangGroupRelease();
    try {
      const otherKey = { ...KEY, slotIndex: 1 };
      const before = (await registry.getAssignment(otherKey))!;
      await tick();
      await tick(700);
      expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
        key: KEY,
        sessionReleaseOwed: true,
        lastError: expect.stringContaining("session release timed out after 700ms"),
      });
      // The failed attempt also owes 700 ms of shared quiet time.
      await tick(700);
      expect(await registry.getAssignment(otherKey)).toMatchObject({
        execOwner: null,
        stableDeviceId: before.stableDeviceId,
      });
      expect(acquisition.pendingBackOutCleanups()).toHaveLength(1);
      for (let event = 0; event < 12; event++) {
        await tick(timer.getMsUntilNextDueEvent()!);
      }
      expect(calls).toEqual(["session-2"]);
      expect(acquisition.pendingBackOutCleanups()[0]!.attempts).toBeGreaterThan(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(debug.mock.calls.some(([message]) => String(message).includes("retry failed"))).toBe(
        true,
      );
    } finally {
      acquisition.close();
      pending.resolve();
      await drainMicrotasks(100);
    }
  });

  scenario("close wakes a hung release and the cleanup queued behind it immediately", async () => {
    const { pending, calls } = await hangGroupRelease();
    const reads = spyOn(registry, "getAssignment");
    try {
      await tick();
      expect(acquisition.pendingBackOutCleanups().map((entry) => entry.attempts)).toEqual([1, 0]);
      const before = {
        reads: reads.mock.calls.length,
        clears: clearCalls.length,
        debug: debug.mock.calls.length,
        info: info.mock.calls.length,
        warn: warn.mock.calls.length,
      };
      let idle = false;
      void acquisition.whenIdle().then(() => {
        idle = true;
      });
      acquisition.close();
      await drainMicrotasks(100);
      expect(idle).toBe(true);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      pending.resolve();
      await tick(60_000);
      expect(calls).toEqual(["session-2"]);
      expect(reads).toHaveBeenCalledTimes(before.reads);
      expect(clearCalls).toHaveLength(before.clears);
      expect(debug).toHaveBeenCalledTimes(before.debug);
      expect(info).toHaveBeenCalledTimes(before.info);
      expect(warn).toHaveBeenCalledTimes(before.warn);
    } finally {
      acquisition.close();
      pending.resolve();
      await drainMicrotasks(100);
      reads.mockRestore();
    }
  });

  scenario("late session release leaves this daemon's newly acquired owner untouched", async () => {
    const { pending, calls } = await hangGroupRelease();
    try {
      await tick();
      await tick(700);
      expect(acquisition.pendingBackOutCleanups()[0]!.lastError).toContain(
        "session release timed out after 700ms",
      );
      sessions.refuse = undefined;
      // The old release committed, but its acknowledgement is still hung.
      sessions.live.delete("session-2");
      const next = await acquisition.acquire(CONFIG, OPTIONS);
      expect(next.outcome).toBe("ready");
      expect(next.slots[0]!.sessionUuid).toBe("session-3");
      const clears = clearCalls.length;
      pending.resolve();
      await tick(700);
      await acquisition.whenIdle();
      expect(await registry.getAssignment(KEY)).toMatchObject({
        execOwner: { ...OWNER, sessionUuid: "session-3" },
      });
      expect(clearCalls.slice(clears).filter((call) => call.session === "session-2")).toEqual([]);
      expect(calls).toEqual(["session-2"]);
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    } finally {
      acquisition.close();
      pending.resolve();
      await drainMicrotasks(100);
    }
  });

  scenario(
    "late session rejection is observed and a fresh release lands on the next attempt",
    async () => {
      const { pending, calls, release } = await hangGroupRelease();
      try {
        await tick();
        await tick(700);
        pending.reject(new Error("late session failure"));
        await drainMicrotasks(100);
        sessions.releaseSession = (session) => {
          calls.push(session);
          return release(session);
        };
        await tick(700);
        await acquisition.whenIdle();
        expect(calls).toEqual(["session-2", "session-2"]);
        expect(acquisition.pendingBackOutCleanups()).toEqual([]);
        expect(await registry.getAssignment(KEY)).toMatchObject({ execOwner: null });
      } finally {
        acquisition.close();
        pending.resolve();
        await drainMicrotasks(100);
      }
    },
  );

  scenario(
    "hung ownership read is reused but its late stale result never authorizes a write",
    async () => {
      busy = 1;
      await fail("refused");
      const stale = (await registry.getAssignment(KEY))!;
      const pending = Promise.withResolvers<typeof stale>();
      const getAssignment = registry.getAssignment.bind(registry);
      const reads = spyOn(registry, "getAssignment").mockImplementationOnce(() => pending.promise);
      try {
        await tick();
        await tick(700);
        expect(acquisition.pendingBackOutCleanups()[0]!.lastError).toContain(
          "ownership read timed out after 700ms",
        );
        for (const delay of [700, 700, 700]) {
          await tick(delay);
        }
        expect(reads).toHaveBeenCalledTimes(1);
        expect(clearCalls).toHaveLength(1);
        sessions.live.add("replacement");
        expect(
          (await registry.claimExecution(KEY, stale, { ...OWNER, sessionUuid: "replacement" }))
            .kind,
        ).toBe("claimed");
        pending.resolve(stale);
        await drainMicrotasks(120);
        await acquisition.whenIdle();
        expect(reads).toHaveBeenCalledTimes(2);
        expect(clearCalls).toHaveLength(1);
        expect((await getAssignment(KEY))?.execOwner?.sessionUuid).toBe("replacement");
        expect(acquisition.pendingBackOutCleanups()).toEqual([]);
      } finally {
        acquisition.close();
        pending.resolve(stale);
        await drainMicrotasks(100);
        reads.mockRestore();
      }
    },
  );

  scenario(
    "hung owner clear is reused and its conditional late write preserves a new owner",
    async () => {
      busy = 1;
      await fail("refused");
      const binding = (await registry.getAssignment(KEY))!;
      const pending = Promise.withResolvers<void>();
      const releaseExecution = registry.releaseExecution.bind(registry);
      const clears = spyOn(registry, "releaseExecution").mockImplementationOnce(
        async (key, session) => {
          await pending.promise;
          return releaseExecution(key, session);
        },
      );
      const reads = spyOn(registry, "getAssignment");
      try {
        await tick();
        await tick(700);
        expect(acquisition.pendingBackOutCleanups()[0]!.lastError).toContain(
          "owner clear timed out after 700ms",
        );
        for (const delay of [700, 700, 700]) {
          await tick(delay);
        }
        expect(clears).toHaveBeenCalledTimes(1);
        expect(reads).toHaveBeenCalledTimes(1);
        sessions.live.add("replacement");
        expect(
          (await registry.claimExecution(KEY, binding, { ...OWNER, sessionUuid: "replacement" }))
            .kind,
        ).toBe("claimed");
        pending.resolve();
        await drainMicrotasks(120);
        await acquisition.whenIdle();
        expect(clears).toHaveBeenCalledTimes(1);
        expect((await registry.getAssignment(KEY))?.execOwner?.sessionUuid).toBe("replacement");
        expect(acquisition.pendingBackOutCleanups()).toEqual([]);
      } finally {
        acquisition.close();
        pending.resolve();
        await drainMicrotasks(100);
        clears.mockRestore();
        reads.mockRestore();
      }
    },
  );

  scenarios(
    ["getAssignment", "releaseExecution"] as const,
    (step) => `close aborts hung ${step} without late calls or logs`,
    async (step) => {
      busy = 1;
      await fail("refused");
      const pending = Promise.withResolvers<never>();
      const hung = spyOn(registry, step).mockImplementation(() => pending.promise);
      try {
        await tick();
        expect(hung).toHaveBeenCalledTimes(1);
        const clears = clearCalls.length;
        const logCounts = [debug, info, warn].map((log) => log.mock.calls.length);
        acquisition.close();
        let idle = false;
        void acquisition.whenIdle().then(() => {
          idle = true;
        });
        await drainMicrotasks(100);
        expect(idle).toBe(true);
        expect(timer.getPendingTimeoutCount()).toBe(0);
        pending.reject(new Error("late registry rejection after close"));
        await tick(60_000);
        expect(hung).toHaveBeenCalledTimes(1);
        expect(clearCalls).toHaveLength(clears);
        expect([debug, info, warn].map((log) => log.mock.calls.length)).toEqual(logCounts);
      } finally {
        acquisition.close();
        pending.reject(new Error("registry fixture teardown"));
        await drainMicrotasks(100);
        hung.mockRestore();
      }
    },
  );

  scenario(
    "transient busy write lands at 25 ms without delaying the acquisition answer",
    async () => {
      busy = 1;
      const start = timer.now();
      expect((await fail("refused")).outcome).toBe("failed");
      expect(timer.now()).toBe(start);
      expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
        attempts: 0,
        owedSinceMs: start,
        ageMs: 0,
      });
      const before = (await registry.getAssignment(KEY))!;
      expect((await claim(peer, "peer-probe")).kind).toBe("slot_in_use");
      await tick(24);
      expect(clearCalls).toHaveLength(1);
      expect(acquisition.pendingBackOutCleanups()[0]?.ageMs).toBe(24);
      await tick(1);
      expect(clearCalls).toHaveLength(2);
      await acquisition.whenIdle();
      expect(await registry.getAssignment(KEY)).toMatchObject({
        execOwner: null,
        stableDeviceId: before.stableDeviceId,
        state: "ready",
      });
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
      expect((await claim(peer, "peer-next")).kind).toBe("claimed");
      expect(info.mock.calls.filter(([message]) => String(message).includes("landed"))).toEqual([
        [expect.stringContaining("landed after 25 ms (1 retries)")],
      ]);
      expect(
        info.mock.calls.filter(([message]) => String(message).includes("background")),
      ).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  scenario("default schedule doubles from 25 ms to the 1 s cap", async () => {
    busy = 7; // One inline failure plus six background failures.
    await fail("refused");
    for (const delay of [25, 50, 100, 200, 400, 800, 1_000]) {
      expect(timer.getPendingTimeouts()).toEqual([delay]);
      await tick(delay);
    }
    expect(clearCalls.map((call) => call.at - 1_000_000)).toEqual([
      0, 25, 75, 175, 375, 775, 1_575, 2_575,
    ]);
    await acquisition.whenIdle();
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  scenario("blocked attempts wait their duration before each retry", async () => {
    busy = 3;
    blockedMs = 3_300;
    const start = timer.now();
    await fail("refused");
    expect(timer.now() - start).toBe(3_300);
    await tick(25);
    expect(clearCalls).toHaveLength(1);
    await tick(3_274);
    expect(clearCalls).toHaveLength(1);
    await tick(1);
    expect(clearCalls.map((call) => call.at - start)).toEqual([0, 6_600]);
    await tick(3_299);
    expect(clearCalls).toHaveLength(2);
    await tick(1);
    expect(clearCalls.map((call) => call.at - start)).toEqual([0, 6_600, 13_200]);
    // Three blocked attempts have occupied exactly half the elapsed time at convergence.
    busy = 0;
    blockedMs = 0;
    await tick(3_299);
    expect(clearCalls).toHaveLength(3);
    await tick(1);
    await acquisition.whenIdle();
    expect(clearCalls.map((call) => call.at - start)).toEqual([0, 6_600, 13_200, 19_800]);
    expect((3 * 3_300) / (timer.now() - start)).toBe(0.5);
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    expect(await registry.getAssignment(KEY)).toMatchObject({ execOwner: null });
  });

  scenario("blocked attempt wait is capped at 5 s", async () => {
    busy = 1;
    blockedMs = 20_000;
    const start = timer.now();
    await fail("refused");
    expect(timer.now() - start).toBe(20_000);
    await tick(4_999);
    expect(clearCalls).toHaveLength(1);
    await tick(1);
    await acquisition.whenIdle();
    expect(clearCalls.map((call) => call.at - start)).toEqual([0, 25_000]);
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
  });

  scenario("blocked group retries share quiet time across all owed cleanups", async () => {
    busy = Infinity;
    blockedMs = 3_300;
    const acquisitionStartedMs = timer.now();
    expect((await fail("group")).outcome).toBe("failed");
    expect(clearCalls).toHaveLength(2);
    const start = timer.now();
    for (let event = 0; event < 100 && timer.now() - start < 60_000; event++) {
      const delay = timer.getMsUntilNextDueEvent();
      expect(delay).toBeDefined();
      await tick(delay!);
    }
    expect(timer.now() - start).toBeGreaterThanOrEqual(60_000);
    const retries = clearCalls.slice(2);
    expect((retries.length * blockedMs) / (timer.now() - start)).toBeLessThanOrEqual(0.55);
    expect(
      (clearCalls.length * blockedMs) / (timer.now() - acquisitionStartedMs),
    ).toBeLessThanOrEqual(0.55);
    // Inline unwinding stays immediate; every background retry must leave shared quiet time.
    for (let index = 2; index < clearCalls.length; index++) {
      expect(
        clearCalls[index]!.at - (clearCalls[index - 1]!.at + blockedMs),
      ).toBeGreaterThanOrEqual(3_300);
    }
    expect(acquisition.pendingBackOutCleanups()).toHaveLength(2);
    for (const cleanup of acquisition.pendingBackOutCleanups()) {
      expect(cleanup.attempts).toBeGreaterThan(1);
    }
    busy = 0;
    blockedMs = 0;
    const availableAt = timer.now();
    const before = clearCalls.length;
    for (let event = 0; event < 20 && acquisition.pendingBackOutCleanups().length > 0; event++) {
      const delay = timer.getMsUntilNextDueEvent();
      if (delay === undefined) {
        await drainUntil(() => acquisition.pendingBackOutCleanups().length === 0, {
          description: "both group back-out cleanups landing",
        });
        break;
      }
      await tick(delay);
    }
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    await acquisition.whenIdle();
    expect(clearCalls).toHaveLength(before + 2);
    expect(clearCalls.at(-1)!.at - availableAt).toBeLessThanOrEqual(5_000);
    for (const slotIndex of [0, 1]) {
      expect(await registry.getAssignment({ ...KEY, slotIndex })).toMatchObject({
        execOwner: null,
        state: "ready",
      });
    }
  });

  scenario("close during shared group quiet time cancels all work without logging", async () => {
    busy = Infinity;
    blockedMs = 3_300;
    await fail("group");
    await tick(25);
    expect(timer.getPendingTimeouts()).toEqual([3_275]); // Both cleanups share one quiet timer.
    expect(acquisition.pendingBackOutCleanups()).toHaveLength(2);
    const cleared = clearCalls.length;
    const released = sessions.releases.length;
    const warned = warn.mock.calls.length;
    const debugged = debug.mock.calls.length;
    const informed = info.mock.calls.length;
    const reads = spyOn(registry, "getAssignment");
    try {
      acquisition.close();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.getPendingSleepCount()).toBe(0);
      await acquisition.whenIdle();
      await tick(60_000);
      expect(reads).not.toHaveBeenCalled();
      expect(clearCalls).toHaveLength(cleared);
      expect(sessions.releases).toHaveLength(released);
      expect(warn.mock.calls).toHaveLength(warned);
      expect(debug.mock.calls).toHaveLength(debugged);
      expect(info.mock.calls).toHaveLength(informed);
    } finally {
      reads.mockRestore();
    }
  });

  scenario("injected zero and negative backoff retries no sooner than 25 ms", async () => {
    acquisition = new ManagedSlotAcquisition({
      ...deps,
      backOutRetryBackoff: { delayForAttempt: (attempt) => (attempt === 1 ? 0 : -5) },
    });
    busy = 2;
    const start = timer.now();
    await fail("refused");
    for (const count of [1, 2]) {
      await tick(24);
      expect(clearCalls).toHaveLength(count);
      await tick(1);
      expect(clearCalls).toHaveLength(count + 1);
    }
    await acquisition.whenIdle();
    expect(clearCalls.map((call) => call.at - start)).toEqual([0, 25, 50]);
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
  });

  scenario("registry busy for 3 s lands within 1 s of becoming writable", async () => {
    busyUntilMs = timer.now() + 3_000;
    await fail("refused");
    for (const delay of [25, 50, 100, 200, 400, 800, 1_000]) {
      await tick(delay);
    }
    expect(acquisition.pendingBackOutCleanups()[0]?.attempts).toBe(7);
    await tick(1_000);
    expect(clearCalls.at(-1)?.at).toBe(1_003_575);
    expect(clearCalls.at(-1)!.at - busyUntilMs).toBeLessThanOrEqual(1_000);
    await acquisition.whenIdle();
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  scenario("registry busy for 60 s keeps the 1 s cadence and warns once after 5 s", async () => {
    const start = timer.now();
    busyUntilMs = start + 60_001;
    await fail("refused");
    let idle = false;
    const idlePromise = acquisition.whenIdle().then(() => {
      idle = true;
    });
    for (const delay of [25, 50, 100, 200, 400, 800]) {
      await tick(delay);
    }
    for (let step = 0; step < 58; step++) {
      await tick(1_000);
    }
    await tick(425);
    expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
      key: KEY,
      sessionUuid: "session-1",
      attempts: 64,
      owedSinceMs: start,
      ageMs: 60_000,
      ownerClearOwed: true,
      sessionReleaseOwed: false,
      lastError: "SQLITE_BUSY: database is locked",
    });
    expect(idle).toBe(false);
    const lateCalls = clearCalls.slice(-5);
    expect(
      lateCalls.map((call, index) => (index === 0 ? 1_000 : call.at - lateCalls[index - 1]!.at)),
    ).toEqual([1_000, 1_000, 1_000, 1_000, 1_000]);
    expect(warn.mock.calls).toEqual([
      [expect.stringContaining("5575 ms (10 retries)"), expect.any(Error)],
    ]);
    expect(String(warn.mock.calls[0]![0])).toContain("SQLITE_BUSY: database is locked");
    expect(String(warn.mock.calls[0]![0])).toContain("retries continue with waits capped at 5 s");
    expect(warnedAt).toEqual([start + 5_575]);
    expect(
      debug.mock.calls.filter(([message]) => String(message).includes("retry failed")),
    ).toHaveLength(64);
    expect((await claim(peer, "peer-probe")).kind).toBe("slot_in_use");
    // Accessor returns copies, including the nested key and an age computed at call time.
    const snapshot = acquisition.pendingBackOutCleanups()[0]!;
    snapshot.key.slotIndex = 99;
    snapshot.attempts = -1;
    expect(acquisition.pendingBackOutCleanups()[0]!.key).toEqual(KEY);
    await tick(1);
    expect(snapshot.ageMs).toBe(60_000);
    expect(acquisition.pendingBackOutCleanups()[0]?.ageMs).toBe(60_001);
    await tick(574);
    expect(clearCalls.at(-1)!.at - busyUntilMs).toBeLessThanOrEqual(1_000);
    await idlePromise;
    expect(idle).toBe(true);
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    expect(info.mock.calls.filter(([message]) => String(message).includes("landed"))).toEqual([
      [expect.stringContaining("landed after 60575 ms (65 retries)")],
    ]);
    expect(warn.mock.calls).toHaveLength(1);
    expect((await claim(peer, "peer-next")).kind).toBe("claimed");
  });

  async function cappedWait(kind: FailureCase = "refused"): Promise<void> {
    busy = Infinity;
    await fail(kind);
    for (const delay of [25, 50, 100, 200, 400, 800]) {
      await tick(delay);
    }
    expect(acquisition.pendingBackOutCleanups()[0]?.attempts).toBe(6);
    expect(timer.getPendingTimeouts()).toEqual(kind === "group" ? [1_000, 1_000] : [1_000]);
  }

  scenario("later acquisitions schedule no extra timer or registry work", async () => {
    await cappedWait();
    const elsewhere = { ...CONFIG, runnerNamespace: "other-runner", requests: [] };
    const before = clearCalls.length;
    const reads = spyOn(registry, "getAssignment");
    try {
      expect((await acquisition.acquire(elsewhere, OPTIONS)).outcome).toBe("ready");
      expect((await acquisition.acquire(elsewhere, OPTIONS)).outcome).toBe("ready");
      expect(reads).not.toHaveBeenCalled();
      expect(clearCalls).toHaveLength(before);
      expect(timer.getPendingTimeouts()).toEqual([1_000]);
      expect(acquisition.pendingBackOutCleanups()[0]?.attempts).toBe(6);
    } finally {
      reads.mockRestore();
    }
  });

  scenario("whenIdle stays pending during owed cleanup and resolves on convergence", async () => {
    await cappedWait();
    let idle = false;
    const idlePromise = acquisition.whenIdle().then(() => {
      idle = true;
    });
    await drainMicrotasks(20);
    expect(idle).toBe(false);
    busy = 0;
    await tick(1_000);
    await idlePromise;
    expect(idle).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  scenarios(
    ["oversized", "throwing", "NaN", "infinite"] as const,
    (kind) => `injected ${kind} backoff retries at the 1 s cap`,
    async (kind) => {
      const attempts: number[] = [];
      acquisition = new ManagedSlotAcquisition({
        ...deps,
        backOutRetryBackoff: {
          delayForAttempt: (attempt) => {
            attempts.push(attempt);
            if (kind === "throwing") {
              throw new Error("backoff failed");
            }
            return { oversized: 30_000, NaN: NaN, infinite: Infinity }[kind];
          },
        },
      });
      busy = 2;
      await fail("refused");
      expect(timer.getPendingTimeouts()).toEqual([1_000]);
      await tick(999);
      expect(clearCalls).toHaveLength(1);
      await tick(1);
      expect(clearCalls).toHaveLength(2);
      expect(acquisition.pendingBackOutCleanups()[0]?.attempts).toBe(1);
      expect(timer.getPendingTimeouts()).toEqual([1_000]);
      await tick(1_000);
      await acquisition.whenIdle();
      expect(attempts).toEqual([1, 2]);
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
      expect(await registry.getAssignment(KEY)).toMatchObject({ execOwner: null });
      expect(warn).not.toHaveBeenCalled();
      if (kind !== "oversized") {
        expect(
          debug.mock.calls.filter(([message]) => String(message).includes("backoff")),
        ).toHaveLength(2);
      }
    },
  );

  scenarios(
    [false, true],
    (later) => `timer failure leaves inspectable cleanup with no task, after a retry=${later}`,
    async (later) => {
      busy = Infinity;
      if (later) {
        await fail("refused");
      }
      const scheduleDeadline = timer.setTimeout.bind(timer);
      const timers = spyOn(timer, "setTimeout").mockImplementation((callback, delay) => {
        // Fail cadence timers, while allowing the newly bounded steps to arm their deadlines.
        if (delay === 700) {
          return scheduleDeadline(callback, delay);
        }
        throw new Error("retry timer failed");
      });
      try {
        if (later) {
          await tick();
        } else {
          await fail("refused");
        }
        await acquisition.whenIdle();
        expect(timer.getPendingTimeoutCount()).toBe(0);
        expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
          attempts: later ? 1 : 0,
          lastError: "retry timer failed",
        });
        expect(warn.mock.calls).toEqual([
          [expect.stringContaining("no task remains: retry timer failed"), expect.any(Error)],
        ]);
        expect(await registry.getAssignment(KEY)).toMatchObject({
          execOwner: { sessionUuid: "session-1" },
        });
        const elsewhere = { ...CONFIG, runnerNamespace: "other-runner", requests: [] };
        expect((await acquisition.acquire(elsewhere, OPTIONS)).outcome).toBe("ready");
        await tick(60_000);
        expect(timer.getPendingTimeoutCount()).toBe(0);
        expect(clearCalls).toHaveLength(later ? 2 : 1);
        expect(warn.mock.calls).toHaveLength(1);
      } finally {
        timers.mockRestore();
      }
    },
  );

  scenario(
    "a quiet timer failure during inline back-out retains both cleanups and the acquisition answer",
    async () => {
      busy = Infinity;
      blockedMs = 300;
      expect((await fail("policy")).failure?.code).toBe("execution_policy_failed");
      await tick(25); // Session 1 is queued behind its inline attempt's quiet time.
      expect(timer.getPendingTimeouts()).toEqual([275]);
      const schedule = timer.setTimeout.bind(timer);
      const error = new Error("shared quiet timer failed");
      const timers = spyOn(timer, "setTimeout").mockImplementation((callback, delay) => {
        if (delay === 25 || delay === 700) {
          return schedule(callback, delay);
        }
        throw error;
      });
      try {
        const result = await fail("policy").catch((caught: unknown) => caught);
        expect(result).toMatchObject({
          outcome: "failed",
          failure: { code: "execution_policy_failed" },
        });
        await tick(25);
        await acquisition.whenIdle();
        expect(
          acquisition.pendingBackOutCleanups().map((entry) => [entry.sessionUuid, entry.lastError]),
        ).toEqual([
          ["session-1", error.message],
          ["session-2", error.message],
        ]);
        for (const session of ["session-1", "session-2"]) {
          expect(
            warn.mock.calls.filter(
              ([message]) =>
                String(message).includes(session) &&
                String(message).includes("retry stopped; no task remains"),
            ),
          ).toHaveLength(1);
        }
        expect(clearCalls).toHaveLength(2);
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        timers.mockRestore();
      }
    },
  );

  scenario(
    "a newer acquisition owns the slot before the retry: no old-session write follows",
    async () => {
      busy = 1;
      await fail("refused");
      sessions.refuse = undefined;
      const next = await acquisition.acquire(CONFIG, OPTIONS);
      expect(next.outcome).toBe("ready");
      expect(next.slots[0]?.sessionUuid).toBe("session-2");
      await tick();
      await acquisition.whenIdle();
      expect(clearCalls).toHaveLength(1);
      expect(await registry.getAssignment(KEY)).toMatchObject({
        execOwner: { sessionUuid: "session-2" },
      });
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    },
  );

  scenario(
    "duplicate back-outs of one scope/slot/session retain all owed work in one task",
    async () => {
      busy = 2;
      await fail("refused");
      const provision = provisioner.provision.bind(provisioner);
      provisioner.provision = async (request) => ({
        ...(await provision(request)),
        sessionUuid: "session-1",
      });
      sessions.releaseFailures = 1;
      await fail("refused");
      expect(timer.getPendingTimeouts()).toEqual([25]);
      expect(acquisition.pendingBackOutCleanups()).toHaveLength(1);
      expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
        ownerClearOwed: true,
        sessionReleaseOwed: true,
        attempts: 0,
      });
      await tick();
      await acquisition.whenIdle();
      expect(clearCalls).toHaveLength(3);
      expect(sessions.releases).toHaveLength(3);
      expect(sessions.live.size).toBe(0);
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
      expect((await claim(peer, "peer-next")).kind).toBe("claimed");
    },
  );

  scenario("every failed group slot keeps retrying without another acquisition", async () => {
    await cappedWait("group");
    expect(acquisition.pendingBackOutCleanups().map((cleanup) => cleanup.attempts)).toEqual([6, 6]);
    busy = 0;
    await tick(1_000);
    await acquisition.whenIdle();
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    expect((await claim(peer, "peer-next")).kind).toBe("claimed");
    expect((await claim(peer, "peer-secondary", { ...KEY, slotIndex: 1 })).kind).toBe("claimed");
  });

  scenario("a newer acquisition during the capped wait prevents an old owner write", async () => {
    await cappedWait();
    sessions.refuse = undefined;
    const next = await acquisition.acquire(CONFIG, OPTIONS);
    expect(next.outcome).toBe("ready");
    expect(next.slots[0]?.sessionUuid).toBe("session-2");
    const before = clearCalls.length;
    await tick(1_000);
    await acquisition.whenIdle();
    expect(clearCalls).toHaveLength(before);
    expect(await registry.getAssignment(KEY)).toMatchObject({
      execOwner: { sessionUuid: "session-2" },
    });
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
  });

  scenarios(
    [PEER, { ...OWNER, processGenerationToken: "linux:boot:99" }],
    (other) =>
      `capped wait leaves same session under other process ${other.pid}/${other.processGenerationToken}`,
    async (other) => {
      await cappedWait();
      await registry.releaseExecution(KEY, "session-1");
      const binding = (await registry.getAssignment(KEY))!;
      expect(
        (await registry.claimExecution(KEY, binding, { ...other, sessionUuid: "session-1" })).kind,
      ).toBe("claimed");
      const before = clearCalls.length;
      await tick(1_000);
      await acquisition.whenIdle();
      expect(clearCalls).toHaveLength(before);
      expect(await registry.getAssignment(KEY)).toMatchObject({
        execOwner: { ...other, sessionUuid: "session-1" },
      });
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    },
  );

  scenario("capped wait releases the session before attempting to clear its owner", async () => {
    sessions.releaseFailures = Infinity;
    await cappedWait();
    await tick(1_000);
    expect(clearCalls).toHaveLength(1);
    expect(sessions.releases).toHaveLength(8);
    expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
      attempts: 7,
      sessionReleaseOwed: true,
      ownerClearOwed: true,
    });
    expect((await claim(peer, "peer-probe")).kind).toBe("slot_in_use");
    sessions.releaseFailures = 0;
    busy = 0;
    await tick(1_000);
    await acquisition.whenIdle();
    expect(sessions.events).toEqual([
      "owner:session-1",
      ...Array<string>(9).fill("session:session-1"),
      "owner:session-1",
    ]);
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    expect((await claim(peer, "peer-next")).kind).toBe("claimed");
  });

  scenario("close in the capped wait cancels immediately and logs nothing afterward", async () => {
    await cappedWait();
    const cleared = clearCalls.length;
    const released = sessions.releases.length;
    const warned = warn.mock.calls.length;
    const debugged = debug.mock.calls.length;
    const informed = info.mock.calls.length;
    const reads = spyOn(registry, "getAssignment");
    try {
      acquisition.close();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      await acquisition.whenIdle();
      await tick(600_000);
      expect(reads).not.toHaveBeenCalled();
      expect(clearCalls).toHaveLength(cleared);
      expect(sessions.releases).toHaveLength(released);
      expect(warn.mock.calls).toHaveLength(warned);
      expect(debug.mock.calls).toHaveLength(debugged);
      expect(info.mock.calls).toHaveLength(informed);
      expect(await registry.getAssignment(KEY)).toMatchObject({
        execOwner: { sessionUuid: "session-1" },
      });
    } finally {
      reads.mockRestore();
    }
  });

  scenarios(
    [PEER, { ...OWNER, processGenerationToken: "linux:boot:99" }],
    (other) =>
      `same session under another process identity ${other.pid}/${other.processGenerationToken} is left alone`,
    async (other) => {
      busy = 1;
      await fail("refused");
      await registry.releaseExecution(KEY, "session-1");
      const binding = (await registry.getAssignment(KEY))!;
      expect(
        (await registry.claimExecution(KEY, binding, { ...other, sessionUuid: "session-1" })).kind,
      ).toBe("claimed");
      await tick();
      await acquisition.whenIdle();
      expect(clearCalls).toHaveLength(1);
      expect(await registry.getAssignment(KEY)).toMatchObject({
        execOwner: { ...other, sessionUuid: "session-1" },
      });
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    },
  );

  scenario("a missing generation token falls back to pid for the exact old session", async () => {
    busy = 1;
    await fail("refused");
    await registry.releaseExecution(KEY, "session-1");
    const binding = (await registry.getAssignment(KEY))!;
    await registry.claimExecution(KEY, binding, {
      ...OWNER,
      processGenerationToken: null,
      sessionUuid: "session-1",
    });
    await tick();
    await acquisition.whenIdle();
    expect(clearCalls).toHaveLength(2);
    expect(await registry.getAssignment(KEY)).toMatchObject({ execOwner: null });
  });

  scenarios(
    [false, true],
    (lost) => `session cleanup precedes owner cleanup, session lost-ack=${lost}`,
    async (sessionLostAck) => {
      busy = 1;
      sessions.releaseFailures = 2;
      sessions.releaseCommitsThenThrows = sessionLostAck;
      await fail("refused");
      expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
        ownerClearOwed: true,
        sessionReleaseOwed: true,
      });
      await tick();
      expect(clearCalls).toHaveLength(1);
      expect(sessions.releases).toEqual(["session-1", "session-1"]);
      expect((await claim(peer, "peer-probe")).kind).toBe("slot_in_use");
      await tick(50);
      await acquisition.whenIdle();
      expect(sessions.events).toEqual([
        "owner:session-1",
        "session:session-1",
        "session:session-1",
        "session:session-1",
        "owner:session-1",
      ]);
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
      expect((await claim(peer, "peer-next")).kind).toBe("claimed");
    },
  );

  scenario(
    "owner clear succeeded but session release failed: only session cleanup is retried",
    async () => {
      sessions.releaseFailures = 1;
      await fail("refused");
      expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
        ownerClearOwed: false,
        sessionReleaseOwed: true,
      });
      await tick();
      await acquisition.whenIdle();
      expect(clearCalls).toHaveLength(1);
      expect(sessions.live.size).toBe(0);
      expect(sessions.releases).toEqual(["session-1", "session-1"]);
      expect(acquisition.pendingBackOutCleanups()).toEqual([]);
    },
  );

  scenario(
    "close cancels all waits immediately, preserves rows, and prevents future re-arming",
    async () => {
      busy = 2;
      await fail("group");
      expect(timer.getPendingTimeoutCount()).toBe(2);
      const warned = warn.mock.calls.length;
      acquisition.close();
      acquisition.close();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      await acquisition.whenIdle();
      await tick(600_000);
      expect(clearCalls).toHaveLength(2);
      expect(sessions.releases).toHaveLength(2);
      expect(await registry.getAssignment(KEY)).toMatchObject({
        execOwner: { sessionUuid: "session-1" },
      });
      expect((await claim(peer, "peer-probe")).kind).toBe("slot_in_use");
      expect(warn.mock.calls).toHaveLength(warned);
      // acquire() after close retains the inline behavior but starts no retries, even on failure.
      busy = 1;
      sessions.refuse = "session-3";
      expect((await acquisition.acquire(CONFIG, OPTIONS)).outcome).toBe("failed");
      expect(clearCalls).toHaveLength(3);
      expect(sessions.releases).toHaveLength(3);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(warn.mock.calls).toHaveLength(warned);
    },
  );

  scenario("close during ownership read starts no clear and logs nothing", async () => {
    busy = 1;
    await fail("refused");
    const warned = warn.mock.calls.length;
    afterRead = () => acquisition.close();
    await tick();
    await acquisition.whenIdle();
    expect(clearCalls).toHaveLength(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(warn.mock.calls).toHaveLength(warned);
    expect(await registry.getAssignment(KEY)).toMatchObject({
      execOwner: { sessionUuid: "session-1" },
    });
  });

  scenario(
    "close during session cleanup starts no ownership read or clear, including a rejected release",
    async () => {
      busy = 1;
      sessions.releaseFailures = 1;
      await fail("refused");
      const warned = warn.mock.calls.length;
      const reads = spyOn(registry, "getAssignment");
      sessions.releaseSession = async () => {
        acquisition.close();
        throw new Error("session release interrupted by close");
      };
      await tick();
      await acquisition.whenIdle();
      expect(reads).not.toHaveBeenCalled();
      reads.mockRestore();
      expect(clearCalls).toHaveLength(1);
      expect(warn.mock.calls).toHaveLength(warned);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  scenario("a busy ownership read is retried before any owner write", async () => {
    busy = 1;
    await fail("refused");
    readFailures = 1;
    await tick();
    expect(clearCalls).toHaveLength(1);
    expect(acquisition.pendingBackOutCleanups()[0]).toMatchObject({
      attempts: 1,
      lastError: "SQLITE_BUSY: owner read is locked",
    });
    await tick(50);
    await acquisition.whenIdle();
    expect(clearCalls).toHaveLength(2);
    expect(acquisition.pendingBackOutCleanups()).toEqual([]);
  });

  scenario(
    "close during a rejected owner clear emits no retry warning and starts no further work",
    async () => {
      busy = 1;
      await fail("refused");
      const warned = warn.mock.calls.length;
      const releases = spyOn(registry, "releaseExecution").mockImplementation(async () => {
        acquisition.close();
        throw new Error("SQLITE_BUSY during shutdown");
      });
      await tick();
      await acquisition.whenIdle();
      expect(releases).toHaveBeenCalledTimes(1);
      releases.mockRestore();
      expect(warn.mock.calls).toHaveLength(warned);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(await registry.getAssignment(KEY)).toMatchObject({
        execOwner: { sessionUuid: "session-1" },
      });
    },
  );
});

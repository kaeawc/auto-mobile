import { beforeEach, describe, expect, test } from "bun:test";
import {
  ManagedSlotAcquisition,
  type ManagedSlotAcquisitionSessions,
} from "../../../src/daemon/managedSlots/managedSlotAcquisition";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
} from "../../../src/daemon/managedSlots/reconciler";
import {
  computeSlotScopeKey,
  type SlotScopeRecord,
} from "../../../src/daemon/managedSlots/slotRegistry";
import {
  SLOT_SCOPE_RESET_DEFAULT_WAIT_MS,
  SlotScopeReset,
} from "../../../src/daemon/managedSlots/slotScopeReset";
import {
  parseManagedSlotConfig,
  type ManagedSlotConfig,
} from "../../../src/models/managedSlotConfig";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

const IOS_18 = "com.apple.CoreSimulator.SimRuntime.iOS-18-0";
const IOS_17 = "com.apple.CoreSimulator.SimRuntime.iOS-17-5";
const IPHONE_16 = "com.apple.CoreSimulator.SimDeviceType.iPhone-16";
const TOKEN = "proxy-token";
const DAEMON_PID = 4242;

function configFor(
  overrides: { runnerIncarnation?: string; runtime?: string; idleTimeoutMs?: number } = {},
): ManagedSlotConfig {
  return parseManagedSlotConfig({
    contractVersion: 1,
    managedHostScope: "host-a",
    runnerNamespace: "ns",
    runnerIncarnation: overrides.runnerIncarnation ?? "inc-1",
    localSlotCapacity: 1,
    ...(overrides.idleTimeoutMs ? { idleTimeoutMs: overrides.idleTimeoutMs } : {}),
    requests: [
      {
        slotIndex: 0,
        role: "app",
        platform: "ios",
        requestedSpec: { runtime: overrides.runtime ?? IOS_18, deviceType: IPHONE_16 },
      },
    ],
  });
}

class FakeSessions implements ManagedSlotAcquisitionSessions {
  claimOutcome: "claimed" | "conflict" = "claimed";
  readonly claims: Array<[string, string]> = [];
  readonly adopted: Array<[string, number | undefined]> = [];
  readonly released: string[] = [];
  async claimLivenessOwnership(sessionId: string, ownerToken: string) {
    this.claims.push([sessionId, ownerToken]);
    return this.claimOutcome;
  }
  async adoptManagedExecutionLivenessPolicy(
    sessionId: string,
    options: { idleTimeoutMs?: number },
  ): Promise<void> {
    this.adopted.push([sessionId, options.idleTimeoutMs]);
  }
  async releaseSession(sessionId: string): Promise<void> {
    this.released.push(sessionId);
  }
}

describe("ManagedSlotAcquisition", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let sessions: FakeSessions;
  let livePids: Set<number>;
  let reconciler: ManagedSlotReconciler;
  let acquisition: ManagedSlotAcquisition;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    livePids = new Set([DAEMON_PID]);
    const isLive = (owner: { pid: number }) => livePids.has(owner.pid);
    registry = new FakeSlotRegistry(timer, isLive);
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    sessions = new FakeSessions();
    reconciler = new ManagedSlotReconciler({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      claims: new FakeClaims(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: isLive,
    });
    acquisition = new ManagedSlotAcquisition({
      registry: async () => registry,
      reconcile: (_registry, request) => reconciler.reconcile(request),
      sessions,
      owner: () => ({ daemonId: "daemon-1", pid: DAEMON_PID }),
      timer,
    });
  });

  /** End the previous execution the way the drain does: clear the owner, keep the device. */
  async function endExecution(config: ManagedSlotConfig, sessionUuid: string): Promise<void> {
    await registry.releaseExecution(
      { scopeKey: computeSlotScopeKey(config), slotIndex: 0 },
      sessionUuid,
    );
  }

  test("creates the slot's device and hands its fresh session to the caller's token", async () => {
    const config = configFor({ idleTimeoutMs: 10 * 60_000 });

    const result = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });

    expect(result).toMatchObject({
      contractVersion: 1,
      outcome: "ready",
      scope: { runnerIncarnation: "inc-1", scopeKey: computeSlotScopeKey(config) },
      idleTimeoutMs: 10 * 60_000,
      slots: [
        {
          slotIndex: 0,
          role: "app",
          platform: "ios",
          disposition: "created",
          assignmentGeneration: 1,
          sessionUuid: "session-1",
          readiness: { mode: "automation", status: "automation_ready" },
          specFingerprint: { version: 1 },
        },
      ],
    });
    expect(sessions.claims).toEqual([["session-1", TOKEN]]);
    expect(sessions.adopted).toEqual([["session-1", 10 * 60_000]]);
    const assignment = await registry.getAssignment({
      scopeKey: computeSlotScopeKey(config),
      slotIndex: 0,
    });
    expect(assignment?.execOwner).toMatchObject({ pid: DAEMON_PID, sessionUuid: "session-1" });
  });

  test("a later execution reuses the slot's device with a fresh session", async () => {
    const config = configFor();
    const first = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });
    await endExecution(config, first.slots[0]!.sessionUuid!);

    const second = await acquisition.acquire(config, { livenessOwnerToken: "next-token" });

    expect(second.slots[0]).toMatchObject({ disposition: "reused", sessionUuid: "session-2" });
    expect(second.slots[0]!.device).toEqual(first.slots[0]!.device);
    expect(provisioner.created()).toHaveLength(1);
  });

  test("a live execution on the slot refuses a duplicate with retryable slot_in_use", async () => {
    const config = configFor();
    await acquisition.acquire(config, { livenessOwnerToken: TOKEN });

    const duplicate = await acquisition.acquire(config, { livenessOwnerToken: "dup" });

    expect(duplicate.outcome).toBe("failed");
    expect(duplicate.failure).toMatchObject({ code: "slot_in_use", retryable: true });
    expect(duplicate.slots[0]!.sessionUuid).toBeNull();
  });

  test("a spec change replaces the device in the same slot", async () => {
    const config = configFor();
    const first = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });
    await endExecution(config, first.slots[0]!.sessionUuid!);

    const changed = await acquisition.acquire(configFor({ runtime: IOS_17 }), {
      livenessOwnerToken: TOKEN,
    });

    expect(changed.slots[0]).toMatchObject({ disposition: "replaced", assignmentGeneration: 4 });
    expect(deleter.calls.map((call) => call.stableId)).toEqual([first.slots[0]!.device!.stableId]);
  });

  test("a failed reconcile is a typed failure that holds nothing", async () => {
    provisioner.failWith = () => new Error("simctl create failed");

    const result = await acquisition.acquire(configFor(), { livenessOwnerToken: TOKEN });

    expect(result.outcome).toBe("failed");
    expect(result.failure).toMatchObject({ code: "provision_failed" });
    expect(result.slots[0]).toMatchObject({ sessionUuid: null, disposition: null });
    expect(sessions.claims).toEqual([]);
  });

  test("a refused ownership claim backs the session out; the slot keeps its device", async () => {
    sessions.claimOutcome = "conflict";
    const config = configFor();

    const result = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });

    expect(result.failure).toMatchObject({ code: "liveness_owner_conflict", retryable: true });
    expect(sessions.released).toEqual(["session-1"]);
    const assignment = await registry.getAssignment({
      scopeKey: computeSlotScopeKey(config),
      slotIndex: 0,
    });
    expect(assignment).toMatchObject({ state: "ready", execOwner: null });
    expect(assignment?.stableDeviceId).not.toBeNull();
  });

  test("a cancelled acquisition releases the session it prepared", async () => {
    const abort = new AbortController();
    provisioner.beforeReturn = async () => {
      abort.abort();
    };

    const result = await acquisition.acquire(configFor(), {
      livenessOwnerToken: TOKEN,
      signal: abort.signal,
    });

    expect(result.outcome).toBe("failed");
    expect(result.failure?.code).toBe("cancelled");
    expect(sessions.released).toEqual(["session-1"]);
  });

  describe("scope transitions", () => {
    test("a new incarnation retires a settled old one and adopts its device", async () => {
      const old = configFor();
      const first = await acquisition.acquire(old, { livenessOwnerToken: TOKEN });
      await endExecution(old, first.slots[0]!.sessionUuid!);

      const next = await acquisition.acquire(configFor({ runnerIncarnation: "inc-2" }), {
        livenessOwnerToken: TOKEN,
      });

      expect(next.outcome).toBe("ready");
      expect(next.slots[0]).toMatchObject({ disposition: "adopted" });
      expect(next.slots[0]!.device!.stableId).toBe(first.slots[0]!.device!.stableId);
      expect((await registry.getScope(computeSlotScopeKey(old)))?.state).toBe("invalidated");

      const stale = await acquisition.acquire(old, { livenessOwnerToken: TOKEN });
      expect(stale.failure).toMatchObject({ code: "scope_invalidated", retryable: false });
    });

    test("an old incarnation with a live execution keeps the new one pending", async () => {
      await acquisition.acquire(configFor(), { livenessOwnerToken: TOKEN });

      const next = await acquisition.acquire(configFor({ runnerIncarnation: "inc-2" }), {
        livenessOwnerToken: TOKEN,
      });

      expect(next.outcome).toBe("failed");
      expect(next.failure).toMatchObject({ code: "scope_transition_pending", retryable: true });
      expect(next.slots).toEqual([]);
    });

    function acquisitionWithReset(
      resetSupersededScope: (
        scope: SlotScopeRecord,
        waitMs: number,
      ) => ReturnType<SlotScopeReset["resetSupersededScope"]> | undefined,
    ): ManagedSlotAcquisition {
      return new ManagedSlotAcquisition({
        registry: async () => registry,
        reconcile: (_registry, request) => reconciler.reconcile(request),
        sessions,
        owner: () => ({ daemonId: "daemon-1", pid: DAEMON_PID }),
        timer,
        resetSupersededScope,
      });
    }

    test("a new incarnation waits, through the implicit reset, for the old execution to settle", async () => {
      const old = configFor();
      const first = await acquisition.acquire(old, { livenessOwnerToken: TOKEN });
      const reset = new SlotScopeReset({ registry: async () => registry, timer });
      const waits: number[] = [];
      const withReset = acquisitionWithReset((scope, waitMs) => {
        waits.push(waitMs);
        return reset.resetSupersededScope(scope, waitMs);
      });
      // The old execution ends while the reset is waiting on it.
      const sleep = timer.sleep.bind(timer);
      timer.sleep = async (ms: number) => {
        await endExecution(old, first.slots[0]!.sessionUuid!);
        timer.advanceTime(ms);
      };
      try {
        const next = await withReset.acquire(configFor({ runnerIncarnation: "inc-2" }), {
          livenessOwnerToken: TOKEN,
        });

        expect(next.outcome).toBe("ready");
        expect(next.slots[0]).toMatchObject({ disposition: "adopted" });
        expect(waits).toEqual([SLOT_SCOPE_RESET_DEFAULT_WAIT_MS]);
        expect((await registry.getScope(computeSlotScopeKey(old)))?.state).toBe("invalidated");
      } finally {
        timer.sleep = sleep;
      }
    });

    test("an implicit reset still pending reports scope_transition_pending within the deadline", async () => {
      await acquisition.acquire(configFor(), { livenessOwnerToken: TOKEN });
      const waits: number[] = [];
      const withReset = acquisitionWithReset(async (scope, waitMs) => {
        waits.push(waitMs);
        return {
          ...scope,
          outcome: "pending",
          freedDevices: [],
          pending: {
            liveOwners: [{ slotIndex: 0, sessionUuid: "session-1", pid: DAEMON_PID }],
            settling: [],
            cleanupPending: [],
            openJournal: [],
          },
        };
      });
      const next = configFor({ runnerIncarnation: "inc-2" });

      const result = await withReset.acquire(
        { ...next, preparationTimeoutMs: 3_000 },
        { livenessOwnerToken: TOKEN },
      );

      expect(result.failure).toMatchObject({ code: "scope_transition_pending", retryable: true });
      expect(result.failure?.message).toContain("1 live execution(s)");
      // The settle wait never outlives the acquisition's preparation budget.
      expect(waits).toEqual([3_000]);
    });

    test("an abandoned scope whose incarnation returns is revived and reuses its device", async () => {
      const config = configFor();
      const first = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });
      await endExecution(config, first.slots[0]!.sessionUuid!);
      timer.advanceTime(2 * 60 * 60 * 1000);
      const marked = await registry.markScopeAbandoned(computeSlotScopeKey(config));
      expect(marked.kind).toBe("marked");

      const revived = await acquisition.acquire(config, { livenessOwnerToken: TOKEN });

      expect(revived.outcome).toBe("ready");
      expect(revived.scope.revived).toBe(true);
      expect(revived.slots[0]).toMatchObject({ disposition: "reused" });
    });
  });
});

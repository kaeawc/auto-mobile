import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { SessionManager, TerminalSessionError } from "../../../src/daemon/sessionManager";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../../src/daemon/daemonRequestHandlers";
import {
  ManagedExecutionReowner,
  MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS,
} from "../../../src/daemon/managedSlots/managedExecutionReowner";
import {
  ManagedExecutionRelease,
  managedExecutionSessionsFrom,
} from "../../../src/daemon/managedSlots/managedExecutionRelease";
import { ManagedSlotOwnershipUnconfirmedError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { openSqliteSlotRegistry } from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { InFlightSlotReservations } from "../../../src/daemon/managedSlots/slotOwnerLiveness";
import type { SlotRegistry } from "../../../src/daemon/managedSlots/slotRegistry";
import { fixedBackoff } from "../../../src/utils/Backoff";
import { SUSPECT_GRACE_MS } from "../../../src/daemon/livenessOwnerLease";
import { logger } from "../../../src/utils/logger";
import { sessionOwnershipLostPayload } from "../../../src/server/deviceSessionResult";
import { FakeDbWriteBarrier } from "../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  drainMicrotasks,
  drainUntil,
  drainUntilQuiescent,
  settleWithFakeTime,
} from "../../helpers/fakeTimerStepping";

const SESSION = "recovering-session";
const DEVICE = "fake-managed-device";
const OWNER = { daemonId: "current", pid: 4200 };
const PREVIOUS = { daemonId: "previous", pid: 4100 };
const PEER = { daemonId: "peer", pid: 4300, sessionUuid: "peer-session" };
let registry: SlotRegistry;
let index = 0;
beforeAll(async () => {
  registry = await openSqliteSlotRegistry({
    dbPath: ":memory:",
    timer: new FakeTimer(),
    isExecOwnerLive: (owner) => owner.daemonId === "peer",
  });
});
afterAll(async () => {
  await registry.close();
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function harness() {
  const timer = new FakeTimer();
  const persistence = new FakeDeviceSessionPersistence();
  const writes: string[] = [];
  const behavior: {
    busy: boolean;
    gate?: Promise<void>;
    busyMark: boolean;
    lookupGate?: Promise<void>;
  } = { busy: false, busyMark: false };
  const manager = new SessionManager(
    timer,
    persistence,
    () => new FakeDbWriteBarrier(),
    () => ({
      restore: async () => {
        await behavior.gate;
        writes.push("restore");
      },
    }),
    undefined,
    {
      rotation: () => ({
        restore: async () => {
          writes.push("rotation");
        },
      }),
    },
  );
  manager.stopCleanupTimer();
  await manager.createSession(SESSION, DEVICE, "android");
  await manager.adoptManagedExecutionLivenessPolicy(SESSION);
  manager.setKeepScreenAwake(SESSION, { applied: true });
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: `case-${index++}`,
    runnerIncarnation: "boot",
  });
  if (scope.kind !== "ready") {
    throw new Error(scope.kind);
  }
  const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  await registry.initSlot(key, { role: "app", platform: "android", requestedSpec: {} });
  await registry.commitBinding(
    key,
    { generation: 0, stableDeviceId: null },
    {
      stableDeviceId: `${DEVICE}-${index}`,
      deviceName: DEVICE,
      resolvedSpec: {},
      specFingerprint: "fp",
      state: "ready",
    },
  );
  const binding = { generation: 1, stableDeviceId: `${DEVICE}-${index}` };
  expect(
    (await registry.claimExecution(key, binding, { ...PREVIOUS, sessionUuid: SESSION })).kind,
  ).toBe("claimed");
  const events: string[] = [];
  const faulty = new Proxy(registry, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        if (property === "findExecutionAssignments") {
          await behavior.lookupGate;
        }
        if (property === "claimExecution" && behavior.busy) {
          throw new Error("SQLITE_BUSY: stamp");
        }
        if (property === "updateSlotState" && behavior.busyMark) {
          throw new Error("SQLITE_BUSY: mark");
        }
        if (property === "releaseExecution") {
          events.push("clear");
        }
        return Reflect.apply(value, target, args);
      };
    },
  });
  const lost: string[] = [];
  const confirmed: string[] = [];
  const reowner = new ManagedExecutionReowner({
    registry: async () => faulty,
    owner: () => OWNER,
    timer,
    retryBackoff: fixedBackoff(2_000),
    isSessionHeld: (id) => manager.isLiveManagedExecutionSession(id),
    isSessionPresent: (id) => manager.hasSession(id) || manager.getReleasingSession(id) !== null,
    deviceOf: () => DEVICE,
    onOwnershipLost: (id) => {
      lost.push(id);
    },
    onOwnershipConfirmed: (id) => {
      confirmed.push(id);
      events.push("confirmed");
    },
  });
  manager.setReleaseDeviceHold((id) => reowner.releaseDeviceHold(id));
  const force = spyOn(manager, "forceStuckRelease");
  const releasedDevices: string[] = [];
  const drain = new ManagedExecutionRelease({
    registry: async () => faulty,
    timer,
    settler: OWNER,
    settlementPollMs: 10,
    registryRetryBackoff: fixedBackoff(100),
    ownerHolds: new InFlightSlotReservations(),
    isExecOwnerLive: (owner) => owner.daemonId === "peer",
    ownership: {
      isReleaseHeld: (id) => reowner.isReleaseHeld(id),
      confirmOwnership: (id) => {
        events.push("confirmed");
        reowner.confirmOwnership(id);
      },
    },
    sessions: managedExecutionSessionsFrom(manager, {
      releaseDevice: async (device) => {
        releasedDevices.push(device);
      },
    }),
    work: {
      cancelDeviceSessionExecutions: async () => 0,
      hasActiveDeviceSessionExecutions: () => false,
      waitForDeviceSessionExecutionsToEnd: async () => true,
    },
  });
  manager.onSessionRelease((_id, _device, _reason, snapshot, options) =>
    drain.onSessionReleased(snapshot, options),
  );
  cleanups.push(async () => {
    reowner.close();
    drain.close();
    await reowner.whenIdle();
    await drain.whenIdle();
    manager.stopCleanupTimer();
    force.mockRestore();
    timer.reset();
    await registry.releaseExecution(key, SESSION);
  });
  return {
    timer,
    manager,
    reowner,
    drain,
    behavior,
    writes,
    key,
    binding,
    lost,
    confirmed,
    events,
    force,
    releasedDevices,
  };
}

describe("managed ownership release", () => {
  test("loss notifies once and both release bookkeeping paths leave the peer record unchanged", async () => {
    const h = await harness();
    await registry.releaseExecution(h.key, SESSION);
    await registry.claimExecution(h.key, h.binding, PEER);
    const before = await registry.getAssignment(h.key);
    await h.reowner.reown([SESSION], { rehydrated: true });
    await h.reowner.reown([SESSION], { rehydrated: true });
    expect(h.lost).toEqual([SESSION]);
    await h.manager.releaseSession(SESSION, "managed-slot-ownership-lost");
    await h.drain.whenIdle();
    await h.drain.releaseExecution(SESSION);
    expect(await registry.getAssignment(h.key)).toEqual(before);
    expect(h.writes).toEqual([]);
    const error = new TerminalSessionError(SESSION, h.manager.getTerminalReleaseSnapshot(SESSION)!);
    const payload = sessionOwnershipLostPayload({
      message: error.message,
      sessionUuid: SESSION,
      reason: error.release.releaseReason,
      release: error.release,
    });
    expect(payload.error).toMatchObject({
      code: "session_ownership_lost",
      reason: "managed-slot-ownership-lost",
      retryable: false,
      nextAction: "acquire_new_session",
    });
    expect(payload.error).not.toHaveProperty("idle");
  });

  test("a held drain answers at 700ms without forcing, confirms before clear, and settles ready", async () => {
    const h = await harness();
    h.behavior.busy = true;
    await h.reowner.reown([SESSION], { rehydrated: true });
    h.behavior.busy = false;
    const gate = Promise.withResolvers<void>();
    h.behavior.gate = gate.promise;
    const started = h.timer.now();
    const release = h.drain.releaseExecution(SESSION);
    await drainMicrotasks(60);
    expect(h.reowner.isReleaseHeld(SESSION)).toBe(true);
    expect(h.reowner.automationRefusal(SESSION)).toBeInstanceOf(
      ManagedSlotOwnershipUnconfirmedError,
    );
    expect(h.writes).toEqual([]);
    h.timer.advanceTime(700);
    const answer = await release;
    expect(h.timer.now() - started).toBe(700);
    expect(answer).toMatchObject({
      outcome: "cleanup_pending",
      settlement: "settling",
      releaseForced: false,
    });
    expect(h.force).not.toHaveBeenCalled();
    expect(h.confirmed).toEqual([SESSION]);
    expect(h.events.indexOf("confirmed")).toBeLessThan(h.events.indexOf("clear"));
    expect((await registry.getAssignment(h.key))?.state).toBe("settling");
    expect(h.lost).toEqual([]);
    gate.resolve();
    await drainMicrotasks(100);
    h.timer.advanceTime(10);
    await h.drain.whenIdle();
    expect(h.writes).toEqual(["restore"]);
    expect((await registry.getAssignment(h.key))?.state).toBe("ready");
    expect(h.releasedDevices).toEqual([DEVICE]);
  });

  test.each(["stamp", "mark", "reowner", "cap"] as const)(
    "double failure holds teardown until %s lands",
    async (proof) => {
      const h = await harness();
      h.behavior.busy = true;
      h.behavior.busyMark = true;
      await h.reowner.reown([SESSION], { rehydrated: true });
      const release = h.drain.releaseExecution(SESSION);
      await drainMicrotasks(60);
      h.timer.advanceTime(700);
      expect(await release).toMatchObject({
        outcome: "cleanup_pending",
        releaseForced: false,
        settlement: "settling",
      });
      await drainMicrotasks(100);
      expect(h.reowner.isReleaseHeld(SESSION)).toBe(true);
      expect(h.reowner.automationRefusal(SESSION)).toBeDefined();
      expect(h.writes).toEqual([]);
      expect((await registry.getAssignment(h.key))?.execOwner?.sessionUuid).toBe(SESSION);
      if (proof === "cap") {
        h.timer.advanceTime(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS - 700);
        await drainMicrotasks(100);
        expect(h.writes).toEqual([]);
        expect(h.manager.hasDeviceCleanupInProgress(DEVICE)).toBe(false);
        h.behavior.busy = false;
        h.behavior.busyMark = false;
        h.timer.advanceTime(100);
      } else if (proof === "reowner") {
        h.behavior.busy = false;
        h.timer.advanceTime(1_300);
      } else {
        if (proof === "stamp") {
          h.behavior.busy = false;
        } else {
          h.behavior.busyMark = false;
        }
        h.timer.advanceTime(100);
      }
      await drainMicrotasks(100);
      expect(h.reowner.isReleaseHeld(SESSION)).toBe(false);
      if (proof !== "cap") {
        expect(h.writes).toEqual(["restore"]);
      }
      expect(h.lost).toEqual([]);
      h.behavior.busyMark = false;
      await settleWithFakeTime(h.timer, h.drain.whenIdle(), {
        description: "owed mark and release settlement",
        stepMs: 100,
        maxSteps: 100,
      });
      expect((await registry.getAssignment(h.key))?.state).toBe("ready");
      if (proof !== "cap") {
        expect(h.events.indexOf("confirmed")).toBeLessThan(h.events.indexOf("clear"));
      }
    },
  );

  test("background re-own continues after release hides its held session", async () => {
    const h = await harness();
    h.behavior.busy = true;
    await h.reowner.reown([SESSION], { rehydrated: true });
    h.behavior.busy = false;
    const releaseStartedAt = h.timer.now();
    const release = h.manager.releaseSession(SESSION);
    expect(h.manager.isLiveManagedExecutionSession(SESSION)).toBe(false);
    expect(h.reowner.automationRefusal(SESSION)).toBeDefined();
    await drainUntil(() => h.writes.length > 0, {
      description: "hold-triggered re-own and device teardown without advancing fake time",
    });
    await release;
    await h.reowner.whenIdle();
    await h.drain.whenIdle();
    expect(h.writes).toEqual(["restore"]);
    expect(h.confirmed).toEqual([SESSION]);
    expect(h.timer.now()).toBe(releaseStartedAt);
  });

  test("loss during a release hold skips writes and aborts retries", async () => {
    const h = await harness();
    h.behavior.busy = true;
    await h.reowner.reown([SESSION], { rehydrated: true });
    const release = h.manager.releaseSession(SESSION);
    await registry.releaseExecution(h.key, SESSION);
    await registry.claimExecution(h.key, h.binding, PEER);
    const before = await registry.getAssignment(h.key);
    await drainMicrotasks(30);
    h.timer.advanceTime(2_000);
    await release;
    await h.reowner.whenIdle();
    await h.drain.whenIdle();
    expect(h.writes).toEqual([]);
    expect(h.lost).toEqual([SESSION]);
    expect(await registry.getAssignment(h.key)).toEqual(before);
    expect(h.timer.getPendingTimeouts()).toEqual([]);
  });

  test("ordinary managed release restores and keeps its binding and generation", async () => {
    const h = await harness();
    await h.reowner.reown([SESSION], { rehydrated: true });
    const before = (await registry.getAssignment(h.key))!;
    const answer = await h.drain.releaseExecution(SESSION);
    expect(answer).toMatchObject({
      outcome: "reusable_for_this_slot",
      settlement: "confirmed",
      releaseForced: false,
    });
    expect(h.writes).toEqual(["restore"]);
    expect(await registry.getAssignment(h.key)).toMatchObject({
      state: "ready",
      generation: before.generation,
      stableDeviceId: before.stableDeviceId,
      execOwner: null,
    });
  });

  test.each(["confirmed", "cap", "close"] as const)(
    "%s resolves a hold despite a parked lookup; its late loss is ignored",
    async (resolution) => {
      const h = await harness();
      h.behavior.busy = true;
      await h.reowner.reown([SESSION], { rehydrated: true });
      const release = h.manager.releaseSession(SESSION);
      const lookup = Promise.withResolvers<void>();
      h.behavior.lookupGate = lookup.promise;
      h.behavior.busy = false;
      await drainMicrotasks(40);
      h.timer.advanceTime(2_000);
      await drainMicrotasks(40);
      if (resolution === "confirmed") {
        h.reowner.confirmOwnership(SESSION);
      } else if (resolution === "close") {
        h.reowner.close();
      } else {
        h.timer.advanceTime(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS - 2_000);
      }
      // No listener may wait on this deliberately parked registry read.
      h.drain.close();
      await release;
      await h.reowner.whenIdle();
      expect(h.reowner.isReleaseHeld(SESSION)).toBe(false);
      await registry.releaseExecution(h.key, SESSION);
      lookup.resolve();
      await drainMicrotasks(60);
      expect(h.lost).toEqual([]);
      expect(h.writes).toEqual(resolution === "confirmed" ? ["restore"] : []);
      expect(h.timer.getPendingTimeouts()).toEqual([]);
    },
  );

  test("throwing loss callback is warned once and cannot escape re-owning", async () => {
    const h = await harness();
    h.reowner.close();
    const reowner = new ManagedExecutionReowner({
      registry: async () => registry,
      owner: () => OWNER,
      timer: h.timer,
      onOwnershipLost: () => {
        throw new Error("listener failure");
      },
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await reowner.reown(["absent"], { rehydrated: true });
      await reowner.reown(["absent"], { rehydrated: true });
      expect(
        warn.mock.calls.filter(([message]) =>
          String(message).includes("Ownership-lost hook failed"),
        ),
      ).toHaveLength(1);
    } finally {
      reowner.close();
      warn.mockRestore();
    }
  });
  test("an idle-expired lost session retains its gate and skips all device teardown", async () => {
    const h = await harness();
    await registry.releaseExecution(h.key, SESSION);
    await registry.claimExecution(h.key, h.binding, PEER);
    await h.reowner.reown([SESSION], { rehydrated: true });
    const session = h.manager.getSession(SESSION)!;
    h.timer.setCurrentTime(session.expiresAt + 1);
    expect(h.reowner.ownershipState(SESSION)).toBe("lost");
    expect(h.reowner.automationRefusal(SESSION)).toBeDefined();
    expect(h.reowner.releaseDeviceHold(SESSION)).toEqual({ skipDeviceWrites: true });
    await h.manager.releaseSession(SESSION, "managed-slot-ownership-lost", true);
    await h.drain.whenIdle();
    expect(h.writes).toEqual([]);
    expect(h.reowner.ownershipState(SESSION)).toBeUndefined();
    expect(h.manager.getTerminalReleaseSnapshot(SESSION)?.releaseReason).toBe(
      "managed-slot-ownership-lost",
    );
  });

  test.each(["retry-tick", "gate-check", "none"] as const)(
    "owner lease lapse preserves the release gate after %s",
    async (trigger) => {
      for (const proof of ["cap", "confirmed"] as const) {
        const h = await harness();
        h.behavior.busy = true;
        await h.reowner.reown([SESSION], { rehydrated: true });
        const session = h.manager.getSession(SESSION)!;
        h.manager.setRotation(session, { accelerometerRotation: 1, userRotation: 0 });
        expect(
          await handleDaemonRequest(
            {
              id: "owner-heartbeat",
              type: "daemon_request",
              method: "daemon/heartbeat",
              params: { sessionId: SESSION },
            },
            { isInitialized: () => true, getSessionManager: () => h.manager } as DaemonStateAccess,
          ),
        ).toMatchObject({ success: true });
        h.timer.setCurrentTime(h.timer.now() + session.heartbeatTimeoutMs + SUSPECT_GRACE_MS + 1);
        expect(h.manager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");
        if (trigger === "retry-tick") {
          h.timer.advanceTime(2_000);
          await drainMicrotasks(40);
        } else if (trigger === "gate-check") {
          expect(h.reowner.automationRefusal(SESSION)).toBeDefined();
        }
        expect(h.manager.getSessionLeaseState(SESSION)?.phase).toBe("lapsed");
        const release = h.manager.releaseSession(SESSION, "heartbeat-timeout", true);
        await drainMicrotasks(40);
        expect(h.writes).toEqual([]);
        expect(h.reowner.isReleaseHeld(SESSION)).toBe(true);
        expect(h.reowner.ownershipState(SESSION)).toBe("unconfirmed");
        if (proof === "cap") {
          h.timer.advanceTime(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS);
        } else {
          h.reowner.confirmOwnership(SESSION);
        }
        await release;
        await h.drain.whenIdle();
        expect(h.writes).toEqual(proof === "cap" ? [] : ["restore", "rotation"]);
        expect(h.manager.hasSession(SESSION)).toBe(false);
        expect(h.reowner.ownershipState(SESSION)).toBeUndefined();
        await h.reowner.whenIdle();
        for (const field of [
          "ownership",
          "recoveredSessions",
          "recovering",
          "episodes",
          "attempts",
          "background",
          "releaseHolds",
        ]) {
          expect(Reflect.get(h.reowner, field).size).toBe(0);
        }
      }
    },
  );

  test.each(["gate-check", "retry-tick"] as const)(
    "%s superseded release stays gated and retries until a claim lands",
    async (end) => {
      const h = await harness();
      h.behavior.busy = true;
      await h.reowner.reown([SESSION], { rehydrated: true });
      const release = h.manager.releaseSessionUnlessSuperseded(
        SESSION,
        "explicit-release",
        () => false,
      );
      await drainUntilQuiescent(h.timer);
      // Admission checks during releasing must not prune the mark.
      expect(h.reowner.automationRefusal(SESSION)).toBeDefined();
      if (end === "retry-tick") {
        await h.timer.advanceTimeAsync(2_000, () => drainUntilQuiescent(h.timer));
        expect(h.reowner.automationRefusal(SESSION)).toBeDefined();
        await h.timer.advanceTimeAsync(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS - 2_000, () =>
          drainUntilQuiescent(h.timer),
        );
      } else {
        await h.timer.advanceTimeAsync(MANAGED_OWNERSHIP_RELEASE_HOLD_CAP_MS, () =>
          drainUntilQuiescent(h.timer),
        );
      }
      expect(await release).toEqual({ superseded: true });
      expect(h.manager.hasSession(SESSION)).toBe(true);
      expect(h.reowner.automationRefusal(SESSION)).toBeDefined();
      h.behavior.busy = false;
      await drainUntilQuiescent(h.timer);
      await h.timer.advanceTimeAsync(2_000, () => drainUntilQuiescent(h.timer));
      await drainUntil(() => h.confirmed.length > 0, {
        description: "claim after superseded release",
      });
      expect(h.confirmed).toEqual([SESSION]);
      expect(h.reowner.automationRefusal(SESSION)).toBeUndefined();
      expect(h.writes).toEqual([]);
    },
  );

  test("a confirmed session can re-register and re-stamp a later foreign owner", async () => {
    const h = await harness();
    expect(await h.reowner.reown([SESSION], { rehydrated: true })).toHaveLength(1);
    await registry.releaseExecution(h.key, SESSION);
    await registry.claimExecution(h.key, h.binding, { ...PREVIOUS, sessionUuid: SESSION });
    expect(await h.reowner.reown([SESSION])).toHaveLength(1);
    expect((await registry.getAssignment(h.key))?.execOwner?.daemonId).toBe(OWNER.daemonId);
  });

  test("later foreign-owner refusal gates a confirmed session again; loss ignores confirmed and untracked sessions", async () => {
    const h = await harness();
    await h.reowner.reown([SESSION], { rehydrated: true });
    h.reowner.loseOwnership(SESSION);
    h.reowner.loseOwnership("untracked");
    expect(h.lost).toEqual([]);
    expect(h.reowner.automationRefusal(SESSION)).toBeUndefined();
    await registry.releaseExecution(h.key, SESSION);
    await registry.claimExecution(h.key, h.binding, { ...PREVIOUS, sessionUuid: SESSION });
    h.behavior.busy = true;
    await h.reowner.reown([SESSION]);
    expect(h.reowner.ownershipState(SESSION)).toBe("unconfirmed");
    expect(h.reowner.automationRefusal(SESSION)).toBeDefined();
    h.behavior.busy = false;
    await drainMicrotasks(40);
    h.timer.advanceTime(2_000);
    await drainUntil(() => h.confirmed.length === 2, { description: "second ownership episode" });
    expect(h.reowner.automationRefusal(SESSION)).toBeUndefined();
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import {
  AbandonedScopeReclaimer,
  ABANDONED_SCOPE_SWEEP_INTERVAL_MS,
  type AbandonedScopeReclaimRegistry,
} from "../../../src/daemon/managedSlots/abandonedScopeReclaimer";
import {
  ManagedSlotJournal,
  SlotJournalInFlight,
} from "../../../src/daemon/managedSlots/slotJournal";
import {
  MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS,
  type SlotJournalOwner,
  type SlotKey,
  type SlotRegistry,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { withLiveExecutionSessions } from "../../../src/daemon/managedSlots/slotOwnerLiveness";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeClaims, FakeDeleter, FakeInventory, FakeMatcher } from "./fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

// #11174 part c: a scope idle for an hour with no live owner or settler is abandoned and its devices
// are deleted through the slot journal (#11179), so a crash mid-delete is redriven. A revive of the
// same incarnation wins any race, and valid scopes are never touched.

const SCOPE_A = {
  managedHostScope: "host",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};

function owner(daemonId: string): SlotJournalOwner {
  return { daemonId, pid: daemonId === "daemon-1" ? 1001 : 2002, processGenerationToken: daemonId };
}

/** A boundary that never returns, and a promise that resolves once execution reaches it. */
function crashPoint(): { reached: Promise<void>; hang: () => Promise<never> } {
  let signal!: () => void;
  const reached = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return {
    reached,
    hang: () => {
      signal();
      return new Promise<never>(() => {});
    },
  };
}

describe("AbandonedScopeReclaimer", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: FakeInventory;
  let deleter: FakeDeleter;
  let claims: FakeClaims;
  let livePids: Set<number>;
  let liveDaemons: Set<string>;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    livePids = new Set();
    liveDaemons = new Set(["daemon-1", "daemon-2"]);
    registry = new FakeSlotRegistry(timer, (process) => livePids.has(process.pid));
    inventory = new FakeInventory();
    deleter = new FakeDeleter(inventory);
    claims = new FakeClaims();
  });

  function reclaimer(daemonId = "daemon-1", over: SlotRegistry = registry) {
    return new AbandonedScopeReclaimer({
      registry: async () => over,
      journal: (journalRegistry: AbandonedScopeReclaimRegistry) =>
        new ManagedSlotJournal({
          registry: journalRegistry as SlotRegistry,
          inventory,
          matcher: new FakeMatcher(),
          deleter,
          claims,
          timer,
          owner: owner(daemonId),
          isOwnerLive: (candidate) => liveDaemons.has(candidate.daemonId),
          isExecOwnerLive: (candidate) => livePids.has(candidate.pid),
          inFlight: new SlotJournalInFlight(),
        }),
      timer,
    });
  }

  async function idleSlot(udid: string, namespace = "runner-a"): Promise<SlotKey> {
    inventory.devices.push({ name: udid, deviceId: udid, platform: "ios", isRunning: false });
    return assignManagedSlotDevice(registry, "ios", udid, namespace);
  }

  function abandonAll(): void {
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS);
  }

  test("deletes an abandoned scope's device through the journal and leaves an empty slot", async () => {
    const key = await idleSlot("UDID-A");
    abandonAll();

    const report = await reclaimer().sweep();

    expect(report.marked).toEqual([key.scopeKey]);
    expect(report.deleted).toEqual([{ ...key, platform: "ios", stableDeviceId: "UDID-A" }]);
    expect(deleter.stableIds()).toEqual(["UDID-A"]);
    expect(inventory.has("UDID-A")).toBe(false);
    expect(await registry.getAssignment(key)).toMatchObject({
      stableDeviceId: null,
      state: "provisioning",
    });
    expect(await registry.listOpenSlotJournal()).toEqual([]);

    // Idempotent: nothing is left to delete.
    expect((await reclaimer().sweep()).deleted).toEqual([]);
    expect(deleter.calls).toHaveLength(1);
    // The same incarnation returning revives the scope with its now empty slot to recreate.
    expect(await registry.ensureScope(SCOPE_A)).toMatchObject({ kind: "ready", revived: true });
  });

  test("never touches a valid scope, a recent acquisition, or a scope with a live owner", async () => {
    const recent = await idleSlot("UDID-RECENT", "runner-recent");
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS - 1);
    inventory.devices.push({ name: "o", deviceId: "UDID-OWNED", platform: "ios", isRunning: true });
    const owned = await assignManagedSlotDevice(
      registry,
      "ios",
      "UDID-OWNED",
      "runner-owned",
      "s1",
    );
    livePids.add(1);
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS);
    await registry.ensureScope({ ...SCOPE_A, runnerNamespace: "runner-recent" });

    const report = await reclaimer().sweep();

    expect(report).toEqual({ marked: [], deleted: [], blocked: [], skipped: [] });
    expect(deleter.calls).toEqual([]);
    expect((await registry.getAssignment(recent))?.stableDeviceId).toBe("UDID-RECENT");
    expect((await registry.getAssignment(owned))?.stableDeviceId).toBe("UDID-OWNED");
  });

  test("a live execution whose recorded owner died with a restart is never abandoned (#11275)", async () => {
    // Daemon pid 1 claimed the slot for the session, then restarted: pid 1 is dead, but this
    // daemon holds the rehydrated session live.
    inventory.devices.push({ name: "s", deviceId: "UDID-LIVE", platform: "ios", isRunning: true });
    const key = await assignManagedSlotDevice(registry, "ios", "UDID-LIVE", "runner-a", "live");
    const liveSessions = new Set(["live"]);
    registry.setExecOwnerLiveness(
      withLiveExecutionSessions((process) => livePids.has(process.pid), {
        isLiveManagedExecutionSession: (sessionUuid) => liveSessions.has(sessionUuid),
      }),
    );
    timer.advanceTime(MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS + 60_000);

    expect(await reclaimer().sweep()).toEqual({
      marked: [],
      deleted: [],
      blocked: [],
      skipped: [],
    });
    expect(deleter.calls).toEqual([]);
    expect((await registry.getScope(key.scopeKey))?.state).toBe("valid");
    expect(await registry.getAssignment(key)).toMatchObject({
      generation: 1,
      state: "ready",
      stableDeviceId: "UDID-LIVE",
    });

    // Once the execution ends without a recorded release, the dead owner no longer pins the scope.
    liveSessions.clear();
    expect((await reclaimer().sweep()).marked).toEqual([key.scopeKey]);
  });

  test("a revive before the sweep keeps the device", async () => {
    const key = await idleSlot("UDID-A");
    abandonAll();
    expect((await registry.markScopeAbandoned(key.scopeKey)).kind).toBe("marked");
    await registry.ensureScope(SCOPE_A);

    expect((await reclaimer().sweep()).deleted).toEqual([]);
    expect(deleter.calls).toEqual([]);
    expect(await registry.getAssignment(key)).toMatchObject({
      stableDeviceId: "UDID-A",
      state: "ready",
    });
  });

  test("a revive racing the fence rolls the entry back and restores the slot", async () => {
    const key = await idleSlot("UDID-A");
    abandonAll();
    // The revive lands right after the journal entry (and its fence) is opened.
    const racing = new Proxy(registry, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (property !== "openSlotJournal" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: Parameters<SlotRegistry["openSlotJournal"]>) => {
          const opened = await target.openSlotJournal(...args);
          await target.ensureScope(SCOPE_A);
          return opened;
        };
      },
    });

    const report = await reclaimer("daemon-1", racing).sweep();

    expect(report.skipped).toEqual([{ ...key, reason: "scope_revived" }]);
    expect(deleter.calls).toEqual([]);
    expect(await registry.listOpenSlotJournal()).toEqual([]);
    expect(await registry.getAssignment(key)).toMatchObject({
      stableDeviceId: "UDID-A",
      state: "ready",
    });
  });

  test("a revive during the deletion cannot claim the device and then finds an empty slot", async () => {
    const key = await idleSlot("UDID-A");
    abandonAll();
    const claims_: string[] = [];
    deleter.beforeDelete = async () => {
      await registry.ensureScope(SCOPE_A);
      const current = (await registry.getAssignment(key))!;
      const claim = await registry.claimExecution(
        key,
        { generation: current.generation, stableDeviceId: current.stableDeviceId },
        { daemonId: "d", pid: 2, sessionUuid: "s2" },
      );
      claims_.push(claim.kind);
    };

    const report = await reclaimer().sweep();

    expect(claims_).toEqual(["slot_not_ready"]);
    expect(report.deleted).toHaveLength(1);
    expect((await registry.getScope(key.scopeKey))?.state).toBe("valid");
    expect(await registry.getAssignment(key)).toMatchObject({
      stableDeviceId: null,
      state: "provisioning",
      execOwner: null,
    });
  });

  test("a failed deletion stays journaled as cleanup_pending and is retried after backoff", async () => {
    const key = await idleSlot("UDID-A");
    abandonAll();
    deleter.failWith = "simulator would not shut down";

    const first = await reclaimer().sweep();

    expect(first.blocked).toMatchObject([{ ...key, reason: "cleanup_pending" }]);
    expect(await registry.getAssignment(key)).toMatchObject({
      stableDeviceId: "UDID-A",
      state: "cleanup_pending",
    });
    expect(await registry.listOpenSlotJournal(key)).toHaveLength(1);

    deleter.failWith = undefined;
    timer.advanceTime(60_000);
    const second = await reclaimer().sweep();

    expect(second.deleted).toEqual([{ ...key, platform: "ios", stableDeviceId: "UDID-A" }]);
    expect(deleter.calls).toHaveLength(2);
    expect(await registry.listOpenSlotJournal()).toEqual([]);
  });

  test("a sweep that dies mid-delete is redriven by the next daemon's sweep", async () => {
    const key = await idleSlot("UDID-A");
    abandonAll();
    const crash = crashPoint();
    deleter.beforeDelete = crash.hang;
    void reclaimer("daemon-1").sweep();
    await crash.reached;
    expect(await registry.getAssignment(key)).toMatchObject({ state: "replacing" });

    // daemon-1 is gone; daemon-2's sweep adopts the open entry and finishes the deletion.
    liveDaemons.delete("daemon-1");
    deleter.beforeDelete = undefined;
    const report = await reclaimer("daemon-2").sweep();

    expect(report.deleted).toEqual([{ ...key, platform: "ios", stableDeviceId: "UDID-A" }]);
    expect(await registry.getAssignment(key)).toMatchObject({ stableDeviceId: null });
    expect(await registry.listOpenSlotJournal()).toEqual([]);
  });

  test("an entry a live daemon is still driving is left to it", async () => {
    const key = await idleSlot("UDID-A");
    abandonAll();
    const crash = crashPoint();
    deleter.beforeDelete = crash.hang;
    void reclaimer("daemon-1").sweep();
    await crash.reached;

    const report = await reclaimer("daemon-2").sweep();

    expect(report.blocked).toMatchObject([{ ...key }]);
    expect(deleter.calls).toHaveLength(1);
  });

  test("runs on the injected timer's interval until stopped", async () => {
    await idleSlot("UDID-A");
    const sweeper = reclaimer();
    sweeper.start();
    sweeper.start();
    expect(timer.getPendingIntervalCount()).toBe(1);
    timer.advanceTime(
      MANAGED_SLOT_ABANDONED_SCOPE_THRESHOLD_MS - ABANDONED_SCOPE_SWEEP_INTERVAL_MS,
    );
    await timer.advanceTimersByTimeAsync(ABANDONED_SCOPE_SWEEP_INTERVAL_MS);
    await sweeper.sweep();
    expect(deleter.calls).toHaveLength(1);
    sweeper.stop();
    expect(timer.getPendingIntervalCount()).toBe(0);
  });
});

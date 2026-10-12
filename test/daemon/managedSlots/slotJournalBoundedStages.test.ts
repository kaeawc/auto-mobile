import { describe, expect, test } from "bun:test";
import {
  ManagedSlotJournal,
  SlotJournalRedriveLoop,
  SLOT_JOURNAL_DISCOVERY_BUDGET_MS,
  SLOT_JOURNAL_CLAIM_BUDGET_MS,
  SLOT_JOURNAL_MATCH_BUDGET_MS,
  SLOT_JOURNAL_DELETE_GRACE_MS,
  SLOT_JOURNAL_STEP_BUDGET_MS,
  SLOT_JOURNAL_STOP_BUDGET_MS,
  type SlotJournalPassResult,
} from "../../../src/daemon/managedSlots/slotJournal";
import {
  ManagedSlotReconciler,
  DefaultManagedSpecResolver,
} from "../../../src/daemon/managedSlots/reconciler";
import type { SlotJournalOwner, SlotPlatform } from "../../../src/daemon/managedSlots/slotRegistry";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

const SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};
const BACKOFF = 1_000;
function owner(daemonId: string): SlotJournalOwner {
  return {
    daemonId,
    pid: daemonId === "daemon-1" ? 1001 : 2002,
    processGenerationToken: `${daemonId}-start`,
  };
}
async function flush() {
  for (let turn = 0; turn < 150; turn += 1) {
    await Promise.resolve();
  }
}
async function harness() {
  const timer = new FakeTimer();
  const registry = new FakeSlotRegistry(timer);
  const inventory = new FakeInventory();
  const claims = new FakeClaims();
  const matcher = new FakeMatcher();
  const deleter = new FakeDeleter(inventory);
  const scope = await registry.ensureScope({
    managedHostScope: "host-a",
    runnerNamespace: "ns",
    runnerIncarnation: "inc-1",
  });
  if (scope.kind !== "ready") {
    throw new Error("scope not ready");
  }
  const deps = {
    registry,
    inventory,
    claims,
    matcher,
    deleter,
    timer,
    owner: owner("daemon-2"),
    isOwnerLive: () => false,
    backoff: BACKOFF,
  };
  const journal = new ManagedSlotJournal(deps);
  async function seed(
    slotIndex: number,
    platform: SlotPlatform = "ios",
    phase: "deleting" | "created" = "deleting",
    present = false,
  ) {
    const key = { scopeKey: scope.scope.scopeKey, slotIndex };
    const id = `device-${slotIndex}`;
    await registry.initSlot(key, { role: "app", platform, requestedSpec: SPEC });
    const bound = await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: phase === "deleting" ? id : null,
        deviceName: id,
        requestedSpec: SPEC,
        resolvedSpec: SPEC,
        specFingerprint: null,
        state: "ready",
      },
    );
    if (bound.kind !== "committed") {
      throw new Error("binding failed");
    }
    const opened = await registry.openSlotJournal(key, {
      kind: phase === "deleting" ? "replace" : "create",
      phase,
      owner: owner("daemon-1"),
      target: {
        oldStableId: phase === "deleting" ? id : null,
        oldName: id,
        newStableId: phase === "created" ? id : null,
        newName: id,
        requestedSpec: SPEC,
        resolvedSpec: SPEC,
        specFingerprint: null,
      },
      assignment: {
        kind: "state",
        expected: {
          generation: bound.assignment.generation,
          stableDeviceId: bound.assignment.stableDeviceId,
        },
        state: phase === "deleting" ? "replacing" : "provisioning",
      },
    });
    if (opened.kind !== "opened") {
      throw new Error("journal failed");
    }
    if (present) {
      inventory.devices.push({
        platform,
        name: id,
        deviceId: platform === "ios" ? id : undefined,
        runtime: SPEC.runtime,
        deviceType: SPEC.deviceType,
        isRunning: false,
      });
    }
    return { key, id, entry: opened.entry };
  }
  return { ...deps, journal, seed };
}

describe("bounded journal provider stages (#12056)", () => {
  test("a stalled Android discovery defers and releases in-flight while later iOS settles", async () => {
    const h = await harness();
    const first = await h.seed(0, "android");
    const second = await h.seed(1);
    let signal: AbortSignal | undefined;
    h.inventory.beforeList = (platform, options) => {
      if (platform === "ios") {
        return Promise.resolve();
      }
      signal = options.signal;
      return new Promise<void>(() => {});
    };
    let pass: SlotJournalPassResult | undefined;
    const loop = new SlotJournalRedriveLoop(
      {
        runPass: async (options) => {
          pass = await h.journal.runPass(options);
          return pass;
        },
      },
      h.timer,
    );
    loop.start();
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(true);
    h.timer.advanceTime(SLOT_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(pass).toMatchObject({
      blocked: [{ entryId: first.entry.id, reason: "discovery_incomplete" }],
      settled: [{ entryId: second.entry.id }],
    });
    expect(await h.registry.listOpenSlotJournal()).toMatchObject([
      {
        id: first.entry.id,
        phase: "deleting",
        attempts: 1,
        nextAttemptAtMs: h.timer.now() + BACKOFF,
      },
    ]);
    expect(signal?.aborted).toBe(true);
    expect(h.deleter.calls).toHaveLength(0);
    expect(await loop.stop()).toBe("stopped");
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("later entries settle across cycles while stalled discovery backs off and retries when due", async () => {
    const h = await harness();
    const first = await h.seed(0, "android");
    let attempts = 0;
    h.inventory.beforeList = (platform) => {
      if (platform === "ios") {
        return Promise.resolve();
      }
      attempts += 1;
      return new Promise<void>(() => {});
    };
    const loop = new SlotJournalRedriveLoop(h.journal, h.timer, 100);
    loop.start();
    await flush();
    h.timer.advanceTime(SLOT_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    const later = await h.seed(1);
    h.timer.advanceTime(100);
    await flush();
    expect(await h.registry.listOpenSlotJournal(later.key)).toEqual([]);
    expect(attempts).toBe(1);
    h.timer.advanceTime(BACKOFF - 100);
    await flush();
    expect(attempts).toBe(2);
    h.timer.advanceTime(SLOT_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(await h.registry.listOpenSlotJournal(first.key)).toMatchObject([{ attempts: 2 }]);
    expect(await loop.stop()).toBe("stopped");
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  for (const stage of ["inventory", "claim", "match", "delete"] as const) {
    test(`stop during ${stage} cancels without an attempt or later entry`, async () => {
      const h = await harness();
      const first = await h.seed(0, "ios", stage === "match" ? "created" : "deleting", true);
      const later = await h.seed(1);
      const parked = Promise.withResolvers<void>();
      let signal: AbortSignal | undefined;
      let reached = false;
      const hang = () => {
        reached = true;
        return parked.promise;
      };
      if (stage === "inventory") {
        h.inventory.beforeList = (_platform, options) => {
          signal = options.signal;
          return hang();
        };
      }
      if (stage === "claim") {
        h.claims.beforeDescribe = hang;
      }
      if (stage === "match") {
        h.matcher.beforeMatch = hang;
      }
      if (stage === "delete") {
        h.deleter.beforeDelete = (target) => {
          signal = target.signal;
          return hang();
        };
      }
      const loop = new SlotJournalRedriveLoop(h.journal, h.timer);
      loop.start();
      await flush();
      expect(reached).toBe(true);
      const before = await h.registry.listOpenSlotJournal(first.key);
      expect(await loop.stop()).toBe("stopped");
      expect(h.timer.now()).toBe(0);
      expect(await h.registry.listOpenSlotJournal(first.key)).toEqual(before);
      expect(await h.registry.listOpenSlotJournal(later.key)).toEqual([later.entry]);
      expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
      if (stage === "inventory" || stage === "delete") {
        expect(signal?.aborted).toBe(true);
      }
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      parked.resolve();
      await flush();
      expect(await h.registry.listOpenSlotJournal(first.key)).toEqual(before);
    });
  }

  test("stop bounds an unabortable registry read and prevents provider work after it returns", async () => {
    const h = await harness();
    const first = await h.seed(0);
    const read = Promise.withResolvers<void>();
    const original = h.registry.getAssignment.bind(h.registry);
    h.registry.getAssignment = async (key) => {
      await read.promise;
      return original(key);
    };
    let listed = false;
    h.inventory.beforeList = async () => {
      listed = true;
    };
    const loop = new SlotJournalRedriveLoop(h.journal, h.timer);
    loop.start();
    await flush();
    const before = await h.registry.listOpenSlotJournal(first.key);
    let result: unknown;
    const stop = loop.stop().then((value) => {
      result = value;
      return value;
    });
    h.timer.advanceTime(SLOT_JOURNAL_STOP_BUDGET_MS - 1);
    await flush();
    expect(result).toBeUndefined();
    h.timer.advanceTime(1);
    expect(await stop).toBe("timed_out");
    read.resolve();
    await flush();
    expect(listed).toBe(false);
    expect(await h.registry.listOpenSlotJournal(first.key)).toEqual(before);
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(await loop.stop()).toBe("timed_out");
  });

  test("stop interrupts inter-pass wait, is idempotent, and prohibits restart", async () => {
    const h = await harness();
    const loop = new SlotJournalRedriveLoop(h.journal, h.timer);
    loop.start();
    await flush();
    expect(h.timer.getPendingTimeoutCount()).toBe(1);
    expect(await loop.stop()).toBe("stopped");
    expect(await loop.stop()).toBe("stopped");
    loop.start();
    await flush();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    const unstarted = new SlotJournalRedriveLoop(h.journal, h.timer);
    expect(await unstarted.stop()).toBe("stopped");
    unstarted.start();
    await flush();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("late complete discovery cannot turn timeout into absence or change the binding", async () => {
    const h = await harness();
    const first = await h.seed(0);
    const parked = Promise.withResolvers<void>();
    h.inventory.beforeList = () => parked.promise;
    const binding = await h.registry.getAssignment(first.key);
    const pass = h.journal.runPass();
    await flush();
    h.timer.advanceTime(SLOT_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    await pass;
    const before = await h.registry.listOpenSlotJournal();
    parked.resolve();
    await flush();
    expect(await h.registry.listOpenSlotJournal()).toEqual(before);
    expect(await h.registry.getAssignment(first.key)).toEqual(binding);
    expect(before).toMatchObject([{ phase: "deleting", attempts: 1 }]);
    expect(h.deleter.calls).toHaveLength(0);
  });

  test("late absent delete stays cleanup_pending until fresh due discovery completes it", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    const parked = Promise.withResolvers<void>();
    h.deleter.beforeDelete = () => parked.promise;
    const pass = h.journal.runPass();
    await flush();
    h.timer.advanceTime(SLOT_JOURNAL_STEP_BUDGET_MS + SLOT_JOURNAL_DELETE_GRACE_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(await pass).toMatchObject({ blocked: [{ reason: "cleanup_pending" }] });
    const before = await h.registry.listOpenSlotJournal();
    expect(before).toMatchObject([
      { phase: "deleting", attempts: 1, nextAttemptAtMs: h.timer.now() + BACKOFF },
    ]);
    expect(await h.registry.getAssignment(first.key)).toMatchObject({
      stableDeviceId: first.id,
      state: "cleanup_pending",
    });
    parked.resolve();
    await flush();
    expect(await h.registry.listOpenSlotJournal()).toEqual(before);
    h.timer.advanceTime(BACKOFF);
    expect(await h.journal.runPass()).toMatchObject({ settled: [{ phase: "committed" }] });
    expect(await h.registry.listOpenSlotJournal()).toEqual([]);
    expect(h.deleter.calls).toHaveLength(1);
  });

  test("late mismatch cannot delete the created device", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "created", true);
    const parked = Promise.withResolvers<void>();
    h.matcher.beforeMatch = () => parked.promise;
    h.matcher.overrides.set(first.id, "mismatch");
    const pass = h.journal.runPass();
    await flush();
    h.timer.advanceTime(SLOT_JOURNAL_MATCH_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(await pass).toMatchObject({ blocked: [{ reason: "discovery_incomplete" }] });
    const before = await h.registry.listOpenSlotJournal();
    const assignment = await h.registry.getAssignment(first.key);
    if (!assignment) {
      throw new Error("created slot missing");
    }
    const replacement = await h.registry.commitBinding(first.key, assignment, {
      stableDeviceId: "newer-device",
      deviceName: "newer-device",
      requestedSpec: SPEC,
      resolvedSpec: SPEC,
      specFingerprint: null,
      state: "ready",
    });
    expect(replacement.kind).toBe("committed");
    const newerBinding = await h.registry.getAssignment(first.key);
    parked.resolve();
    await flush();
    expect(await h.registry.listOpenSlotJournal()).toEqual(before);
    expect(await h.registry.getAssignment(first.key)).toEqual(newerBinding);
    expect(h.inventory.has(first.id)).toBe(true);
    expect(h.deleter.calls).toHaveLength(0);
  });

  test("claim timeout is discovery_incomplete and late rejection is handled", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    const parked = Promise.withResolvers<void>();
    h.claims.beforeDescribe = () => parked.promise;
    const pass = h.journal.runPass();
    await flush();
    h.timer.advanceTime(SLOT_JOURNAL_CLAIM_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(await pass).toMatchObject({ blocked: [{ reason: "discovery_incomplete" }] });
    parked.reject(new Error("late claim failure"));
    await flush();
    expect(h.deleter.calls).toHaveLength(0);
  });

  test("acquisition reports retryable discovery_incomplete then fresh redrive completes", async () => {
    const h = await harness();
    const first = await h.seed(0);
    const parked = Promise.withResolvers<void>();
    h.inventory.beforeList = () => parked.promise;
    const redrive = h.journal.redriveSlot(first.key);
    await flush();
    h.timer.advanceTime(SLOT_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(await redrive).toMatchObject({ kind: "blocked", reason: "discovery_incomplete" });
    const reconciler = new ManagedSlotReconciler({
      ...h,
      resolver: new DefaultManagedSpecResolver(),
      provisioner: new FakeProvisioner(h.inventory),
      journal: { owner: owner("daemon-2"), isOwnerLive: () => false },
    });
    h.timer.advanceTime(BACKOFF);
    const reconcile = reconciler.reconcile({
      key: first.key,
      platform: "ios",
      role: "app",
      requestedSpec: SPEC,
      deadlineMs: h.timer.now() + 60_000,
    });
    await flush();
    h.timer.advanceTime(SLOT_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(await reconcile).toMatchObject({
      outcome: "failed",
      failure: { code: "discovery_incomplete", retryable: true },
    });
    h.inventory.beforeList = undefined;
    h.timer.advanceTime(10_000);
    expect(await h.journal.redriveSlot(first.key)).toMatchObject({ kind: "clear" });
    expect(await h.registry.listOpenSlotJournal()).toEqual([]);
  });

  test("caller deadline reaches the deleter unchanged and grace bounds its settlement", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    h.deleter.beforeDelete = () => new Promise<void>(() => {});
    const result = h.journal.driveDeletion(first.entry, { deadlineMs: 77 });
    await flush();
    expect(h.deleter.calls[0]?.deadlineMs).toBe(77);
    h.timer.advanceTime(77 + SLOT_JOURNAL_DELETE_GRACE_MS);
    await flush();
    expect(await result).toMatchObject({ kind: "blocked", reason: "cleanup_pending" });
  });

  test("caller cancellation rejects redrive with its reason without recording an attempt", async () => {
    const h = await harness();
    const first = await h.seed(0);
    h.inventory.beforeList = () => new Promise<void>(() => {});
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const redrive = h.journal.redriveSlot(first.key, { signal: controller.signal });
    const rejection = redrive.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    const before = await h.registry.listOpenSlotJournal();
    controller.abort(reason);
    expect(await rejection).toBe(reason);
    expect(await h.registry.listOpenSlotJournal()).toEqual(before);
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });
});

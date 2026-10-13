import { describe, expect, test } from "bun:test";
import {
  ManagedSlotReconciler,
  DefaultManagedSpecResolver,
  deviceStableId,
} from "../../../src/daemon/managedSlots/reconciler";
import {
  ManagedSlotJournal,
  SLOT_JOURNAL_DELETE_GRACE_MS,
  SlotJournalInFlight,
} from "../../../src/daemon/managedSlots/slotJournal";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../helpers/fakeTimerStepping";
import {
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

/**
 * Hunt (managed slots, 2026-10-12): the journal's delete stage budget (#12056/#12089) abandons a
 * stalled delete of an uncommitted device and leaves the create entry open. The entry's next drive
 * (the next acquisition's redrive, or the 5 s redrive loop) runs with `adopt: true`, finds the
 * device still listed and matching, and binds it to the slot. The abandoned delete is still
 * running; when it lands it destroys the device the slot now holds and an execution was handed.
 */
const SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};
const OWNER = { daemonId: "daemon-1", pid: 1001, processGenerationToken: "daemon-1-start" };
const BACKOFF_MS = 1_000;

describe("a removal the journal stopped waiting for", () => {
  test("is not followed by adopting the device it is still deleting", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    const registry = new FakeSlotRegistry(timer, () => false);
    try {
      const inventory = new FakeInventory();
      const provisioner = new FakeProvisioner(inventory);
      const deleter = new FakeDeleter(inventory);
      const reconciler = new ManagedSlotReconciler({
        registry,
        inventory,
        claims: new FakeClaims(),
        matcher: new FakeMatcher(),
        deleter,
        provisioner,
        resolver: new DefaultManagedSpecResolver(),
        timer,
        journal: {
          owner: OWNER,
          isOwnerLive: () => false,
          inFlight: new SlotJournalInFlight(),
          backoff: BACKOFF_MS,
        },
      });
      const scope = await registry.ensureScope({
        managedHostScope: "host",
        runnerNamespace: "hunt-removal-then-adoption",
        runnerIncarnation: "boot-1",
      });
      if (scope.kind !== "ready") {
        throw new Error(`scope not ready: ${scope.kind}`);
      }
      const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
      const request = (deadlineMs: number) => ({
        key,
        role: "app",
        platform: "ios" as const,
        requestedSpec: SPEC,
        deadlineMs,
        owner: OWNER,
      });

      // Acquisition 1 creates the device, which does not reach automation readiness, so the
      // reconciler removes it (`discardUncommitted` -> `settleCreation({ adopt: false })`).
      // The platform delete stalls past the stage budget (deadline + 5 s grace).
      provisioner.readinessStatus = "booted";
      const stalledDelete = Promise.withResolvers<void>();
      deleter.beforeDelete = () => stalledDelete.promise;
      const first = reconciler.reconcile(request(timer.now() + 10_000));
      await drainUntil(() => deleter.calls.length === 1, {
        description: "the removal of the unready device",
        maxTurns: 5_000,
      });
      const createdId = deleter.calls[0].stableId;
      timer.advanceTime(10_000 + SLOT_JOURNAL_DELETE_GRACE_MS);
      expect(await first).toMatchObject({
        outcome: "failed",
        failure: { code: "readiness_incomplete" },
      });
      // The removal is recorded as unfinished: the entry is open, the delete is still running.
      expect(await registry.listOpenSlotJournal(key)).toMatchObject([
        { kind: "create", phase: "created", attempts: 1 },
      ]);
      expect(inventory.has(createdId)).toBe(true);

      // Acquisition 2, once the entry's backoff is due. The device now reaches readiness.
      timer.advanceTime(BACKOFF_MS - 1);
      provisioner.readinessStatus = "automation_ready";
      const second = await reconciler.reconcile(request(timer.now() + 60_000));

      expect(second).toMatchObject({
        outcome: "failed",
        failure: { code: "cleanup_pending", retryable: true },
      });
      expect(deleter.calls).toHaveLength(1);
      expect((await registry.listOpenSlotJournal(key))[0]).toMatchObject({
        attempts: 1,
        target: { removalRequested: true },
      });

      // The delete the journal issued for this device was never withdrawn: it lands late.
      stalledDelete.resolve();
      await drainMicrotasks(20);

      const boundId = (await registry.getAssignment(key))?.stableDeviceId ?? null;
      const handedOut = second.outcome === "ready" ? second.device.stableId : null;
      // Whatever the second acquisition did, the slot must not be bound to (and no execution
      // handed) a device the journal's own delete then destroyed.
      expect({
        handedOutTheDeviceBeingDeleted: handedOut === createdId,
        boundToTheDeviceBeingDeleted: boundId === createdId,
        handedOutDeviceStillExists:
          handedOut === null ||
          inventory.devices.some((device) => deviceStableId(device) === handedOut),
      }).toEqual({
        handedOutTheDeviceBeingDeleted: false,
        boundToTheDeviceBeingDeleted: false,
        handedOutDeviceStillExists: true,
      });
      const recovered = await reconciler.reconcile(request(timer.now() + 60_000));
      expect(recovered.outcome).toBe("ready");
      if (recovered.outcome !== "ready") {
        throw new Error("expected recovery");
      }
      expect(recovered.device.stableId).not.toBe(createdId);
      expect(inventory.has(recovered.device.stableId)).toBe(true);
      expect((await registry.getAssignment(key))?.state).toBe("ready");
      expect((await registry.getSlotJournal(1))?.phase).toBe("rolled_back");
      expect(deleter.stableIds()).toEqual([createdId]);
    } finally {
      await registry.close();
    }
  });
});

async function createdEntry(
  options: { removalRequested?: true; phase?: "creating" | "created" } = {},
) {
  const timer = new FakeTimer();
  const registry = new FakeSlotRegistry(timer, () => false);
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: "removal",
    runnerIncarnation: "boot",
  });
  if (scope.kind !== "ready") {
    throw new Error(scope.kind);
  }
  const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  await registry.initSlot(key, { role: "app", platform: "ios", requestedSpec: SPEC });
  const inventory = new FakeInventory();
  inventory.devices.push({ platform: "ios", deviceId: "created", name: "amslot-created", ...SPEC });
  const deleter = new FakeDeleter(inventory);
  const opened = await registry.openSlotJournal(key, {
    kind: "create",
    phase: options.phase ?? "created",
    owner: OWNER,
    assignment: {
      kind: "state",
      expected: { generation: 0, stableDeviceId: null },
      state: "provisioning",
    },
    target: {
      oldStableId: null,
      oldName: null,
      newName: "amslot-created",
      newStableId: options.phase === "creating" ? null : "created",
      requestedSpec: SPEC,
      resolvedSpec: SPEC,
      specFingerprint: "fp",
      ...(options.removalRequested ? { removalRequested: true } : {}),
    },
  });
  if (opened.kind !== "opened") {
    throw new Error(opened.kind);
  }
  const journal = (owner = OWNER, inFlight = new SlotJournalInFlight()) =>
    new ManagedSlotJournal({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      claims: new FakeClaims(),
      deleter,
      timer,
      owner,
      inFlight,
      isOwnerLive: () => false,
      backoff: BACKOFF_MS,
    });
  return { timer, registry, key, inventory, deleter, entry: opened.entry, journal };
}

describe("created-device removal intent", () => {
  test("a failed removal is reissued and rolled back, never adopted", async () => {
    const h = await createdEntry();
    h.deleter.failWith = "partial teardown";
    expect(await h.journal().settleCreation(h.entry, { adopt: false })).toMatchObject({
      kind: "blocked",
      reason: "cleanup_pending",
    });
    h.deleter.failWith = undefined;
    h.timer.advanceTime(BACKOFF_MS);
    expect(await h.journal().redriveSlot(h.key)).toMatchObject({ kind: "clear" });
    expect((await h.registry.getSlotJournal(h.entry.id))?.phase).toBe("rolled_back");
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
    expect(h.deleter.stableIds()).toEqual(["created", "created"]);
  });

  test("a dead owner's requested removal is completed by a fresh process without adoption", async () => {
    const h = await createdEntry({ removalRequested: true });
    expect(
      await h.journal({ ...OWNER, daemonId: "next", pid: 2002 }).redriveSlot(h.key),
    ).toMatchObject({ kind: "clear" });
    expect((await h.registry.getSlotJournal(h.entry.id))?.phase).toBe("rolled_back");
    expect(h.inventory.has("created")).toBe(false);
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
    expect(h.deleter.stableIds()).toEqual(["created"]);
  });

  test("intent is durable before deleting a failed creation located by name", async () => {
    const h = await createdEntry({ phase: "creating" });
    h.deleter.beforeDelete = async () => {
      expect((await h.registry.getSlotJournal(h.entry.id))?.target).toMatchObject({
        removalRequested: true,
        newStableId: "created",
      });
    };
    expect(await h.journal().settleCreation(h.entry, { adopt: false })).toMatchObject({
      kind: "settled",
      entry: { phase: "rolled_back" },
    });
    expect(h.deleter.calls).toHaveLength(1);
  });

  test("a refused intent write issues no delete", async () => {
    const h = await createdEntry();
    h.registry.advanceSlotJournal = async () => ({ kind: "journal_conflict", entry: h.entry });
    expect(await h.journal().settleCreation(h.entry, { adopt: false })).toMatchObject({
      kind: "blocked",
      reason: "reconcile_in_progress",
    });
    expect(h.deleter.calls).toHaveLength(0);
    expect(h.inventory.has("created")).toBe(true);
  });

  test("an interrupted creation without removal intent remains adoptable", async () => {
    const h = await createdEntry();
    expect(await h.journal().redriveSlot(h.key)).toMatchObject({ kind: "clear" });
    expect((await h.registry.getSlotJournal(h.entry.id))?.phase).toBe("committed");
    expect(await h.registry.getAssignment(h.key)).toMatchObject({
      stableDeviceId: "created",
      state: "provisioning",
    });
    expect(h.deleter.calls).toHaveLength(0);
  });

  test("a failed adoption commit falls through to irreversible removal intent", async () => {
    const h = await createdEntry();
    const advance = h.registry.advanceSlotJournal.bind(h.registry);
    h.registry.advanceSlotJournal = async (id, input) =>
      input.phase === "committed" && input.assignment?.kind === "commit"
        ? { kind: "stale_binding", current: (await h.registry.getAssignment(h.key))! }
        : advance(id, input);
    h.deleter.failWith = "partial teardown";
    expect(await h.journal().settleCreation(h.entry)).toMatchObject({
      kind: "blocked",
      reason: "cleanup_pending",
      entry: { target: { removalRequested: true } },
    });
    h.deleter.failWith = undefined;
    h.timer.advanceTime(BACKOFF_MS);
    expect(await h.journal().redriveSlot(h.key)).toMatchObject({ kind: "clear" });
    expect((await h.registry.getSlotJournal(h.entry.id))?.phase).toBe("rolled_back");
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
  });

  test("shared journals fence a late failure without growing backoff or waiting for discovery", async () => {
    const h = await createdEntry({ removalRequested: true });
    const inFlight = new SlotJournalInFlight();
    const makeJournal = () =>
      new ManagedSlotJournal({
        registry: h.registry,
        inventory: h.inventory,
        matcher: new FakeMatcher(),
        claims: new FakeClaims(),
        deleter: h.deleter,
        timer: h.timer,
        owner: OWNER,
        inFlight,
        backoff: 60_000,
      });
    const completed = Promise.withResolvers<void>();
    h.deleter.beforeDelete = () => completed.promise;
    h.deleter.failWith = "late failure";
    const removal = makeJournal().settleCreation(h.entry, {
      adopt: false,
      deadlineMs: h.timer.now() + 10,
    });
    await drainUntil(() => h.deleter.calls.length === 1, { description: "shared removal" });
    h.timer.advanceTime(10 + SLOT_JOURNAL_DELETE_GRACE_MS);
    expect(await removal).toMatchObject({ kind: "blocked", reason: "cleanup_pending" });
    const timedOut = (await h.registry.getSlotJournal(h.entry.id))!;
    expect(timedOut.nextAttemptAtMs).toBe(h.timer.now());
    h.inventory.beforeList = async () => {
      throw new Error("pending removals must not rediscover");
    };
    expect(await makeJournal().redriveSlot(h.key)).toMatchObject({
      kind: "blocked",
      reason: "cleanup_pending",
      message: expect.stringContaining("created"),
    });
    expect(h.deleter.calls).toHaveLength(1);
    expect(await h.registry.getSlotJournal(h.entry.id)).toEqual(timedOut);
    completed.resolve();
    await drainMicrotasks(20);
    // The original promise's late failure has no journal write, and frees the process fence.
    expect(await h.registry.getSlotJournal(h.entry.id)).toEqual(timedOut);
    h.inventory.beforeList = undefined;
    h.deleter.beforeDelete = undefined;
    h.deleter.failWith = undefined;
    expect(await makeJournal().runPass()).toMatchObject({
      settled: [{ phase: "rolled_back" }],
      blocked: [],
    });
    expect(h.deleter.stableIds()).toEqual(["created", "created"]);
  });

  test("timed-out replacement never reuses the old device, even when the request matches it again", async () => {
    const h = await createdEntry();
    await h.registry.advanceSlotJournal(h.entry.id, {
      owner: OWNER,
      expectedPhase: "created",
      phase: "committed",
    });
    await h.registry.commitBinding(
      h.key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: "created",
        deviceName: "amslot-created",
        requestedSpec: SPEC,
        resolvedSpec: SPEC,
        specFingerprint: "fp",
        state: "ready",
      },
    );
    const provisioner = new FakeProvisioner(h.inventory);
    const reconciler = new ManagedSlotReconciler({
      registry: h.registry,
      inventory: h.inventory,
      claims: new FakeClaims(),
      matcher: new FakeMatcher(),
      deleter: h.deleter,
      provisioner,
      resolver: new DefaultManagedSpecResolver(),
      timer: h.timer,
      journal: {
        owner: OWNER,
        inFlight: new SlotJournalInFlight(),
        isOwnerLive: () => false,
        backoff: BACKOFF_MS,
      },
    });
    const request = (spec = SPEC) => ({
      key: h.key,
      role: "app",
      platform: "ios" as const,
      requestedSpec: spec,
      deadlineMs: h.timer.now() + 10_000,
      owner: OWNER,
    });
    const pending = Promise.withResolvers<void>();
    h.deleter.beforeDelete = () => pending.promise;
    const replace = reconciler.reconcile(
      request({ ...SPEC, runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-5" }),
    );
    await drainUntil(() => h.deleter.calls.length === 1, { description: "replacement delete" });
    h.timer.advanceTime(10_000 + SLOT_JOURNAL_DELETE_GRACE_MS);
    expect(await replace).toMatchObject({
      outcome: "failed",
      failure: { code: "cleanup_pending" },
    });
    for (let drive = 0; drive < 2; drive++) {
      h.timer.advanceTime(BACKOFF_MS / 3);
      expect(await reconciler.reconcile(request())).toMatchObject({
        outcome: "failed",
        failure: { code: "cleanup_pending", retryable: true },
      });
      expect(await h.registry.getAssignment(h.key)).toMatchObject({
        stableDeviceId: "created",
        state: "cleanup_pending",
      });
      expect(h.deleter.calls).toHaveLength(1);
    }
    pending.resolve();
    await drainMicrotasks(20);
    const recovered = await reconciler.reconcile(request());
    expect(recovered.outcome).toBe("ready");
    if (recovered.outcome !== "ready") {
      throw new Error("replacement did not recover");
    }
    expect(recovered.device.stableId).not.toBe("created");
    expect(h.inventory.has(recovered.device.stableId)).toBe(true);
    expect(h.deleter.stableIds()).toEqual(["created"]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  BindingJournal,
  BindingJournalRedriveLoop,
  BINDING_JOURNAL_DISCOVERY_BUDGET_MS,
  BINDING_JOURNAL_CLAIM_BUDGET_MS,
  BINDING_JOURNAL_MATCH_BUDGET_MS,
  BINDING_JOURNAL_DELETE_GRACE_MS,
  BINDING_JOURNAL_STEP_BUDGET_MS,
  BINDING_JOURNAL_STOP_BUDGET_MS,
  BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS,
  type BindingJournalPassResult,
} from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import {
  BindingReconciler,
  DefaultManagedSpecResolver,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import type {
  BindingJournalOwner,
  BindingPlatform,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
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
function owner(daemonId: string): BindingJournalOwner {
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
  const registry = new FakeBindingRegistry(timer);
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
  const journal = new BindingJournal(deps);
  async function seed(
    bindingIndex: number,
    platform: BindingPlatform = "ios",
    phase: "deleting" | "created" = "deleting",
    present = false,
  ) {
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex };
    const id = `device-${bindingIndex}`;
    await registry.initBinding(key, { role: "app", platform, requestedSpec: SPEC });
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
    const opened = await registry.openBindingJournal(key, {
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
  return { ...deps, journal, seed, key: { scopeKey: scope.scope.scopeKey, bindingIndex: 0 } };
}

async function replacementHarness() {
  const h = await harness();
  const reconciler = new BindingReconciler({
    ...h,
    resolver: new DefaultManagedSpecResolver(),
    provisioner: new FakeProvisioner(h.inventory),
    journal: {
      owner: h.owner,
      isOwnerLive: h.isOwnerLive,
      inFlight: h.journal.inFlight,
      backoff: BACKOFF,
    },
  });
  const request = {
    key: h.key,
    role: "app",
    platform: "ios" as const,
    requestedSpec: SPEC,
    deadlineMs: h.timer.now() + 60_000,
  };
  const initial = await reconciler.reconcile({
    ...request,
    requestedSpec: { ...SPEC, runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-5" },
  });
  expect(initial.outcome).toBe("ready");
  return { ...h, reconciler, request };
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
    let pass: BindingJournalPassResult | undefined;
    const loop = new BindingJournalRedriveLoop(
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
    h.timer.advanceTime(BINDING_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(pass).toMatchObject({
      blocked: [{ entryId: first.entry.id, reason: "discovery_incomplete" }],
      settled: [{ entryId: second.entry.id }],
    });
    expect(await h.registry.listOpenBindingJournal()).toMatchObject([
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
    const loop = new BindingJournalRedriveLoop(h.journal, h.timer, 100);
    loop.start();
    await flush();
    h.timer.advanceTime(BINDING_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    const later = await h.seed(1);
    h.timer.advanceTime(100);
    await flush();
    expect(await h.registry.listOpenBindingJournal(later.key)).toEqual([]);
    expect(attempts).toBe(1);
    h.timer.advanceTime(BACKOFF - 100);
    await flush();
    expect(attempts).toBe(2);
    h.timer.advanceTime(BINDING_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(await h.registry.listOpenBindingJournal(first.key)).toMatchObject([{ attempts: 2 }]);
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
      const loop = new BindingJournalRedriveLoop(h.journal, h.timer);
      loop.start();
      await flush();
      expect(reached).toBe(true);
      const before = await h.registry.listOpenBindingJournal(first.key);
      expect(await loop.stop()).toBe("stopped");
      expect(h.timer.now()).toBe(0);
      expect(await h.registry.listOpenBindingJournal(first.key)).toEqual(before);
      expect(await h.registry.listOpenBindingJournal(later.key)).toEqual([later.entry]);
      expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
      if (stage === "inventory" || stage === "delete") {
        expect(signal?.aborted).toBe(true);
      }
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      parked.resolve();
      await flush();
      expect(await h.registry.listOpenBindingJournal(first.key)).toEqual(before);
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
    const loop = new BindingJournalRedriveLoop(h.journal, h.timer);
    loop.start();
    await flush();
    const before = await h.registry.listOpenBindingJournal(first.key);
    let result: unknown;
    const stop = loop.stop().then((value) => {
      result = value;
      return value;
    });
    h.timer.advanceTime(BINDING_JOURNAL_STOP_BUDGET_MS - 1);
    await flush();
    expect(result).toBeUndefined();
    h.timer.advanceTime(1);
    expect(await stop).toBe("timed_out");
    read.resolve();
    await flush();
    expect(listed).toBe(false);
    expect(await h.registry.listOpenBindingJournal(first.key)).toEqual(before);
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    expect(await loop.stop()).toBe("timed_out");
  });

  test("stop interrupts inter-pass wait, is idempotent, and prohibits restart", async () => {
    const h = await harness();
    const loop = new BindingJournalRedriveLoop(h.journal, h.timer);
    loop.start();
    await flush();
    expect(h.timer.getPendingTimeoutCount()).toBe(1);
    expect(await loop.stop()).toBe("stopped");
    expect(await loop.stop()).toBe("stopped");
    loop.start();
    await flush();
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
    const unstarted = new BindingJournalRedriveLoop(h.journal, h.timer);
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
    h.timer.advanceTime(BINDING_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    await pass;
    const before = await h.registry.listOpenBindingJournal();
    parked.resolve();
    await flush();
    expect(await h.registry.listOpenBindingJournal()).toEqual(before);
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
    h.timer.advanceTime(BINDING_JOURNAL_STEP_BUDGET_MS + BINDING_JOURNAL_DELETE_GRACE_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(await pass).toMatchObject({ blocked: [{ reason: "cleanup_pending" }] });
    const before = await h.registry.listOpenBindingJournal();
    expect(before).toMatchObject([
      { phase: "deleting", attempts: 1, nextAttemptAtMs: h.timer.now() },
    ]);
    expect(await h.registry.getAssignment(first.key)).toMatchObject({
      stableDeviceId: first.id,
      state: "cleanup_pending",
    });
    parked.resolve();
    await flush();
    expect(await h.registry.listOpenBindingJournal()).toEqual(before);
    h.timer.advanceTime(BACKOFF);
    expect(await h.journal.runPass()).toMatchObject({ settled: [{ phase: "committed" }] });
    expect(await h.registry.listOpenBindingJournal()).toEqual([]);
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
    h.timer.advanceTime(BINDING_JOURNAL_MATCH_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(await pass).toMatchObject({ blocked: [{ reason: "discovery_incomplete" }] });
    const before = await h.registry.listOpenBindingJournal();
    const assignment = await h.registry.getAssignment(first.key);
    if (!assignment) {
      throw new Error("created binding missing");
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
    expect(await h.registry.listOpenBindingJournal()).toEqual(before);
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
    h.timer.advanceTime(BINDING_JOURNAL_CLAIM_BUDGET_MS);
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
    const redrive = h.journal.redriveBinding(first.key);
    await flush();
    h.timer.advanceTime(BINDING_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(await redrive).toMatchObject({ kind: "blocked", reason: "discovery_incomplete" });
    const reconciler = new BindingReconciler({
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
    h.timer.advanceTime(BINDING_JOURNAL_DISCOVERY_BUDGET_MS);
    await flush();
    expect(await reconcile).toMatchObject({
      outcome: "failed",
      failure: { code: "discovery_incomplete", retryable: true },
    });
    h.inventory.beforeList = undefined;
    h.timer.advanceTime(10_000);
    expect(await h.journal.redriveBinding(first.key)).toMatchObject({ kind: "clear" });
    expect(await h.registry.listOpenBindingJournal()).toEqual([]);
  });

  test("caller deadline reaches the deleter unchanged and grace bounds its settlement", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    h.deleter.beforeDelete = () => new Promise<void>(() => {});
    const result = h.journal.driveDeletion(first.entry, { deadlineMs: 77 });
    await flush();
    expect(h.deleter.calls[0]?.deadlineMs).toBe(77);
    h.timer.advanceTime(77 + BINDING_JOURNAL_DELETE_GRACE_MS);
    await flush();
    expect(await result).toMatchObject({ kind: "blocked", reason: "cleanup_pending" });
  });

  test("caller cancellation rejects redrive with its reason without recording an attempt", async () => {
    const h = await harness();
    const first = await h.seed(0);
    h.inventory.beforeList = () => new Promise<void>(() => {});
    const controller = new AbortController();
    const reason = new Error("caller stopped");
    const redrive = h.journal.redriveBinding(first.key, { signal: controller.signal });
    const rejection = redrive.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flush();
    const before = await h.registry.listOpenBindingJournal();
    controller.abort(reason);
    expect(await rejection).toBe(reason);
    expect(await h.registry.listOpenBindingJournal()).toEqual(before);
    expect(h.journal.inFlight.has(first.entry.id)).toBe(false);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  for (const cancellation of ["parked", "cooperative"] as const) {
    test(`replacement caller abort with ${cancellation} deleter resolves cleanup_pending and redrives`, async () => {
      const h = await replacementHarness();
      const controller = new AbortController();
      const reached = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      if (cancellation === "parked") {
        h.deleter.beforeDelete = () => {
          reached.resolve();
          return completed.promise;
        };
      } else {
        h.deleter.deleteAndVerifyAbsence = async (target) => {
          // Abort immediately before the cooperative deleter reads its signal.
          controller.abort(new Error("caller cancelled"));
          h.deleter.calls.push(target);
          expect(target.signal?.aborted).toBe(true);
          return { kind: "failed", message: "cooperative delete cancelled" };
        };
      }
      const result = h.reconciler.reconcile({ ...h.request, signal: controller.signal }).then(
        (value) => value,
        (error: unknown) => error,
      );
      if (cancellation === "parked") {
        await reached.promise;
        controller.abort(new Error("caller cancelled"));
      }
      expect(await result).toMatchObject({
        outcome: "failed",
        failure: { code: "cleanup_pending", retryable: true },
      });
      const open = await h.registry.listOpenBindingJournal(h.key);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        phase: "deleting",
        attempts: 1,
        nextAttemptAtMs: h.timer.now() + (cancellation === "parked" ? 0 : BACKOFF),
      });
      expect(await h.registry.getAssignment(h.key)).toMatchObject({ state: "cleanup_pending" });
      expect(h.journal.inFlight.has(open[0].id)).toBe(false);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      h.deleter.beforeDelete = undefined;
      h.deleter.deleteAndVerifyAbsence = FakeDeleter.prototype.deleteAndVerifyAbsence.bind(
        h.deleter,
      );
      h.timer.advanceTime(BACKOFF);
      if (cancellation === "parked") {
        expect(await h.journal.redriveBinding(h.key)).toMatchObject({
          kind: "blocked",
          reason: "cleanup_pending",
        });
        expect(h.deleter.calls).toHaveLength(1);
        completed.resolve();
        await flush();
      }
      expect(await h.journal.redriveBinding(h.key)).toMatchObject({ kind: "clear" });
      expect(await h.registry.listOpenBindingJournal(h.key)).toEqual([]);
      expect(h.inventory.has(open[0].target.oldStableId!)).toBe(false);
    });
  }

  test("acquisition beyond overdue grace returns immediately and leaves retry to the pass", async () => {
    const h = await replacementHarness();
    h.deleter.beforeDelete = () => new Promise<void>(() => {});
    const replacement = h.reconciler.reconcile({
      ...h.request,
      requestedSpec: SPEC,
      deadlineMs: h.timer.now() + 10,
    });
    await flush();
    expect(h.deleter.calls).toHaveLength(1);
    h.timer.advanceTime(10 + BINDING_JOURNAL_DELETE_GRACE_MS);
    expect(await replacement).toMatchObject({
      outcome: "failed",
      failure: { code: "cleanup_pending", retryable: true },
    });
    h.timer.advanceTime(BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS + 1);
    const before = await h.registry.listOpenBindingJournal(h.key);
    const now = h.timer.now();
    let returned = false;
    const acquisition = h.reconciler
      .reconcile({ ...h.request, deadlineMs: now + 10 })
      .then((result) => {
        returned = true;
        return result;
      });
    await flush();
    expect(returned).toBe(true);
    expect(await acquisition).toMatchObject({
      outcome: "failed",
      failure: { code: "cleanup_pending", retryable: true },
    });
    expect(h.timer.now()).toBe(now);
    expect(h.deleter.calls).toHaveLength(1);
    expect(await h.registry.listOpenBindingJournal(h.key)).toEqual(before);
    h.deleter.beforeDelete = undefined;
    expect(await h.journal.runPass()).toMatchObject({ settled: [{ phase: "committed" }] });
    expect(h.deleter.calls).toHaveLength(2);
  });

  test("public deletion with an already aborted signal records cleanup_pending", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    const journal = new BindingJournal({ ...h, owner: first.entry.owner });
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled before deletion"));
    const result = await journal.driveDeletion(first.entry, { signal: controller.signal }).then(
      (value) => value,
      (error: unknown) => error,
    );
    expect(result).toMatchObject({ kind: "blocked", reason: "cleanup_pending" });
    expect(await h.registry.listOpenBindingJournal(first.key)).toMatchObject([
      {
        attempts: 1,
        phase: "deleting",
        lastError: expect.stringContaining("cancelled"),
        nextAttemptAtMs: BACKOFF,
      },
    ]);
    expect(h.timer.getPendingTimeoutCount()).toBe(0);
  });

  test("public deletion records a typed failure when caller aborts as the delete completes", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    const journal = new BindingJournal({ ...h, owner: first.entry.owner });
    const controller = new AbortController();
    h.deleter.afterDelete = async () => {
      controller.abort(new Error("caller cancelled after delete"));
    };
    const result = await journal.driveDeletion(first.entry, { signal: controller.signal });
    expect(result).toMatchObject({ kind: "blocked", reason: "cleanup_pending" });
    expect(await h.registry.listOpenBindingJournal(first.key)).toMatchObject([
      { attempts: 1, phase: "deleting" },
    ]);
    expect(h.inventory.has(first.id)).toBe(false);
    h.timer.advanceTime(BACKOFF);
    expect(await h.journal.redriveBinding(first.key)).toMatchObject({ kind: "clear" });
  });

  test("public creation settlement returns a typed result on discovery timeout", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "created", true);
    const journal = new BindingJournal({ ...h, owner: first.entry.owner });
    h.inventory.beforeList = () => new Promise<void>(() => {});
    const result = journal.settleCreation(first.entry, { adopt: true });
    await flush();
    h.timer.advanceTime(BINDING_JOURNAL_DISCOVERY_BUDGET_MS);
    expect(await result).toMatchObject({ kind: "blocked", reason: "discovery_incomplete" });
    expect(await h.registry.listOpenBindingJournal(first.key)).toMatchObject([
      { phase: "created", attempts: 1 },
    ]);
  });

  test("redrive preserves a foreign registry error instance and class", async () => {
    const h = await harness();
    class RegistryError extends Error {}
    const error = new RegistryError("registry unavailable");
    h.registry.listOpenBindingJournal = async () => {
      throw error;
    };
    const result = await h.journal.redriveBinding(h.key).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(result).toBe(error);
    expect(result).toBeInstanceOf(RegistryError);
  });

  test("rejected delete preserves provider text in its recorded attempt", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    h.deleter.beforeDelete = async () => {
      throw new Error("simctl delete exploded");
    };
    expect(await h.journal.redriveBinding(first.key)).toMatchObject({
      kind: "blocked",
      reason: "cleanup_pending",
    });
    expect(await h.registry.listOpenBindingJournal(first.key)).toMatchObject([
      { attempts: 1, lastError: expect.stringContaining("simctl delete exploded") },
    ]);
  });

  test("delete timeout names the device and budget in its recorded attempt", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    const journal = new BindingJournal({ ...h, owner: first.entry.owner });
    h.deleter.beforeDelete = () => new Promise<void>(() => {});
    const result = journal.driveDeletion(first.entry, { deadlineMs: 77 });
    await flush();
    h.timer.advanceTime(77 + BINDING_JOURNAL_DELETE_GRACE_MS);
    expect(await result).toMatchObject({ kind: "blocked", reason: "cleanup_pending" });
    expect(await h.registry.listOpenBindingJournal(first.key)).toMatchObject([
      { attempts: 1, lastError: "deleting 'device-0' timed out after 5077ms" },
    ]);
  });

  test("rejected claim preserves provider text in its recorded attempt", async () => {
    const h = await harness();
    const first = await h.seed(0, "ios", "deleting", true);
    h.claims.beforeDescribe = async () => {
      throw new Error("claim lookup exploded");
    };
    expect(await h.journal.redriveBinding(first.key)).toMatchObject({
      kind: "blocked",
      reason: "discovery_incomplete",
    });
    expect(await h.registry.listOpenBindingJournal(first.key)).toMatchObject([
      { attempts: 1, lastError: expect.stringContaining("claim lookup exploded") },
    ]);
  });
});

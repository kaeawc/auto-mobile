import { describe, expect, test } from "bun:test";
import {
  BindingJournal,
  BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS,
  BINDING_JOURNAL_MAX_ABANDONED_DELETES,
  BINDING_JOURNAL_STEP_BUDGET_MS,
  BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS,
} from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import {
  BindingReconciler,
  DefaultManagedSpecResolver,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeInventory,
  FakeClaims,
  FakeMatcher,
  FakeDeleter,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

const OWNER = { daemonId: "one", pid: 101, processGenerationToken: "one" };
const SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};
async function flush() {
  for (let i = 0; i < 150; i++) {
    await Promise.resolve();
  }
}
async function immediately(operation: Promise<unknown>): Promise<unknown> {
  let returned = false;
  const result = operation.then((value) => {
    returned = true;
    return value;
  });
  await flush();
  expect(returned).toBe(true);
  return result;
}
async function harness(mode: "created" | "deleting" = "created") {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer, () => false);
  const inventory = new FakeInventory();
  const deleter = new FakeDeleter(inventory);
  const deps = {
    registry,
    inventory,
    deleter,
    timer,
    claims: new FakeClaims(),
    matcher: new FakeMatcher(),
    owner: OWNER,
    isOwnerLive: () => false,
    backoff: 1,
    stageBudgets: { deleteGraceMs: 5 },
  };
  const journal = new BindingJournal(deps);
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: "hung",
    runnerIncarnation: "boot",
  });
  if (scope.kind !== "ready") {
    throw new Error(scope.kind);
  }
  const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  await registry.initBinding(key, { role: "app", platform: "ios", requestedSpec: SPEC });
  if (mode !== "created") {
    await registry.commitBinding(
      key,
      { generation: 0, stableDeviceId: null },
      {
        stableDeviceId: "device",
        deviceName: "amslot-device",
        requestedSpec: SPEC,
        resolvedSpec: SPEC,
        specFingerprint: null,
        state: "ready",
      },
    );
  }
  inventory.devices.push({
    platform: "ios",
    deviceId: "device",
    name: "amslot-device",
    isRunning: false,
    isRunningStateKnown: false,
    ...SPEC,
  });
  const assignment = (await registry.getAssignment(key))!;
  const opened = await registry.openBindingJournal(key, {
    kind: mode === "created" ? "create" : "replace",
    phase: mode,
    owner: OWNER,
    target: {
      oldStableId: mode === "deleting" ? "device" : null,
      oldName: null,
      newStableId: mode === "created" ? "device" : null,
      newName: "amslot-device",
      requestedSpec: SPEC,
      resolvedSpec: SPEC,
      specFingerprint: null,
    },
    assignment: {
      kind: "state",
      expected: assignment,
      state: mode === "created" ? "provisioning" : "replacing",
    },
  });
  if (opened.kind !== "opened") {
    throw new Error(opened.kind);
  }
  return { ...deps, journal, key, entry: opened.entry };
}
async function timeout(h: Awaited<ReturnType<typeof harness>>) {
  const drive =
    h.entry.phase === "created"
      ? h.journal.settleCreation(h.entry, { adopt: false, deadlineMs: h.timer.now() + 10 })
      : h.journal.driveDeletion((await h.registry.getBindingJournal(h.entry.id))!, {
          deadlineMs: h.timer.now() + 10,
        });
  await flush();
  h.timer.advanceTime(15);
  await flush();
  await drive;
}

describe("bounded abandoned journal deletes", () => {
  for (const mode of ["deleting", "created"] as const) {
    test(`${mode} public drives remain conservative beyond overdue grace`, async () => {
      const h = await harness(mode);
      h.deleter.beforeDelete = () => new Promise<void>(() => {});
      await timeout(h);
      h.timer.advanceTime(BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS + 1);
      const before = await h.registry.listOpenBindingJournal(h.key);
      const expected = {
        kind: "blocked",
        reason: "cleanup_pending",
        message: "Removal of device 'device' is still in flight.",
      };
      expect(await immediately(h.journal.redriveBinding(h.key))).toMatchObject(expected);
      const entry = before[0];
      const step =
        mode === "deleting" ? h.journal.driveDeletion(entry) : h.journal.settleCreation(entry);
      expect(await immediately(step)).toMatchObject(expected);
      expect(h.deleter.calls).toHaveLength(1);
      expect(await h.registry.listOpenBindingJournal(h.key)).toEqual(before);
      h.deleter.beforeDelete = undefined;
      expect(await h.journal.runPass()).toMatchObject({
        settled: [{ phase: mode === "deleting" ? "committed" : "rolled_back" }],
      });
      expect(h.deleter.calls).toHaveLength(2);
    });
  }

  for (const mode of ["deleting", "created"] as const) {
    test(`${mode} public step alone cannot abandon an overdue removal`, async () => {
      const h = await harness(mode);
      h.deleter.beforeDelete = () => new Promise<void>(() => {});
      await timeout(h);
      h.timer.advanceTime(BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS + 1);
      const before = await h.registry.listOpenBindingJournal(h.key);
      const step =
        mode === "deleting"
          ? h.journal.driveDeletion(before[0])
          : h.journal.settleCreation(before[0]);
      expect(await immediately(step)).toMatchObject({
        kind: "blocked",
        reason: "cleanup_pending",
        message: "Removal of device 'device' is still in flight.",
      });
      expect(h.deleter.calls).toHaveLength(1);
      expect(await h.registry.listOpenBindingJournal(h.key)).toEqual(before);
    });
  }

  test("removal flag writes are bounded to six attempts", () => {
    expect(BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS).toBe(6);
  });

  for (const mode of ["deleting", "created"] as const) {
    test(`${mode} acquisition is blocked immediately while the pass retry is pending`, async () => {
      const h = await harness(mode);
      h.deleter.beforeDelete = () => new Promise<void>(() => {});
      await timeout(h);
      h.timer.advanceTime(BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS + 1);
      const pass = h.journal.runPass();
      await flush();
      expect(h.deleter.calls).toHaveLength(2);
      const before = await h.registry.listOpenBindingJournal(h.key);
      expect(await immediately(h.journal.redriveBinding(h.key))).toMatchObject({
        kind: "blocked",
        reason: "cleanup_pending",
        message: "Removal of device 'device' is still in flight.",
      });
      expect(await h.journal.runPass()).toMatchObject({ skipped: 1 });
      expect(h.deleter.calls).toHaveLength(2);
      expect(await h.registry.listOpenBindingJournal(h.key)).toEqual(before);
      h.timer.advanceTime(BINDING_JOURNAL_STEP_BUDGET_MS + 5);
      expect(await pass).toMatchObject({ blocked: [{ reason: "cleanup_pending" }] });
    });
  }

  test("late settlement of an abandoned token cannot clear its successor", async () => {
    const h = await harness("deleting");
    const old = Promise.withResolvers<void>();
    const newer = Promise.withResolvers<void>();
    h.deleter.beforeDelete = () => (h.deleter.calls.length === 1 ? old.promise : newer.promise);
    await timeout(h);
    h.timer.advanceTime(BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS + 1);
    const pass = h.journal.runPass();
    await flush();
    expect(h.deleter.calls).toHaveLength(2);
    h.deleter.failWith = "late failure";
    old.resolve();
    await flush();
    expect(h.journal.inFlight.hasRemoval("ios", "device")).toBe(true);
    expect(await immediately(h.journal.redriveBinding(h.key))).toMatchObject({
      kind: "blocked",
      reason: "cleanup_pending",
    });
    h.deleter.failWith = undefined;
    newer.resolve();
    expect(await pass).toMatchObject({ settled: [{ phase: "committed" }] });
    expect(h.journal.inFlight.hasRemoval("ios", "device")).toBe(false);
    expect(h.deleter.calls).toHaveLength(2);
  });

  for (const mode of ["deleting"] as const) {
    test(`${mode} retries after overdue grace and settles`, async () => {
      const h = await harness(mode);
      h.deleter.beforeDelete = () => new Promise<void>(() => {});
      await timeout(h);
      h.timer.advanceTime(1);
      expect(await h.journal.runPass()).toMatchObject({
        blocked: [{ reason: "cleanup_pending" }],
      });
      expect(h.deleter.calls).toHaveLength(1);
      h.timer.advanceTime(BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS);
      h.deleter.beforeDelete = undefined;
      expect(await h.journal.runPass()).toMatchObject({ settled: [{ phase: "committed" }] });
      expect(h.deleter.calls).toHaveLength(2);
      expect((await h.registry.getAssignment(h.key))?.stableDeviceId ?? null).toBeNull();
    });
  }

  test("three abandoned pending deletes stop retries until one settles", async () => {
    const h = await harness("deleting");
    const pending = Array.from({ length: BINDING_JOURNAL_MAX_ABANDONED_DELETES }, () =>
      Promise.withResolvers<void>(),
    );
    h.deleter.beforeDelete = () => pending[h.deleter.calls.length - 1].promise;
    for (let i = 0; i < BINDING_JOURNAL_MAX_ABANDONED_DELETES; i++) {
      if (i === 0) {
        await timeout(h);
      } else {
        const pass = h.journal.runPass();
        await flush();
        h.timer.advanceTime(BINDING_JOURNAL_STEP_BUDGET_MS + 5);
        await pass;
      }
      h.timer.advanceTime(BINDING_JOURNAL_OVERDUE_DELETE_GRACE_MS);
    }
    expect(h.deleter.calls).toHaveLength(3);
    expect(await h.journal.runPass()).toMatchObject({ blocked: [{ reason: "cleanup_pending" }] });
    expect(h.deleter.calls).toHaveLength(3);
    h.deleter.failWith = "late failure";
    pending[0].resolve();
    await flush();
    h.deleter.failWith = undefined;
    h.deleter.beforeDelete = undefined;
    expect(await h.journal.runPass()).toMatchObject({ settled: [{ phase: "committed" }] });
    expect(h.deleter.calls).toHaveLength(4);
  });

  for (const failures of [2, BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS]) {
    test(`removal flag retries ${failures} busy writes and never adopts on exhaustion`, async () => {
      const h = await harness();
      const advance = h.registry.advanceBindingJournal.bind(h.registry);
      let calls = 0;
      h.registry.advanceBindingJournal = async (...args) => {
        calls++;
        if (calls <= failures) {
          throw new Error("SQLITE_BUSY");
        }
        return advance(...args);
      };
      const request = h.journal.requestRemoval(h.entry!);
      await flush();
      for (let i = 0; i < BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS - 1; i++) {
        h.timer.advanceTime(Math.min(25 * 2 ** i, 1_000));
        await flush();
      }
      const returned = await request;
      expect(calls).toBe(
        failures === BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS
          ? BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS
          : 3,
      );
      expect(returned.target.removalRequested).toBe(
        failures === BINDING_JOURNAL_REMOVAL_FLAG_MAX_ATTEMPTS ? undefined : true,
      );
      h.registry.advanceBindingJournal = advance;
      expect(await h.journal.runPass()).toMatchObject({ settled: [{ phase: "rolled_back" }] });
      expect(h.deleter.calls).toHaveLength(1);
      expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
    });
  }

  test("readiness discard retains intent when its atomic created write is busy", async () => {
    const h = await harness();
    await h.journal.close(h.entry!, "rolled_back");
    h.inventory.devices.length = 0;
    const provisioner = new FakeProvisioner(h.inventory);
    provisioner.readinessStatus = "booted";
    const reconciler = new BindingReconciler({
      ...h,
      provisioner,
      resolver: new DefaultManagedSpecResolver(),
      journal: { owner: OWNER, isOwnerLive: () => false },
    });
    const advance = h.registry.advanceBindingJournal.bind(h.registry);
    h.registry.advanceBindingJournal = async (id, input) => {
      if (input.target?.removalRequested) {
        throw new Error("SQLITE_BUSY");
      }
      return advance(id, input);
    };
    const result = reconciler.reconcile({
      key: h.key,
      platform: "ios",
      role: "app",
      requestedSpec: SPEC,
      deadlineMs: 20_000,
    });
    await flush();
    expect(await result).toMatchObject({
      outcome: "failed",
      failure: { code: "discovery_incomplete" },
    });
    h.registry.advanceBindingJournal = advance;
    expect(await reconciler.journal.runPass()).toMatchObject({
      settled: [{ phase: "rolled_back" }],
    });
    expect(h.deleter.calls).toHaveLength(1);
    expect((await h.registry.getAssignment(h.key))?.stableDeviceId).toBeNull();
  });
});

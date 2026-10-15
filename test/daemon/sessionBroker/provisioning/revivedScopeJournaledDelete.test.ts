import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AbandonedScopeReclaimer } from "../../../helpers/deferredProvisioningFixtures";
import {
  DefaultManagedSpecResolver,
  encodeManagedSpecFingerprint,
  BindingReconciler,
  type BindingReconcileResult,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { BindingJournalInFlight } from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import { InFlightBindingReservations } from "../../../../src/daemon/sessionBroker/registry/ownerLiveness";
import {
  BINDING_ABANDONED_SCOPE_THRESHOLD_MS,
  type BindingJournalEntry,
  type BindingKey,
  type BindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { openSqliteBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

// Owner decision 2026-10-12 (#11545): a journaled abandoned-scope delete always completes,
// even after the same incarnation revives. Its next acquisition creates a NEW device.
// A revive before journaling keeps the intact device and its generation.
const SCOPE = {
  managedHostScope: "host",
  runnerNamespace: "runner-a",
  runnerIncarnation: "boot-1",
};
const SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};

describe("revived scopes finish journaled deletes on SQLite", () => {
  let timer: FakeTimer;
  let registry: BindingRegistry;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let claims: FakeClaims;
  let reconciler: BindingReconciler;
  let key: BindingKey;
  let old: string;
  let registryClosed = false;

  function makeReconciler(daemonId: string) {
    return new BindingReconciler({
      registry,
      inventory,
      provisioner,
      deleter,
      claims,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      capacity: new FakeCapacity(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
      reservations: new InFlightBindingReservations(),
      journal: {
        owner: {
          daemonId,
          pid: daemonId === "daemon-1" ? 101 : 202,
          processGenerationToken: daemonId,
        },
        isOwnerLive: () => false,
        inFlight: new BindingJournalInFlight(),
      },
    });
  }

  function request() {
    return {
      key,
      role: "primary",
      platform: "ios" as const,
      requestedSpec: SPEC,
      deadlineMs: timer.now() + 60_000,
    };
  }

  function ready(result: BindingReconcileResult) {
    expect(result.outcome).toBe("ready");
    if (result.outcome !== "ready") {
      throw new Error(`expected ready: ${JSON.stringify(result.failure)}`);
    }
    return result;
  }

  function retryable(result: BindingReconcileResult, code: string) {
    expect(result).toMatchObject({ outcome: "failed", failure: { code, retryable: true } });
  }

  async function initializeFixture() {
    timer = new FakeTimer();
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: () => false,
    });
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    claims = new FakeClaims();
    reconciler = makeReconciler("daemon-1");
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    const resolution = await new DefaultManagedSpecResolver().resolve("ios", SPEC, {});
    if (resolution.kind !== "resolved") {
      throw new Error("fixture spec did not resolve");
    }
    const first = await provisioner.provision({
      platform: "ios",
      name: "old-device",
      mode: "create",
      spec: SPEC,
      deadlineMs: timer.now() + 60_000,
    });
    old = first.device.stableId;
    await registry.initBinding(key, { role: "primary", platform: "ios", requestedSpec: SPEC });
    expect(
      await registry.commitBinding(
        key,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: old,
          deviceName: first.device.name,
          requestedSpec: SPEC,
          resolvedSpec: resolution.resolvedSpec,
          specFingerprint: encodeManagedSpecFingerprint(resolution.fingerprint),
          state: "ready",
        },
      ),
    ).toMatchObject({ kind: "committed", assignment: { generation: 1 } });
    registryClosed = false;
  }

  // Pay the first SQLite/runtime initialization once in suite setup. Every scenario still owns
  // a fresh in-memory registry, closed below; subsequent scenarios initialize after that close.
  beforeAll(initializeFixture);
  beforeEach(async () => {
    if (registryClosed) {
      await initializeFixture();
    }
  });

  afterEach(async () => {
    await registry.close();
    registryClosed = true;
  });

  async function blockedSweep(
    kind: "held" | "unknown" = "held",
    revive = true,
  ): Promise<BindingJournalEntry> {
    claims.claims.set(old, { kind, reason: "test blocker" });
    timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS);
    const report = await new AbandonedScopeReclaimer({
      registry: async () => registry,
      journal: () => reconciler.journal,
      timer,
    }).sweep();
    expect(report.blocked).toMatchObject([
      { ...key, reason: kind === "held" ? "device_busy" : "discovery_incomplete" },
    ]);
    expect(report.deleted).toEqual([]);
    const [entry] = await registry.listOpenBindingJournal(key);
    expect(entry).toMatchObject({
      kind: "replace",
      phase: "deleting",
      binding: { generation: 2, stableDeviceId: old },
      target: { newName: null },
    });
    if (revive) {
      expect(await registry.ensureScope(SCOPE)).toMatchObject({ kind: "ready", revived: true });
    }
    return entry!;
  }

  async function retryDue() {
    const [entry] = await registry.listOpenBindingJournal(key);
    if (!entry) {
      throw new Error("expected pending delete");
    }
    timer.advanceTime(Math.max(0, entry.nextAttemptAtMs - timer.now()) + 1);
  }

  async function expectPending(entry: BindingJournalEntry) {
    expect(deleter.calls).toEqual([]);
    expect(provisioner.created()).toHaveLength(1);
    expect(await registry.getAssignment(key)).toMatchObject({
      state: "replacing",
      stableDeviceId: old,
      generation: entry.binding.generation,
    });
    expect(
      await registry.claimExecution(key, entry.binding, {
        daemonId: "daemon-1",
        pid: 101,
        sessionUuid: "revived",
      }),
    ).toMatchObject({ kind: "binding_not_ready" });
  }

  async function expectNewDevice(driver: BindingReconciler, entry: BindingJournalEntry) {
    const result = ready(await driver.reconcile(request()));
    expect(result.disposition).toBe("created");
    expect(result.device.stableId).not.toBe(old);
    expect(result.assignment).toMatchObject({
      state: "ready",
      platform: "ios",
      stableDeviceId: result.device.stableId,
      generation: 4,
    });
    expect(result.assignment.generation).toBeGreaterThan(entry.binding.generation);
    expect(inventory.has(old)).toBe(false);
    expect(await registry.findDeviceHolder("ios", old)).toBeNull();
    expect(await registry.getScope(key.scopeKey)).toMatchObject({ state: "valid" });
    expect(await registry.listOpenBindingJournal(key)).toEqual([]);
    expect(await registry.getBindingJournal(entry.id)).toMatchObject({ phase: "committed" });
    expect(provisioner.created()).toHaveLength(2);
  }

  for (const kind of ["held", "unknown"] as const) {
    test(`a revived scope waits for a ${kind} device, then deletes and creates a new one`, async () => {
      const entry = await blockedSweep(kind);
      // Make another attempt with the blocker still present, outside the first backoff.
      await retryDue();
      retryable(
        await reconciler.reconcile(request()),
        kind === "held" ? "device_busy" : "discovery_incomplete",
      );
      await expectPending(entry);
      claims.claims.clear();
      await retryDue();
      await expectNewDevice(reconciler, entry);
      expect(deleter.stableIds()).toEqual([old]);
    });
  }

  test("an acquisition inside backoff answers cleanup_pending without reusing the old device", async () => {
    const entry = await blockedSweep();
    claims.claims.clear();
    retryable(await reconciler.reconcile(request()), "cleanup_pending");
    await expectPending(entry);
    expect(await registry.getBindingJournal(entry.id)).toMatchObject({
      phase: "deleting",
      attempts: 1,
    });
  });

  test("redrive alone finishes the delete after revival; the next acquisition creates", async () => {
    const entry = await blockedSweep();
    claims.claims.clear();
    await retryDue();
    const pass = await reconciler.journal.runPass();
    expect(pass.blocked).toEqual([]);
    expect(pass.settled).toHaveLength(1);
    expect(deleter.stableIds()).toEqual([old]);
    expect(await registry.getAssignment(key)).toMatchObject({
      state: "provisioning",
      stableDeviceId: null,
      generation: 3,
    });
    expect(await registry.getScope(key.scopeKey)).toMatchObject({ state: "valid" });
    expect(await registry.listOpenBindingJournal(key)).toEqual([]);
    expect(provisioner.created()).toHaveLength(1);
    await expectNewDevice(reconciler, entry);
    expect(deleter.stableIds()).toEqual([old]);
  });

  for (const crash of ["before_delete", "mid_delete", "after_deleted"] as const) {
    test(`daemon-2 replays a revived scope after daemon-1 died ${crash}`, async () => {
      const entry = await blockedSweep("held", false);
      claims.claims.clear();
      if (crash !== "before_delete") {
        // The destructive step completed, but daemon-1 died before closing the entry.
        await deleter.deleteAndVerifyAbsence({
          platform: "ios",
          stableId: old,
          name: entry.target.oldName,
          deadlineMs: timer.now() + 60_000,
        });
        expect(await registry.getBindingJournal(entry.id)).toMatchObject({ phase: "deleting" });
      }
      if (crash === "after_deleted") {
        expect(
          await registry.advanceBindingJournal(entry.id, {
            owner: entry.owner,
            expectedPhase: "deleting",
            phase: "deleted",
            assignment: {
              kind: "commit",
              expected: entry.binding,
              next: {
                stableDeviceId: null,
                deviceName: null,
                resolvedSpec: null,
                specFingerprint: null,
                state: "provisioning",
              },
            },
          }),
        ).toMatchObject({ kind: "advanced", assignment: { stableDeviceId: null, generation: 3 } });
        expect(await registry.getBindingJournal(entry.id)).toMatchObject({ phase: "deleted" });
      }
      expect(await registry.ensureScope(SCOPE)).toMatchObject({ kind: "ready", revived: true });
      await retryDue();
      const daemon2 = makeReconciler("daemon-2");
      await expectNewDevice(daemon2, entry);
      expect(deleter.stableIds()).toEqual([old]);
      expect(await registry.getBindingJournal(entry.id)).toMatchObject({
        owner: { daemonId: "daemon-2" },
        phase: "committed",
      });
    });
  }

  test("a revive before any journal entry reuses the intact device and generation", async () => {
    timer.advanceTime(BINDING_ABANDONED_SCOPE_THRESHOLD_MS);
    expect(await registry.markScopeAbandoned(key.scopeKey)).toMatchObject({ kind: "marked" });
    expect(await registry.ensureScope(SCOPE)).toMatchObject({ kind: "ready", revived: true });
    const result = ready(await reconciler.reconcile(request()));
    expect(result.disposition).toBe("reused");
    expect(result.device.stableId).toBe(old);
    expect(result.assignment.generation).toBe(1);
    expect(deleter.calls).toEqual([]);
    expect(provisioner.created()).toHaveLength(1);
    expect(await registry.listOpenBindingJournal(key)).toEqual([]);
  });
});

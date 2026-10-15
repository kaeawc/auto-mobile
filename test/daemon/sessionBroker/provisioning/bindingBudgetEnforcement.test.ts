import { afterAll, describe, expect, test } from "bun:test";
import { warmedTests } from "../../../helpers/warmedTests";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { migrateBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import {
  RegistryBindingResourceBudget,
  computeBindingResourceUsage,
  type BindingResourceBudget,
} from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import {
  DefaultManagedSpecResolver,
  BindingReconciler,
  bindingDeviceName,
  type BindingReconcileRequest,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { flushMicrotasks } from "../../../helpers/shutdownStageHarness";
import {
  FakeInventory,
  FakeClaims,
  FakeMatcher,
  FakeProvisioner,
  FakeDeleter,
} from "../registry/fixtures/reconcilerFakes";
import { assignBindingDevice } from "./bindingFixtures";

const SPEC = { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" };
const OWNER = { daemonId: "one", pid: 101, processGenerationToken: "one" };

// Both daemon registries share one in-memory connection: independent file connections would
// require a file-backed database, unnecessary to prove reservation ordering and forbidden temp I/O.
describe("binding total-resource enforcement on SQLite", () => {
  let db: Kysely<BindingRegistryDatabase>;
  let registry: SqliteBindingRegistry;
  let timer: FakeTimer;
  let inventory: FakeInventory;
  let claims: FakeClaims;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;

  let closeDatabase: (() => Promise<void>) | undefined;
  const reset = async () => {
    await closeDatabase?.();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });
    closeDatabase = () => db.destroy();
    await migrateBindingRegistry(db, ":memory:");
    registry = new SqliteBindingRegistry(db, { timer, isExecOwnerLive: () => false });
    inventory = new FakeInventory();
    claims = new FakeClaims();
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
  };
  // Reuse the repository's warm-up seam; every assertion is rerun in the measured test.
  const warmTest = warmedTests(reset);
  afterAll(async () => {
    await closeDatabase?.();
  });

  function make(limit = 1, source = registry, owner = OWNER) {
    const budget = new RegistryBindingResourceBudget({
      registry: async () => source,
      policy: { limit: () => limit },
      inventory,
      timer,
    });
    const reconciler = makeWithBudget(budget, source, owner);
    return reconciler;
  }
  function makeWithBudget(
    resourceBudget?: BindingResourceBudget,
    source = registry,
    owner = OWNER,
  ) {
    return new BindingReconciler({
      registry: source,
      inventory,
      claims,
      matcher: new FakeMatcher(),
      resolver: new DefaultManagedSpecResolver(),
      provisioner,
      deleter,
      timer,
      resourceBudget,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => false,
      journal: { owner, isOwnerLive: () => false },
    });
  }
  async function request(namespace = "new"): Promise<BindingReconcileRequest> {
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: namespace,
      runnerIncarnation: "inc",
    });
    if (scope.kind !== "ready") {
      throw new Error(scope.kind);
    }
    return {
      key: { scopeKey: scope.scope.scopeKey, bindingIndex: 0 },
      role: "primary",
      platform: "android",
      requestedSpec: SPEC,
      deadlineMs: timer.now() + 60_000,
    };
  }
  async function usage() {
    return computeBindingResourceUsage(await registry.snapshotBindingResources());
  }

  test("two daemon registries at N-1 admit exactly one concurrent creation", async () => {
    await assignBindingDevice(registry, "android", "occupied", "occupied");
    const second = new SqliteBindingRegistry(db, { timer, isExecOwnerLive: () => false });
    const reqs = await Promise.all([request("first"), request("second")]);
    const results = await Promise.all([
      make(2).reconcile(reqs[0]),
      make(2, second, { daemonId: "two", pid: 102, processGenerationToken: "two" }).reconcile(
        reqs[1],
      ),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["failed", "ready"]);
    const refused = results.find((result) => result.outcome === "failed");
    expect(refused).toMatchObject({
      failure: { code: "binding_budget_exhausted", retryable: true },
    });
    expect(provisioner.calls.filter((call) => call.mode === "create")).toHaveLength(1);
    expect(await registry.listOpenBindingJournal()).toEqual([]);
    expect((await usage()).total).toBe(2);
  });

  warmTest("a hanging ledger inventory read is bounded by the preparation deadline", async () => {
    const req = { ...(await request()), deadlineMs: timer.now() + 5_000 };
    const original = registry.snapshotBindingResources.bind(registry);
    const started = Promise.withResolvers<void>();
    const finishRead = Promise.withResolvers<void>();
    registry.snapshotBindingResources = async () => {
      const snapshot = await original();
      inventory.beforeList = async () => {
        started.resolve();
        await finishRead.promise;
      };
      return snapshot;
    };
    let result: Awaited<ReturnType<BindingReconciler["reconcile"]>> | undefined;
    const pending = make()
      .reconcile(req)
      .then((value) => {
        result = value;
      });
    try {
      await started.promise;
      timer.advanceTime(5_000);
      await flushMicrotasks();
      expect(result).toMatchObject({ outcome: "failed", failure: { code: "timeout" } });
    } finally {
      finishRead.resolve();
      await pending;
    }
    expect(await registry.listOpenBindingJournal(req.key)).toEqual([]);
    expect(provisioner.calls).toEqual([]);
    await flushMicrotasks();
  });

  warmTest("admission does not read again after a ledger read consumes its deadline", async () => {
    const req = { ...(await request()), deadlineMs: timer.now() + 5_000 };
    const original = registry.snapshotBindingResources.bind(registry);
    let reads = 0;
    registry.snapshotBindingResources = async () => {
      reads += 1;
      const snapshot = await original();
      timer.advanceTime(5_000);
      inventory.beforeList = async () => {
        throw new Error("inventory read after deadline");
      };
      return snapshot;
    };
    expect(await make().reconcile(req)).toMatchObject({
      outcome: "failed",
      failure: { code: "timeout" },
    });
    expect(reads).toBe(1);
    expect(provisioner.calls).toEqual([]);
    expect(await registry.listOpenBindingJournal(req.key)).toEqual([]);
  });

  warmTest("an admitted request whose deadline passed never provisions", async () => {
    const req = { ...(await request()), deadlineMs: timer.now() + 5_000 };
    const reconciler = makeWithBudget({
      admitCreation: async (input) => {
        expect(input.deadlineMs).toBe(req.deadlineMs);
        timer.advanceTime(5_000);
        return { kind: "admitted", enforced: false };
      },
    });
    expect(await reconciler.reconcile(req)).toMatchObject({
      outcome: "failed",
      failure: { code: "timeout" },
    });
    expect(provisioner.calls).toEqual([]);
    expect(await registry.listOpenBindingJournal(req.key)).toEqual([]);
  });

  warmTest.each(["exhausted", "cancelled"] as const)(
    "a failed create-entry close preserves the original %s admission failure",
    async (kind) => {
      const controller = new AbortController();
      const req = { ...(await request()), signal: controller.signal };
      const original = registry.advanceBindingJournal.bind(registry);
      let failed = false;
      registry.advanceBindingJournal = async (id, input) => {
        if (input.phase === "rolled_back" && !failed) {
          failed = true;
          throw new Error("registry busy");
        }
        return original(id, input);
      };
      const reconciler = makeWithBudget({
        admitCreation: async () => {
          if (kind === "cancelled") {
            controller.abort(new Error("original cancellation"));
            throw controller.signal.reason;
          }
          return {
            kind: "exhausted",
            limit: 1,
            usage: {
              total: 2,
              active: 0,
              assignedIdle: 1,
              cached: 0,
              preparing: 1,
              deleting: 0,
              orphaned: 0,
            },
            retained: [],
            evictionFailures: [],
          };
        },
      });
      if (kind === "cancelled") {
        await expect(reconciler.reconcile(req)).rejects.toThrow("original cancellation");
      } else {
        expect(await reconciler.reconcile(req)).toMatchObject({
          outcome: "failed",
          failure: { code: "binding_budget_exhausted" },
        });
      }
      expect(failed).toBe(true);
      expect(await registry.listOpenBindingJournal(req.key)).toHaveLength(1);
      expect(provisioner.calls).toEqual([]);
      expect((await reconciler.journal.runPass()).settled).toMatchObject([
        { phase: "rolled_back" },
      ]);
      expect(await registry.listOpenBindingJournal(req.key)).toEqual([]);
    },
  );

  test.each(["orphan"] as const)(
    "compatible %s adoption is charge-neutral at the limit",
    async (source) => {
      const req = await request();

      inventory.devices.push({
        platform: "android",
        deviceId: "orphan",
        name: bindingDeviceName(req.key, 1, "abcd"),
        ...SPEC,
      });
      const result = await make().reconcile(req);
      expect(result).toMatchObject({ outcome: "ready", disposition: "adopted" });
      expect(provisioner.calls.map((call) => call.mode)).toEqual(["adopt"]);
      expect(deleter.calls).toEqual([]);
      expect((await usage()).total).toBe(1);
    },
  );

  test("an unrelated orphan fills the budget and cannot be evicted", async () => {
    inventory.devices.push({ platform: "android", deviceId: "amslot-other", name: "amslot-other" });
    const result = await make().reconcile(await request());
    expect(result).toMatchObject({
      outcome: "failed",
      failure: {
        code: "binding_budget_exhausted",
        budget: { usage: { orphaned: 1, preparing: 1 } },
      },
    });
    expect(provisioner.calls).toEqual([]);
    expect(deleter.calls).toEqual([]);
  });

  test("a vanished binding is superseded by its create reservation, charged once", async () => {
    const key = await assignBindingDevice(registry, "android", "vanished", "old");
    const req = { ...(await request()), key };
    const observed: number[] = [];
    const original = registry.snapshotBindingResources.bind(registry);
    registry.snapshotBindingResources = async () => {
      const snapshot = await original();
      observed.push(computeBindingResourceUsage(snapshot).total);
      return snapshot;
    };
    expect((await make().reconcile(req)).outcome).toBe("ready");
    expect(observed).toEqual([1]);
    expect((await usage()).total).toBe(1);
  });

  test("a replacement at the limit never asks admission", async () => {
    const key = await assignBindingDevice(registry, "android", "amslot-old", "old");
    inventory.devices.push({
      platform: "android",
      deviceId: "amslot-old",
      name: "amslot-old",
      runtime: "old",
      deviceType: SPEC.deviceType,
    });
    let calls = 0;
    const reconciler = makeWithBudget({
      admitCreation: async () => {
        calls += 1;
        throw new Error("must not ask");
      },
    });
    expect(await reconciler.reconcile({ ...(await request()), key })).toMatchObject({
      outcome: "ready",
      disposition: "replaced",
    });
    expect(calls).toBe(0);
    expect(deleter.stableIds()).toEqual(["amslot-old"]);
    expect((await usage()).total).toBe(1);
  });

  test("unknown cross-platform inventory closes the refused creation without native work", async () => {
    inventory.beforeList = async (platform) => {
      inventory.complete = platform !== "ios";
    };
    const req = await request();
    const result = await make().reconcile(req);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "discovery_incomplete", retryable: true },
    });
    expect(await registry.listOpenBindingJournal(req.key)).toEqual([]);
    expect(provisioner.calls).toEqual([]);
    expect(deleter.calls).toEqual([]);
  });

  test("admission cancellation closes its create entry", async () => {
    const controller = new AbortController();
    const req = { ...(await request()), signal: controller.signal };
    const reconciler = makeWithBudget({
      admitCreation: async () => {
        controller.abort(new Error("cancel"));
        throw controller.signal.reason;
      },
    });
    await expect(reconciler.reconcile(req)).rejects.toThrow("cancel");
    expect(await registry.listOpenBindingJournal(req.key)).toEqual([]);
    expect(provisioner.calls).toEqual([]);
  });

  test("a fresh confirming read avoids eviction and refusal after an over-count", async () => {
    const mine = await request();
    await registry.initBinding(mine.key, {
      role: "primary",
      platform: "android",
      requestedSpec: SPEC,
    });
    const opened = await registry.openBindingJournal(mine.key, {
      kind: "create",
      phase: "creating",
      owner: OWNER,
      target: {
        oldStableId: null,
        oldName: null,
        newName: "amslot-new",
        newStableId: null,
        requestedSpec: SPEC,
        resolvedSpec: SPEC,
        specFingerprint: "fp",
      },
      assignment: {
        kind: "state",
        expected: { generation: 0, stableDeviceId: null },
        state: "provisioning",
      },
    });
    if (opened.kind !== "opened") {
      throw new Error(opened.kind);
    }
    const real = registry.snapshotBindingResources.bind(registry);
    let reads = 0;
    registry.snapshotBindingResources = async () => {
      const snapshot = await real();
      if (++reads === 1) {
        snapshot.openJournal.push({
          ...opened.entry,
          id: 0,
          scopeKey: "expired",
          target: { ...opened.entry.target, newName: "amslot-expired" },
        });
      }
      return snapshot;
    };
    const budget = new RegistryBindingResourceBudget({
      registry: async () => registry,
      policy: { limit: () => 1 },
      inventory,
      timer,
    });
    expect(await budget.admitCreation({ journalEntryId: opened.entry.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 1 },
      evicted: [],
    });
    expect(reads).toBe(2);
    expect(deleter.calls).toEqual([]);
  });
});

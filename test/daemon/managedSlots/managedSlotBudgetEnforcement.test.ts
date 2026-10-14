import { afterAll, describe, expect, test } from "bun:test";
import { warmedTests } from "../../helpers/warmedTests";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import { migrateSlotRegistry } from "../../../src/daemon/managedSlots/slotRegistryMigrations";
import {
  SqliteSlotRegistry,
  type SlotRegistryDatabase,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import {
  DefaultManagedSlotEvictionSelector,
  JournaledManagedSlotCacheEvictor,
} from "../../../src/daemon/managedSlots/managedSlotCacheEviction";
import {
  RegistryManagedSlotResourceBudget,
  computeManagedSlotResourceUsage,
  type ManagedSlotResourceBudget,
} from "../../../src/daemon/managedSlots/managedSlotResourceBudget";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  managedSlotDeviceName,
  type ManagedSlotReconcileRequest,
} from "../../../src/daemon/managedSlots/reconciler";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { flushMicrotasks } from "../../helpers/shutdownStageHarness";
import {
  FakeInventory,
  FakeClaims,
  FakeMatcher,
  FakeProvisioner,
  FakeDeleter,
} from "./fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "./managedSlotFixtures";
import type { SlotKey, SlotJournalEntry } from "../../../src/daemon/managedSlots/slotRegistry";

const SPEC = { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" };
const OWNER = { daemonId: "one", pid: 101, processGenerationToken: "one" };

// Both daemon registries share one in-memory connection: independent file connections would
// require a file-backed database, unnecessary to prove reservation ordering and forbidden temp I/O.
describe("managed-slot total-resource enforcement on SQLite", () => {
  let db: Kysely<SlotRegistryDatabase>;
  let registry: SqliteSlotRegistry;
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
    db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });
    closeDatabase = () => db.destroy();
    await migrateSlotRegistry(db, ":memory:");
    registry = new SqliteSlotRegistry(db, { timer, isExecOwnerLive: () => false });
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
    const budget = new RegistryManagedSlotResourceBudget({
      registry: async () => source,
      policy: { limit: () => limit },
      inventory,
      timer,
      eviction: {
        selector: new DefaultManagedSlotEvictionSelector({ inventory, claims, timer }),
        evictor: new JournaledManagedSlotCacheEvictor(source, () => reconciler.journal),
      },
    });
    const reconciler = makeWithBudget(budget, source, owner);
    return reconciler;
  }
  function makeWithBudget(
    resourceBudget?: ManagedSlotResourceBudget,
    source = registry,
    owner = OWNER,
  ) {
    return new ManagedSlotReconciler({
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
  async function request(namespace = "new"): Promise<ManagedSlotReconcileRequest> {
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: namespace,
      runnerIncarnation: "inc",
    });
    if (scope.kind !== "ready") {
      throw new Error(scope.kind);
    }
    return {
      key: { scopeKey: scope.scope.scopeKey, slotIndex: 0 },
      role: "primary",
      platform: "android",
      requestedSpec: SPEC,
      deadlineMs: timer.now() + 60_000,
    };
  }
  async function cache(id: string, compatible = false) {
    const key = await assignManagedSlotDevice(registry, "android", id, id);
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
    inventory.devices.push({
      platform: "android",
      deviceId: id,
      name: id,
      ...(compatible ? SPEC : {}),
    });
    return (await registry.listFreeDevices()).find((row) => row.stableDeviceId === id)!;
  }
  async function usage() {
    return computeManagedSlotResourceUsage(await registry.snapshotManagedSlotResources());
  }

  warmTest("failed journaled cache deletion preserves the next cache", async () => {
    await assignManagedSlotDevice(registry, "android", "active", "active", "exec");
    await cache("amslot-first");
    timer.advanceTime(1);
    await cache("amslot-second");
    const second = (await registry.listFreeDevices()).find(
      (row) => row.stableDeviceId === "amslot-second",
    );
    deleter.beforeDelete = async (target) => {
      deleter.failWith = target.stableId === "amslot-first" ? "native delete failed" : undefined;
    };
    const result = await make(2).reconcile(await request());
    expect(deleter.stableIds()).toEqual(["amslot-first"]);
    expect(inventory.has("amslot-second")).toBe(true);
    expect(
      (await registry.listFreeDevices()).find((row) => row.stableDeviceId === "amslot-second"),
    ).toEqual(second);
    expect(
      (await registry.listFreeDevices()).find((row) => row.stableDeviceId === "amslot-first"),
    ).toMatchObject({ deletion: { failedDeletes: 1 } });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: {
        code: "managed_slot_budget_exhausted",
        budget: {
          limit: 2,
          usage: { total: 4 },
          retained: [
            { stableDeviceId: "amslot-first", reason: "deletion_pending", failedDeletes: 1 },
          ],
          evictionFailures: [{ stableDeviceId: "amslot-first" }],
        },
      },
    });
    expect(provisioner.calls).toEqual([]);
  });

  for (const markerCount of [1, 2]) {
    warmTest(
      `stuck markers preserve cache unless creation can fit (markers=${markerCount})`,
      async () => {
        for (let index = 0; index < markerCount; index += 1) {
          const row = await cache(`amslot-stuck-${index}`);
          await registry.beginFreeDeviceDeletion(row, OWNER);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            await registry.recordFreeDeviceDeletionAttempt(row, OWNER, {
              error: "native delete failed",
              nativeDeleteFailed: true,
              nextAttemptAtMs: timer.now() + 60_000,
            });
          }
          timer.advanceTime(1);
        }
        await cache("amslot-cache");
        const nativeCounts: number[] = [];
        provisioner.beforeCreate = async () => {
          nativeCounts.push(inventory.devices.length + 1);
        };
        const result = await make(1).reconcile(await request());
        if (markerCount === 1) {
          expect(result.outcome).toBe("ready");
          expect(deleter.stableIds()).toEqual(["amslot-cache"]);
          expect(inventory.has("amslot-cache")).toBe(false);
          expect(nativeCounts).toEqual([2]);
          expect((await usage()).total).toBe(1);
        } else {
          expect(result).toMatchObject({
            outcome: "failed",
            failure: {
              code: "managed_slot_budget_exhausted",
              budget: {
                retained: [
                  { stableDeviceId: "amslot-stuck-0", reason: "deletion_stuck", uncounted: true },
                  { stableDeviceId: "amslot-stuck-1", reason: "deletion_stuck" },
                ],
              },
            },
          });
          expect(deleter.calls).toEqual([]);
          expect(inventory.has("amslot-cache")).toBe(true);
          expect(
            (await registry.listFreeDevices()).find((row) => row.stableDeviceId === "amslot-cache"),
          ).toMatchObject({ deletion: null });
        }
        expect(
          (await registry.listOpenSlotJournal()).filter(
            (entry) => entry.target.oldStableId === "amslot-cache",
          ),
        ).toEqual([]);
      },
    );
  }

  warmTest(
    "at the limit journaled LRU deletion retains newer cache and admits creation",
    async () => {
      await cache("amslot-old");
      timer.advanceTime(1);
      await cache("amslot-newer");
      const reads: number[] = [];
      const original = registry.snapshotManagedSlotResources.bind(registry);
      registry.snapshotManagedSlotResources = async () => {
        const snapshot = await original();
        reads.push(computeManagedSlotResourceUsage(snapshot).total);
        return snapshot;
      };
      const result = await make(2).reconcile(await request());
      expect(result.outcome).toBe("ready");
      expect(deleter.stableIds()).toEqual(["amslot-old"]);
      expect((await registry.listFreeDevices()).map((row) => row.stableDeviceId)).toEqual([
        "amslot-newer",
      ]);
      // The opened intent is charged before admission (3); native resources stay <= 2.
      expect(reads).toEqual([3, 3, 2]);
      expect(inventory.devices).toHaveLength(2);
      expect((await usage()).total).toBe(2);
    },
  );

  test("no eligible cache produces typed evidence, closes intent and preserves the binding", async () => {
    await cache("amslot-held");
    claims.sessions.set("amslot-held", ["session"]);
    const req = await request();
    await registry.initSlot(req.key, {
      role: req.role,
      platform: req.platform,
      requestedSpec: SPEC,
    });
    const before = await registry.getAssignment(req.key);
    const result = await make().reconcile(req);
    expect(result).toMatchObject({
      outcome: "failed",
      failure: {
        code: "managed_slot_budget_exhausted",
        retryable: true,
        budget: {
          limit: 1,
          usage: { total: 2, cached: 1, preparing: 1, orphaned: 0 },
          retained: [{ stableDeviceId: "amslot-held", reason: "session_holds_device" }],
        },
      },
    });
    if (result.outcome === "failed") {
      expect(result.failure).not.toHaveProperty("retryAfterMs");
    }
    expect(provisioner.calls).toEqual([]);
    expect(deleter.calls).toEqual([]);
    expect(await registry.listOpenSlotJournal(req.key)).toEqual([]);
    expect(await registry.getAssignment(req.key)).toEqual(before);
  });

  test("two daemon registries at N-1 admit exactly one concurrent creation", async () => {
    await assignManagedSlotDevice(registry, "android", "occupied", "occupied");
    const second = new SqliteSlotRegistry(db, { timer, isExecOwnerLive: () => false });
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
      failure: { code: "managed_slot_budget_exhausted", retryable: true },
    });
    expect(provisioner.calls.filter((call) => call.mode === "create")).toHaveLength(1);
    expect(await registry.listOpenSlotJournal()).toEqual([]);
    expect((await usage()).total).toBe(2);
  });

  test("failed eviction stays deleting, cannot be adopted, and redrives after backoff", async () => {
    const row = await cache("amslot-cache");
    deleter.failWith = "native deletion failed";
    const reconciler = make();
    const result = await reconciler.reconcile(await request());
    expect(result).toMatchObject({
      outcome: "failed",
      failure: {
        code: "managed_slot_budget_exhausted",
        budget: {
          usage: { deleting: 1, cached: 0 },
          evictionFailures: [
            { stableDeviceId: row.stableDeviceId, message: "native deletion failed" },
          ],
        },
      },
    });
    expect(await usage()).toMatchObject({ total: 1, deleting: 1 });
    const adopter = await request("adopter");
    await registry.initSlot(adopter.key, {
      role: "primary",
      platform: "android",
      requestedSpec: SPEC,
    });
    expect(
      await registry.commitBinding(
        adopter.key,
        { generation: 0, stableDeviceId: null },
        {
          stableDeviceId: row.stableDeviceId,
          deviceName: row.stableDeviceId,
          resolvedSpec: SPEC,
          specFingerprint: "fp",
          state: "ready",
        },
      ),
    ).toEqual({ kind: "free_device_stopping" });
    expect((await reconciler.journal.runPass()).freeDeviceDeletions).toEqual([]);
    timer.advanceTime(1_000);
    deleter.failWith = undefined;
    expect((await reconciler.journal.runPass()).freeDeviceDeletions).toMatchObject([
      { outcome: "absent" },
    ]);
    expect(await registry.listFreeDevices()).toEqual([]);
    expect((await reconciler.reconcile(await request("retry"))).outcome).toBe("ready");
    expect(deleter.stableIds()).toEqual(["amslot-cache", "amslot-cache"]);
  });

  warmTest("a failed oldest deletion refuses creation without evicting newer cache", async () => {
    await cache("amslot-old");
    timer.advanceTime(1);
    await cache("amslot-newer");
    const originalDelete = deleter.deleteAndVerifyAbsence.bind(deleter);
    deleter.deleteAndVerifyAbsence = async (target) => {
      if (deleter.calls.length === 0) {
        deleter.calls.push(target);
        return { kind: "failed", message: "native deletion failed" };
      }
      return originalDelete(target);
    };
    const reconciler = make(2);
    expect(await reconciler.reconcile(await request())).toMatchObject({
      outcome: "failed",
      failure: {
        code: "managed_slot_budget_exhausted",
        budget: { retained: [{ stableDeviceId: "amslot-old", reason: "deletion_pending" }] },
      },
    });
    expect(deleter.stableIds()).toEqual(["amslot-old"]);
    expect(
      (await registry.listFreeDevices()).find((row) => row.stableDeviceId === "amslot-newer")
        ?.deletion,
    ).toBeNull();
    expect(provisioner.calls).toEqual([]);
    timer.advanceTime(1_000);
    expect((await reconciler.journal.runPass()).freeDeviceDeletions).toMatchObject([
      { outcome: "absent" },
    ]);
    expect((await reconciler.reconcile(await request("retry"))).outcome).toBe("ready");
    expect((await registry.listFreeDevices()).map((row) => row.stableDeviceId)).toEqual([
      "amslot-newer",
    ]);
    expect(deleter.stableIds()).toEqual(["amslot-old", "amslot-old"]);
  });

  warmTest("a shortfall of two with one pending deletion preserves every cache", async () => {
    const pending = await cache("amslot-pending");
    await registry.beginFreeDeviceDeletion(pending, OWNER);
    timer.advanceTime(1);
    await cache("amslot-next");
    timer.advanceTime(1);
    await cache("amslot-newer");
    const result = await make(2).reconcile(await request());
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "managed_slot_budget_exhausted" },
    });
    expect(deleter.stableIds()).toEqual([]);
    expect((await registry.listFreeDevices()).map((row) => row.stableDeviceId)).toEqual([
      "amslot-pending",
      "amslot-next",
      "amslot-newer",
    ]);
    expect(provisioner.calls).toEqual([]);
  });

  warmTest("a hanging cache delete settles at the preparation deadline with timeout", async () => {
    await cache("amslot-cache");
    const started = Promise.withResolvers<void>();
    const finishDelete = Promise.withResolvers<void>();
    deleter.beforeDelete = async () => {
      started.resolve();
      return finishDelete.promise;
    };
    const req = { ...(await request()), deadlineMs: timer.now() + 5_000 };
    const reconciler = make();
    let result: Awaited<ReturnType<ManagedSlotReconciler["reconcile"]>> | undefined;
    const pending = reconciler.reconcile(req).then((value) => {
      result = value;
    });
    try {
      await started.promise;
      expect(deleter.calls).toHaveLength(1);
      timer.advanceTime(4_999);
      await flushMicrotasks();
      expect(result).toBeUndefined();
      timer.advanceTime(1);
      await flushMicrotasks();
      expect(result).toMatchObject({ outcome: "failed", failure: { code: "timeout" } });
    } finally {
      if (result === undefined) {
        finishDelete.resolve();
      }
      await pending;
    }
    await pending;
    expect(await registry.listOpenSlotJournal(req.key)).toEqual([]);
    expect(await registry.listFreeDeviceDeletions()).toHaveLength(1);
    expect(provisioner.calls).toEqual([]);
    // The timed-out deletion is never reverted; periodic redrive completes it.
    deleter.beforeDelete = undefined;
    timer.advanceTime(1_000);
    expect((await reconciler.journal.runPass()).freeDeviceDeletions).toMatchObject([
      { outcome: "absent" },
    ]);
    finishDelete.resolve();
  });

  warmTest("a hanging ledger inventory read is bounded by the preparation deadline", async () => {
    const req = { ...(await request()), deadlineMs: timer.now() + 5_000 };
    const original = registry.snapshotManagedSlotResources.bind(registry);
    const started = Promise.withResolvers<void>();
    const finishRead = Promise.withResolvers<void>();
    registry.snapshotManagedSlotResources = async () => {
      const snapshot = await original();
      inventory.beforeList = async () => {
        started.resolve();
        await finishRead.promise;
      };
      return snapshot;
    };
    let result: Awaited<ReturnType<ManagedSlotReconciler["reconcile"]>> | undefined;
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
    expect(await registry.listOpenSlotJournal(req.key)).toEqual([]);
    expect(provisioner.calls).toEqual([]);
    await flushMicrotasks();
  });

  warmTest("admission does not read again after a ledger read consumes its deadline", async () => {
    const req = { ...(await request()), deadlineMs: timer.now() + 5_000 };
    const original = registry.snapshotManagedSlotResources.bind(registry);
    let reads = 0;
    registry.snapshotManagedSlotResources = async () => {
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
    expect(await registry.listOpenSlotJournal(req.key)).toEqual([]);
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
    expect(await registry.listOpenSlotJournal(req.key)).toEqual([]);
  });

  warmTest(
    "a post-marker transient busy refusal keeps its delete committed for redrive",
    async () => {
      await cache("amslot-cache");
      let checks = 0;
      claims.beforeDescribe = async () => {
        if (++checks === 2) {
          claims.claims.set("amslot-cache", { kind: "unknown", reason: "transient" });
        }
      };
      const reconciler = make();
      expect(await reconciler.reconcile(await request())).toMatchObject({
        outcome: "failed",
        failure: { code: "managed_slot_budget_exhausted" },
      });
      expect(deleter.calls).toEqual([]);
      expect(await registry.listFreeDeviceDeletions()).toHaveLength(1);
      timer.advanceTime(1_000);
      claims.claims.clear();
      expect((await reconciler.journal.runPass()).freeDeviceDeletions).toMatchObject([
        { outcome: "absent" },
      ]);
      expect(deleter.stableIds()).toEqual(["amslot-cache"]);
    },
  );

  warmTest.each(["exhausted", "cancelled"] as const)(
    "a failed create-entry close preserves the original %s admission failure",
    async (kind) => {
      const controller = new AbortController();
      const req = { ...(await request()), signal: controller.signal };
      const original = registry.advanceSlotJournal.bind(registry);
      let failed = false;
      registry.advanceSlotJournal = async (id, input) => {
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
          failure: { code: "managed_slot_budget_exhausted" },
        });
      }
      expect(failed).toBe(true);
      expect(await registry.listOpenSlotJournal(req.key)).toHaveLength(1);
      expect(provisioner.calls).toEqual([]);
      expect((await reconciler.journal.runPass()).settled).toMatchObject([
        { phase: "rolled_back" },
      ]);
      expect(await registry.listOpenSlotJournal(req.key)).toEqual([]);
    },
  );

  warmTest.each([
    ["bound", "claim"],
    ["owner_changed", "claim"],
    ["gone", "claim"],
    ["bound", "absence"],
    ["owner_changed", "absence"],
    ["gone", "absence"],
  ] as const)(
    "the final deletion recheck protects a row that became %s during %s discovery",
    async (change, stage) => {
      const row = await cache("amslot-cache");
      const begun = await registry.beginFreeDeviceDeletion(row, OWNER);
      if (begun.kind !== "begun") {
        throw new Error(begun.reason);
      }
      const req = await request("older-build");
      await registry.initSlot(req.key, {
        role: "primary",
        platform: "android",
        requestedSpec: SPEC,
      });
      const changeRow = async () => {
        if (change === "bound") {
          // An older build ignores the deletion marker when publishing its assignment.
          await db
            .updateTable("slot_assignments")
            .set({ stable_device_id: row.stableDeviceId, device_name: row.stableDeviceId })
            .where("scope_key", "=", req.key.scopeKey)
            .execute();
        } else if (change === "owner_changed") {
          await registry.claimFreeDeviceDeletion(row, OWNER, { daemonId: "other", pid: 202 });
        } else {
          await registry.completeFreeDeviceDeletion(row, OWNER);
        }
      };
      if (stage === "claim") {
        claims.beforeDescribe = changeRow;
      } else {
        inventory.remove(row.stableDeviceId);
        inventory.beforeList = changeRow;
      }
      expect(await make().journal.driveFreeDeviceDeletion(begun.row)).toMatchObject(
        change === "bound" ? { kind: "blocked", message: "assigned" } : { kind: "lost" },
      );
      expect(deleter.calls).toEqual([]);
      if (change === "bound") {
        expect((await registry.listFreeDeviceDeletions())[0].deletion?.attempts).toBe(1);
      }
    },
  );

  test.each(["cache", "orphan"] as const)(
    "compatible %s adoption is charge-neutral at the limit",
    async (source) => {
      const req = await request();
      if (source === "cache") {
        await cache("amslot-cache", true);
      } else {
        inventory.devices.push({
          platform: "android",
          deviceId: "orphan",
          name: managedSlotDeviceName(req.key, 1, "abcd"),
          ...SPEC,
        });
      }
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
        code: "managed_slot_budget_exhausted",
        budget: { usage: { orphaned: 1, preparing: 1 } },
      },
    });
    expect(provisioner.calls).toEqual([]);
    expect(deleter.calls).toEqual([]);
  });

  test("a vanished binding is superseded by its create reservation, charged once", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "vanished", "old");
    const req = { ...(await request()), key };
    const observed: number[] = [];
    const original = registry.snapshotManagedSlotResources.bind(registry);
    registry.snapshotManagedSlotResources = async () => {
      const snapshot = await original();
      observed.push(computeManagedSlotResourceUsage(snapshot).total);
      return snapshot;
    };
    expect((await make().reconcile(req)).outcome).toBe("ready");
    expect(observed).toEqual([1]);
    expect((await usage()).total).toBe(1);
  });

  test("a replacement at the limit never asks admission", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "amslot-old", "old");
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
    expect(await registry.listOpenSlotJournal(req.key)).toEqual([]);
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
    expect(await registry.listOpenSlotJournal(req.key)).toEqual([]);
    expect(provisioner.calls).toEqual([]);
  });

  test("a fresh confirming read avoids eviction and refusal after an over-count", async () => {
    const mine = await request();
    await registry.initSlot(mine.key, {
      role: "primary",
      platform: "android",
      requestedSpec: SPEC,
    });
    const opened = await registry.openSlotJournal(mine.key, {
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
    const real = registry.snapshotManagedSlotResources.bind(registry);
    let reads = 0;
    registry.snapshotManagedSlotResources = async () => {
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
    const evictor = new JournaledManagedSlotCacheEvictor(registry, () => make().journal);
    const budget = new RegistryManagedSlotResourceBudget({
      registry: async () => registry,
      policy: { limit: () => 1 },
      inventory,
      timer,
      eviction: {
        selector: new DefaultManagedSlotEvictionSelector({ inventory, claims, timer }),
        evictor,
      },
    });
    expect(await budget.admitCreation({ journalEntryId: opened.entry.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 1 },
      evicted: [],
    });
    expect(reads).toBe(2);
    expect(deleter.calls).toEqual([]);
  });

  test("an abandoned deleted entry releases its charge while a genuine replacement retains it", async () => {
    async function deleted(namespace: string, abandoned: boolean): Promise<SlotJournalEntry> {
      const key: SlotKey = await assignManagedSlotDevice(registry, "android", namespace, namespace);
      if (abandoned) {
        await registry.markScopeAbandoned(key.scopeKey, { thresholdMs: 0 });
      }
      const opened = await registry.openSlotJournal(key, {
        kind: "replace",
        phase: "deleting",
        owner: OWNER,
        requireAbandonedScope: abandoned,
        target: {
          oldStableId: namespace,
          oldName: namespace,
          newStableId: null,
          newName: null,
          requestedSpec: SPEC,
          resolvedSpec: SPEC,
          specFingerprint: "fp",
        },
        assignment: {
          kind: "state",
          expected: { generation: 1, stableDeviceId: namespace },
          state: "replacing",
        },
      });
      if (opened.kind !== "opened") {
        throw new Error(opened.kind);
      }
      const advanced = await registry.advanceSlotJournal(opened.entry.id, {
        owner: OWNER,
        expectedPhase: "deleting",
        phase: "deleted",
        assignment: {
          kind: "commit",
          expected: opened.entry.binding,
          next: {
            stableDeviceId: null,
            deviceName: null,
            resolvedSpec: null,
            specFingerprint: null,
            state: "provisioning",
          },
        },
      });
      if (advanced.kind !== "advanced") {
        throw new Error(advanced.kind);
      }
      return advanced.entry;
    }
    await deleted("abandoned", true);
    await deleted("replacement", false);
    expect(await usage()).toMatchObject({ total: 1, preparing: 1 });
  });
});

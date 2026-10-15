import { warmedTests } from "../../../helpers/warmedTests";
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { BindingJournal } from "../../../../src/daemon/sessionBroker/registry/bindingJournal";
import {
  isStuckFreeDeviceDeletion,
  DefaultBindingEvictionSelector,
  JournaledBindingCacheEvictor,
} from "../../../../src/daemon/sessionBroker/provisioning/cacheEviction";
import {
  openSqliteBindingRegistry,
  type SqliteBindingRegistry,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { freeDeviceBusyReason } from "../../../../src/daemon/sessionBroker/provisioning/freeDeviceBusyReason";
import { computeBindingResourceUsage } from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import type {
  FreeBindingDeviceRecord,
  BindingKey,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeInventory,
  FakeClaims,
  FakeMatcher,
  FakeDeleter,
} from "../registry/fixtures/reconcilerFakes";
import { assignBindingDevice } from "./bindingFixtures";
import { flushMicrotasks } from "../../../helpers/shutdownStageHarness";

const OWNER = { daemonId: "one", pid: 101, processGenerationToken: "one" };
const OTHER = { daemonId: "two", pid: 102, processGenerationToken: "two" };

describe("journaled free-pool deletion", () => {
  let registry: SqliteBindingRegistry;
  let timer: FakeTimer;
  let inventory: FakeInventory;
  let claims: FakeClaims;
  let deleter: FakeDeleter;
  let liveOwners: Set<number>;

  const reset = async () => {
    await registry?.close();
    timer = new FakeTimer();
    registry = await openSqliteBindingRegistry({
      dbPath: ":memory:",
      timer,
      isExecOwnerLive: () => false,
    });
    inventory = new FakeInventory();
    claims = new FakeClaims();
    deleter = new FakeDeleter(inventory);
    liveOwners = new Set();
  };
  const warmTest = warmedTests(reset);
  afterAll(async () => {
    await registry.close();
  });

  function journal(owner = OWNER, busy?: () => string | undefined, backoff?: number) {
    return new BindingJournal({
      registry,
      inventory,
      claims,
      matcher: new FakeMatcher(),
      deleter,
      timer,
      owner,
      isOwnerLive: (who) => liveOwners.has(who.pid),
      isBusy: busy,
      backoff,
      stageBudgets: { discoveryMs: 10, claimMs: 10, deleteGraceMs: 5 },
    });
  }
  async function cache(id = "amslot-cache") {
    const key = await assignBindingDevice(registry, "android", id, id);
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
    inventory.devices.push({ platform: "android", deviceId: id, name: id });
    return (await registry.listFreeDevices()).find((row) => row.stableDeviceId === id)!;
  }
  async function marked(id = "amslot-cache", owner = OWNER) {
    const row = await cache(id);
    const result = await registry.beginFreeDeviceDeletion(row, owner);
    if (result.kind !== "begun") {
      throw new Error(result.reason);
    }
    return result.row;
  }
  function candidate(row: FreeBindingDeviceRecord) {
    return { ...row, name: row.stableDeviceId, lastUsedAtMs: row.freedAtMs };
  }

  warmTest("a dead deletion owner is taken over on restart and driven to absence", async () => {
    await marked("amslot-cache", OTHER);
    const pass = await journal().runPass();
    expect(pass.freeDeviceDeletions).toEqual([
      { platform: "android", stableDeviceId: "amslot-cache", outcome: "absent" },
    ]);
    expect(deleter.stableIds()).toEqual(["amslot-cache"]);
    expect(await registry.listFreeDevices()).toEqual([]);
  });

  test("a live foreign owner and an in-process drive are left alone", async () => {
    const row = await marked("amslot-cache", OTHER);
    liveOwners.add(OTHER.pid);
    const driver = journal();
    expect((await driver.runPass()).freeDeviceDeletions).toEqual([]);
    await registry.claimFreeDeviceDeletion(row, OTHER, OWNER);
    let finishDiscovery: () => void = () => {};
    inventory.beforeList = async () =>
      new Promise<void>((resolve) => {
        finishDiscovery = resolve;
      });
    const pending = driver.driveFreeDeviceDeletion({
      ...row,
      deletion: { ...row.deletion!, owner: OWNER },
    });
    await flushMicrotasks();
    expect((await driver.runPass()).freeDeviceDeletions).toEqual([]);
    expect(deleter.calls).toEqual([]);
    expect(await registry.listFreeDeviceDeletions()).toHaveLength(1);
    inventory.beforeList = undefined;
    finishDiscovery();
    expect(await pending).toEqual({ kind: "absent" });
  });

  test("a failed row does not starve the next due row", async () => {
    await marked("amslot-first");
    await marked("amslot-second");
    claims.sessions.set("amslot-first", ["held"]);
    const pass = await journal().runPass();
    expect(pass.freeDeviceDeletions.map((row) => row.outcome)).toEqual(["blocked", "absent"]);
    expect(deleter.stableIds()).toEqual(["amslot-second"]);
    expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
      attempts: 1,
      failedDeletes: 0,
      nextAttemptAtMs: 1_000,
    });
  });

  test("selection loses to adoption before deletion CAS", async () => {
    const row = await cache();
    await assignBindingDevice(registry, "android", row.stableDeviceId, "adopter");
    expect(
      await new JournaledBindingCacheEvictor(registry, () => journal()).evict(candidate(row), {}),
    ).toEqual({ kind: "lost" });
    expect(deleter.calls).toEqual([]);
    expect(await registry.findDeviceHolder("android", row.stableDeviceId)).toMatchObject({
      kind: "binding",
    });
  });

  test.each(["session", "foreign", "unknown", "restart", "name", "incomplete"] as const)(
    "%s safety prevents native deletion and records a retry",
    async (reason) => {
      const row = await marked(reason === "name" ? "personal-avd" : "amslot-cache");
      if (reason === "session") {
        claims.sessions.set(row.stableDeviceId, ["session"]);
      }
      if (reason === "foreign") {
        claims.claims.set(row.stableDeviceId, { kind: "held", reason: "foreign daemon" });
      }
      if (reason === "unknown") {
        claims.claims.set(row.stableDeviceId, { kind: "unknown", reason: "unreadable" });
      }
      if (reason === "incomplete") {
        inventory.complete = false;
      }
      const busy =
        reason === "restart"
          ? () =>
              freeDeviceBusyReason(
                {
                  getAllDevices: () => [],
                  isUnderShutdownReservation: () => false,
                  isDeviceLeasedForAndroidStartup: () => false,
                  restartReservationExclusions: () => ({
                    names: new Set([row.stableDeviceId]),
                    ids: new Set<string>(),
                    resumeTargets: [],
                  }),
                },
                inventory.devices[0],
              )
          : undefined;
      expect(await journal(OWNER, busy).driveFreeDeviceDeletion(row)).toMatchObject({
        kind: "blocked",
      });
      expect(deleter.calls).toEqual([]);
      expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
        attempts: 1,
        failedDeletes: 0,
        nextAttemptAtMs: 1_000,
      });
      expect(computeBindingResourceUsage(await registry.snapshotBindingResources())).toMatchObject({
        deleting: 1,
        cached: 0,
      });
    },
  );

  test("complete discovery proving absence clears the marker without native deletion", async () => {
    const row = await marked();
    inventory.remove(row.stableDeviceId);
    expect(await journal().driveFreeDeviceDeletion(row)).toEqual({ kind: "absent" });
    expect(deleter.calls).toEqual([]);
    expect(await registry.listFreeDevices()).toEqual([]);
  });

  test("stopping rows cannot start deletion even with a stale stop claim", async () => {
    const row = await cache();
    await registry.beginFreeDeviceStop({ ...row, claimedBy: "stopper" }, { thresholdMs: 0 });
    timer.advanceTime(1_000_000);
    expect(await registry.beginFreeDeviceDeletion(row, OWNER)).toMatchObject({
      kind: "not_evictable",
    });
    expect(deleter.calls).toEqual([]);
  });

  describe("bound cache protection", () => {
    let row: FreeBindingDeviceRecord;
    let key: BindingKey;
    beforeEach(async () => {
      row = await cache();
      key = await assignBindingDevice(registry, "android", row.stableDeviceId, "adopter");
    });
    test.each(["valid", "abandoned"] as const)(
      "a %s scope's assignment prevents free-pool deletion",
      async (state) => {
        if (state === "abandoned") {
          await registry.markScopeAbandoned(key.scopeKey, { thresholdMs: 0 });
        }
        expect(await registry.beginFreeDeviceDeletion(row, OWNER)).toMatchObject({
          kind: "not_evictable",
        });
        expect(deleter.calls).toEqual([]);
        expect(await registry.getAssignment(key)).toMatchObject({
          stableDeviceId: row.stableDeviceId,
        });
      },
    );
  });

  test.each(["oldStableId", "oldName", "newStableId", "newName"] as const)(
    "an open journal's %s protects a free row",
    async (field) => {
      const row = await cache();
      const scope = await registry.ensureScope({
        managedHostScope: "host",
        runnerNamespace: "journal",
        runnerIncarnation: "inc",
      });
      if (scope.kind !== "ready") {
        throw new Error(scope.kind);
      }
      const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
      await registry.initBinding(key, { role: "primary", platform: "android", requestedSpec: {} });
      await registry.openBindingJournal(key, {
        kind: "create",
        phase: "creating",
        owner: OWNER,
        target: {
          oldStableId: null,
          oldName: null,
          newStableId: null,
          newName: "amslot-other",
          requestedSpec: {},
          resolvedSpec: {},
          specFingerprint: null,
          [field]: row.stableDeviceId,
        },
        assignment: {
          kind: "state",
          expected: { generation: 0, stableDeviceId: null },
          state: "provisioning",
        },
      });
      expect(await registry.beginFreeDeviceDeletion(row, OWNER)).toEqual({
        kind: "not_evictable",
        reason: "journal_open",
      });
      expect(deleter.calls).toEqual([]);
    },
  );

  test.each([false, true])(
    "an iOS name-only journal target fences deletion (marker already begun=%s)",
    async (begunFirst) => {
      const key = await assignBindingDevice(registry, "ios", "UDID-CACHE", "ios-cache");
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(key.scopeKey);
      const row = (await registry.listFreeDevices())[0];
      inventory.devices.push({ platform: "ios", deviceId: row.stableDeviceId, name: "amslot-ios" });
      let markedRow = row;
      if (begunFirst) {
        const result = await registry.beginFreeDeviceDeletion(row, OWNER);
        if (result.kind !== "begun") {
          throw new Error(result.reason);
        }
        markedRow = result.row;
      }
      const scope = await registry.ensureScope({
        managedHostScope: "host",
        runnerNamespace: "ios-journal",
        runnerIncarnation: "inc",
      });
      if (scope.kind !== "ready") {
        throw new Error(scope.kind);
      }
      const journalKey = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
      await registry.initBinding(journalKey, {
        role: "primary",
        platform: "ios",
        requestedSpec: {},
      });
      await registry.openBindingJournal(journalKey, {
        kind: "create",
        phase: "creating",
        owner: OWNER,
        target: {
          oldStableId: null,
          oldName: null,
          newStableId: null,
          newName: "amslot-ios",
          requestedSpec: {},
          resolvedSpec: {},
          specFingerprint: null,
        },
        assignment: {
          kind: "state",
          expected: { generation: 0, stableDeviceId: null },
          state: "provisioning",
        },
      });
      if (begunFirst) {
        expect(await journal().driveFreeDeviceDeletion(markedRow)).toEqual({
          kind: "blocked",
          message: "journal_open",
        });
      } else {
        expect(
          await registry.beginFreeDeviceDeletion({ ...row, name: "amslot-ios" }, OWNER),
        ).toEqual({ kind: "not_evictable", reason: "journal_open" });
        expect(
          await new DefaultBindingEvictionSelector({ inventory, claims }).select(registry, {}),
        ).toMatchObject({ candidates: [], skipped: [{ reason: "journal_open" }] });
      }
      expect(deleter.calls).toEqual([]);
    },
  );

  test("marked rows are excluded by the selector, adoption candidates and stop sweeps", async () => {
    const row = await marked();
    const selection = await new DefaultBindingEvictionSelector({ inventory, claims }).select(
      registry,
      {},
    );
    expect(selection).toEqual({
      candidates: [],
      skipped: [
        {
          platform: "android",
          stableDeviceId: row.stableDeviceId,
          reason: "deletion_pending",
          attempts: 0,
          failedDeletes: 0,
          lastError: null,
        },
      ],
    });
    expect(await registry.findReclaimableFreeDevices({ thresholdMs: 0 })).toEqual([]);
    expect(
      await registry.beginFreeDeviceStop({ ...row, claimedBy: "stopper" }, { thresholdMs: 0 }),
    ).toEqual({ kind: "not_reclaimable" });
    expect(await registry.snapshotManagedDevices()).toMatchObject([
      { stableDeviceId: row.stableDeviceId },
    ]);
  });

  test("discovery timeout backs off and leaves the row charged", async () => {
    const row = await marked();
    inventory.beforeList = async () => new Promise<void>(() => {});
    const pending = journal().driveFreeDeviceDeletion(row);
    await flushMicrotasks();
    timer.advanceTime(10);
    expect(await pending).toEqual({ kind: "blocked", message: "discovery_incomplete" });
    expect((await registry.listFreeDeviceDeletions())[0].deletion?.attempts).toBe(1);
    expect(deleter.calls).toEqual([]);
  });

  test("passed preparation deadlines record attempts without failed native deletes", async () => {
    const row = await marked();
    const driver = journal();
    expect(await driver.driveFreeDeviceDeletion(row, { deadlineMs: timer.now() })).toEqual({
      kind: "failed",
      message: "preparation_deadline_passed",
    });
    const deadlineDriver = journal(OWNER, () => {
      timer.advanceTime(1);
      return undefined;
    });
    expect(
      await deadlineDriver.driveFreeDeviceDeletion(row, { deadlineMs: timer.now() + 1 }),
    ).toEqual({
      kind: "failed",
      message: "preparation_deadline_passed",
    });
    expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
      attempts: 2,
      failedDeletes: 0,
    });
    expect(deleter.calls).toEqual([]);
  });

  test("startup refusals keep reserving room until the workflow is registered", async () => {
    await marked();
    const driver = journal(OWNER, undefined, 100);
    const original = deleter.deleteAndVerifyAbsence.bind(deleter);
    deleter.deleteAndVerifyAbsence = async () => ({
      kind: "failed",
      message: "not registered",
      notAttempted: { reason: "workflow_unavailable" },
    });
    for (let count = 1; count <= 4; count++) {
      await driver.runPass();
      const rows = await registry.listFreeDeviceDeletions();
      expect(rows[0].deletion).toMatchObject({
        attempts: count,
        failedDeletes: 0,
        lastError: "not registered",
      });
      expect(isStuckFreeDeviceDeletion(rows[0].deletion)).toBe(false);
      expect(computeBindingResourceUsage(await registry.snapshotBindingResources())).toMatchObject({
        deleting: 1,
        cached: 0,
      });
      expect(rows[0].deletion!.nextAttemptAtMs).toBeGreaterThan(timer.now());
      timer.setCurrentTime(rows[0].deletion!.nextAttemptAtMs);
    }
    deleter.deleteAndVerifyAbsence = original;
    expect((await driver.runPass()).freeDeviceDeletions).toMatchObject([{ outcome: "absent" }]);
    expect(await registry.listFreeDeviceDeletions()).toEqual([]);
    expect(inventory.has("amslot-cache")).toBe(false);
  });

  test("three native failures become stuck and takeover preserves the counter", async () => {
    const row = await marked();
    const driver = journal();
    deleter.failWith = "native failed";
    for (let count = 1; count <= 3; count += 1) {
      expect(await driver.driveFreeDeviceDeletion(row)).toEqual({
        kind: "failed",
        message: "native failed",
      });
      expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
        attempts: count,
        failedDeletes: count,
      });
    }
    expect(await registry.claimFreeDeviceDeletion(row, OWNER, OTHER)).toBe(true);
    expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
      owner: OTHER,
      failedDeletes: 3,
    });
    expect(
      await new DefaultBindingEvictionSelector({ inventory, claims }).select(registry, {}),
    ).toMatchObject({
      candidates: [],
      skipped: [{ reason: "deletion_stuck", attempts: 3, failedDeletes: 3 }],
    });
    expect(await registry.findReclaimableFreeDevices({ thresholdMs: 0 })).toEqual([]);
  });

  test("the native chokepoint in-flight refusal adds no failed delete", async () => {
    const row = await marked();
    const driver = journal();
    const fence = spyOn(driver.inFlight, "removalBlocked")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    try {
      expect(await driver.driveFreeDeviceDeletion(row)).toEqual({
        kind: "failed",
        message: `Removal of device '${row.stableDeviceId}' is still in flight.`,
      });
      expect(deleter.calls).toEqual([]);
      expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
        attempts: 1,
        failedDeletes: 0,
      });
    } finally {
      fence.mockRestore();
    }
  });

  test("generic registry errors record a retry without a failed native delete", async () => {
    const row = await marked();
    const read = spyOn(registry, "listFreeDeviceDeletions").mockRejectedValueOnce(
      new Error("registry unreadable"),
    );
    try {
      expect(await journal().driveFreeDeviceDeletion(row)).toEqual({
        kind: "failed",
        message: "registry unreadable",
      });
      expect(deleter.calls).toEqual([]);
      expect((await registry.listFreeDeviceDeletions())[0].deletion).toMatchObject({
        attempts: 1,
        failedDeletes: 0,
      });
    } finally {
      read.mockRestore();
    }
  });

  test("a hung native delete records one failure and in-flight passes record none", async () => {
    const row = await marked();
    const driver = journal(OWNER, undefined, 0);
    deleter.beforeDelete = () => new Promise<void>(() => {});
    const pending = driver.driveFreeDeviceDeletion(row, { deadlineMs: timer.now() + 20 });
    await flushMicrotasks();
    expect(deleter.calls).toHaveLength(1);
    timer.advanceTime(20);
    expect(await pending).toMatchObject({ kind: "failed" });
    const before = await registry.listFreeDeviceDeletions();
    expect(before[0].deletion).toMatchObject({ attempts: 1, failedDeletes: 1 });
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await driver.runPass()).toMatchObject({
        freeDeviceDeletions: [{ outcome: "blocked", message: "removal_in_flight" }],
      });
    }
    expect(await registry.listFreeDeviceDeletions()).toEqual(before);
    expect(deleter.calls).toHaveLength(1);
  });

  test("drive cancellation records no failed attempt and permits later redrive", async () => {
    const row = await marked();
    const controller = new AbortController();
    inventory.beforeList = async () => new Promise<void>(() => {});
    const driver = journal();
    const pending = driver.driveFreeDeviceDeletion(row, { signal: controller.signal });
    const rejected = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await flushMicrotasks();
    controller.abort(new Error("cancel"));
    expect(await rejected).toBeInstanceOf(Error);
    expect((await registry.listFreeDeviceDeletions())[0].deletion?.attempts).toBe(0);
    inventory.beforeList = undefined;
    expect((await driver.runPass()).freeDeviceDeletions).toMatchObject([{ outcome: "absent" }]);
  });
});

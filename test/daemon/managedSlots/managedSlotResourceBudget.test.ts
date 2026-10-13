import { beforeEach, describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  computeManagedSlotResourceUsage,
  RegistryManagedSlotResourceBudget,
  type ManagedSlotResourceRegistry,
} from "../../../src/daemon/managedSlots/managedSlotResourceBudget";
import {
  DefaultManagedSlotEvictionSelector,
  type ManagedSlotCacheEvictor,
  type ManagedSlotEvictionCandidate,
  type ManagedSlotEvictionRegistry,
  type ManagedSlotEvictionResult,
  type ManagedSlotEvictionSelector,
} from "../../../src/daemon/managedSlots/managedSlotCacheEviction";
import type {
  ManagedDeviceEntry,
  SlotJournalEntry,
  SlotJournalTarget,
  SlotKey,
  SlotPlatform,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeClaims, FakeInventory } from "./fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

class FakeEvictor implements ManagedSlotCacheEvictor {
  readonly calls: ManagedSlotEvictionCandidate[] = [];
  action: (candidate: ManagedSlotEvictionCandidate) => Promise<ManagedSlotEvictionResult> =
    async () => ({ kind: "failed", message: "unconfirmed" });
  async evict(candidate: ManagedSlotEvictionCandidate): Promise<ManagedSlotEvictionResult> {
    this.calls.push(candidate);
    return this.action(candidate);
  }
}

class ThrowingSelector implements ManagedSlotEvictionSelector {
  async select(): Promise<never> {
    throw new Error("selector unavailable");
  }
}

class ReadFailureRegistry implements ManagedSlotResourceRegistry, ManagedSlotEvictionRegistry {
  constructor(
    private readonly registry: FakeSlotRegistry,
    private readonly failAt: "journal" | "snapshot",
  ) {}
  async listOpenSlotJournal() {
    if (this.failAt === "journal") {
      throw new Error("journal unavailable");
    }
    return this.registry.listOpenSlotJournal();
  }
  async snapshotManagedSlotResources() {
    throw new Error(`${this.failAt} unavailable`);
  }
  async snapshotManagedDevices() {
    if (this.failAt === "snapshot") {
      throw new Error("snapshot unavailable");
    }
    return this.registry.snapshotManagedDevices();
  }
  listFreeDevices() {
    return this.registry.listFreeDevices();
  }
  findDeviceHolder(platform: SlotPlatform, stableDeviceId: string) {
    return this.registry.findDeviceHolder(platform, stableDeviceId);
  }
}

class SnapshotRaceRegistry implements ManagedSlotResourceRegistry, ManagedSlotEvictionRegistry {
  readonly reads: string[] = [];
  duringSnapshot: () => Promise<void> = async () => {};
  journal: () => Promise<SlotJournalEntry[]>;
  torn = false;

  constructor(private readonly registry: FakeSlotRegistry) {
    this.journal = () => registry.listOpenSlotJournal();
  }
  async snapshotManagedSlotResources() {
    this.reads.push("snapshot");
    const action = this.duringSnapshot;
    this.duringSnapshot = async () => {};
    await action();
    return this.registry.snapshotManagedSlotResources();
  }
  listOpenSlotJournal() {
    this.reads.push("journal");
    return this.journal();
  }
  listFreeDevices() {
    this.reads.push("free");
    return this.registry.listFreeDevices();
  }
  async snapshotManagedDevices(): Promise<ManagedDeviceEntry[]> {
    this.reads.push("snapshot");
    const before = await this.registry.snapshotManagedDevices();
    await this.duringSnapshot();
    const after = await this.registry.snapshotManagedDevices();
    if (!this.torn) {
      return after;
    }
    // Model SQL's assignments before adoption, followed by free rows/journal after adoption.
    return [
      ...before.filter((device) => device.holder === "slot" && device.scopeState !== null),
      ...after.filter((device) => device.holder === "free" || device.scopeState === null),
    ];
  }
  findDeviceHolder(platform: SlotPlatform, stableDeviceId: string) {
    return this.registry.findDeviceHolder(platform, stableDeviceId);
  }
}

describe("managed-slot total-resource budget", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: FakeInventory;
  let evictor: FakeEvictor;
  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    registry = new FakeSlotRegistry(timer, () => false);
    inventory = new FakeInventory();
    evictor = new FakeEvictor();
  });

  function budget(limit: number | null, eviction = false) {
    return new RegistryManagedSlotResourceBudget({
      inventory,
      registry: async () => registry,
      policy: { limit: () => limit },
      eviction: eviction
        ? {
            selector: new DefaultManagedSlotEvictionSelector({
              inventory,
              claims: new FakeClaims(),
            }),
            evictor,
          }
        : undefined,
    });
  }

  async function open(
    key: SlotKey,
    kind: "create" | "replace",
    newName: string | null,
    over: Partial<SlotJournalTarget> = {},
  ) {
    const slot = await registry.getAssignment(key);
    if (!slot) {
      throw new Error("missing slot");
    }
    const result = await registry.openSlotJournal(key, {
      kind,
      phase: kind === "create" ? "creating" : "deleting",
      owner: { daemonId: key.scopeKey, pid: 1 },
      target: {
        oldStableId: slot.stableDeviceId,
        oldName: slot.deviceName,
        newName,
        newStableId: null,
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
        ...over,
      },
      assignment: {
        kind: "state",
        expected: { generation: slot.generation, stableDeviceId: slot.stableDeviceId },
        state: kind === "create" ? "provisioning" : "replacing",
      },
    });
    if (result.kind !== "opened") {
      throw new Error(`journal ${result.kind}`);
    }
    return result.entry;
  }

  async function emptySlot(namespace: string, platform: SlotPlatform = "android") {
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: namespace,
      runnerIncarnation: "one",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope refused");
    }
    const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
    await registry.initSlot(key, { platform, role: "primary", requestedSpec: {} });
    return key;
  }

  async function creation(name: string, namespace = name, platform: SlotPlatform = "android") {
    return open(await emptySlot(namespace, platform), "create", name);
  }

  async function advance(
    entry: SlotJournalEntry,
    phase: SlotJournalEntry["phase"],
    target?: Partial<SlotJournalTarget>,
    stableDeviceId?: string | null,
  ) {
    const result = await registry.advanceSlotJournal(entry.id, {
      owner: entry.owner,
      expectedPhase: entry.phase,
      phase,
      target,
      assignment:
        stableDeviceId !== undefined
          ? {
              kind: "commit",
              expected: entry.binding,
              next: {
                stableDeviceId,
                deviceName: stableDeviceId,
                resolvedSpec: {},
                specFingerprint: "fp",
                state: "ready",
              },
            }
          : undefined,
    });
    if (result.kind !== "advanced") {
      throw new Error(`advance ${result.kind}`);
    }
    return result.entry;
  }

  async function usage() {
    return computeManagedSlotResourceUsage(await registry.snapshotManagedSlotResources());
  }

  async function cache(name: string, platform: SlotPlatform = "android", stopped = false) {
    const key = await assignManagedSlotDevice(registry, platform, name, `${platform}-${name}`);
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
    inventory.devices.push({ platform, name, deviceId: name });
    if (stopped) {
      const row = (await registry.listFreeDevices()).find(
        (device) => device.stableDeviceId === name,
      )!;
      const claim = { ...row, claimedBy: "stopper" };
      await registry.beginFreeDeviceStop(claim, { thresholdMs: 0 });
      await registry.completeFreeDeviceStop(claim);
    }
  }

  // Test eviction port proves absence and removes inventory alongside the registry row.
  async function absent(
    candidate: ManagedSlotEvictionCandidate,
  ): Promise<ManagedSlotEvictionResult> {
    const key = await assignManagedSlotDevice(
      registry,
      candidate.platform,
      candidate.stableDeviceId,
      `delete-${candidate.platform}-${candidate.stableDeviceId}`,
    );
    const entry = await open(key, "replace", null);
    await advance(entry, "committed", undefined, null);
    inventory.remove(candidate.stableDeviceId);
    return { kind: "absent" };
  }

  async function markedCache(attempts: number, failedDeletes = attempts) {
    await cache("amslot-stuck");
    const row = (await registry.listFreeDevices())[0];
    const owner = { daemonId: "delete-owner", pid: 7 };
    expect((await registry.beginFreeDeviceDeletion(row, owner)).kind).toBe("begun");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      expect(
        await registry.recordFreeDeviceDeletionAttempt(row, owner, {
          error: "native delete failed",
          nativeDeleteFailed: attempt < failedDeletes,
          nextAttemptAtMs: timer.now() + 1_000,
        }),
      ).toBe(true);
    }
    return (await registry.listFreeDevices())[0];
  }

  test.each([false, true])(
    "ten blocked attempts stay charged and committed (eviction=%s)",
    async (eviction) => {
      await markedCache(10, 0);
      await cache("amslot-eligible");
      expect(await usage()).toMatchObject({ total: 2, deleting: 1, cached: 1 });
      const mine = await creation("amslot-new");
      expect(await budget(2, eviction).admitCreation({ journalEntryId: mine.id })).toMatchObject({
        kind: "exhausted",
        usage: { total: 3, deleting: 1 },
        retained: [{ reason: "deletion_pending", attempts: 10, failedDeletes: 0 }],
      });
      expect(evictor.calls).toEqual([]);
    },
  );

  test.each([2, 3])("slot-bound deletion remains charged at %s attempts", async (attempts) => {
    await markedCache(attempts);
    const snapshot = await registry.snapshotManagedSlotResources();
    const device = snapshot.managed[0];
    expect(
      computeManagedSlotResourceUsage({
        ...snapshot,
        managed: [{ ...device, holder: "slot" }, device],
      }),
    ).toEqual({
      total: 1,
      active: 0,
      assignedIdle: 0,
      cached: 0,
      preparing: 0,
      deleting: 1,
      orphaned: 0,
    });
  });

  test("stuck deletion admits creation without charging or changing the marked inventory row", async () => {
    const row = await markedCache(3);
    const mine = await creation("amslot-new");
    expect(await budget(1, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 1, deleting: 0, cached: 0, orphaned: 0 },
      evicted: [],
    });
    expect(await registry.listFreeDevices()).toEqual([row]);
    expect(evictor.calls).toEqual([]);
    const selector = new DefaultManagedSlotEvictionSelector({
      inventory,
      claims: new FakeClaims(),
    });
    expect(await selector.select(registry, {})).toMatchObject({
      candidates: [],
      skipped: [
        {
          reason: "deletion_stuck",
          attempts: 3,
          failedDeletes: 3,
          lastError: "native delete failed",
        },
      ],
    });
    expect(
      computeManagedSlotResourceUsage({
        managed: await registry.snapshotManagedDevices(),
        openJournal: await registry.listOpenSlotJournal(),
      }),
    ).toMatchObject({ total: 2, cached: 1 }); // Missing free rows retain the original accounting.
  });

  test.each([false, true])(
    "two failed deletion attempts remain charged with evidence (eviction=%s)",
    async (eviction) => {
      await markedCache(2);
      const mine = await creation("amslot-new");
      expect(await budget(1, eviction).admitCreation({ journalEntryId: mine.id })).toMatchObject({
        kind: "exhausted",
        usage: { total: 2, deleting: 1 },
        retained: [
          {
            stableDeviceId: "amslot-stuck",
            reason: "deletion_pending",
            attempts: 2,
            failedDeletes: 2,
            lastError: "native delete failed",
          },
        ],
      });
      expect(evictor.calls).toEqual([]);
    },
  );

  test("stuck deletion is not committed room and another cached row is evicted", async () => {
    const row = await markedCache(3);
    await cache("amslot-eligible");
    await assignManagedSlotDevice(registry, "android", "active", "active", "exec");
    const mine = await creation("amslot-new");
    evictor.action = absent;
    expect(await budget(2, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 2, deleting: 0, orphaned: 0 },
      evicted: [{ stableDeviceId: "amslot-eligible" }],
    });
    expect(evictor.calls.map((device) => device.stableDeviceId)).toEqual(["amslot-eligible"]);
    expect(await registry.listFreeDevices()).toEqual([row]);
  });

  test.each([false, true])(
    "stuck deletion remains in exhaustion evidence (eviction=%s)",
    async (eviction) => {
      const row = await markedCache(3);
      await assignManagedSlotDevice(registry, "android", "active", "active", "exec");
      const mine = await creation("amslot-new");
      expect(await budget(1, eviction).admitCreation({ journalEntryId: mine.id })).toMatchObject({
        kind: "exhausted",
        usage: { total: 2, deleting: 0, orphaned: 0 },
        retained: [
          {
            stableDeviceId: "amslot-stuck",
            reason: "deletion_stuck",
            attempts: 3,
            failedDeletes: 3,
            lastError: "native delete failed",
          },
        ],
      });
      expect(await registry.listFreeDevices()).toEqual([row]);
      expect(evictor.calls).toEqual([]);
    },
  );

  test("no limit admits without ever reading the registry", async () => {
    const admission = new RegistryManagedSlotResourceBudget({
      inventory,
      registry: async () => {
        throw new Error("must not read");
      },
      policy: { limit: () => null },
    });
    expect(await admission.admitCreation({ journalEntryId: 1 })).toEqual({
      kind: "admitted",
      enforced: false,
    });
  });

  test("ledger counts distinct active, idle, cached, preparing and deleting devices across scopes and platforms", async () => {
    await assignManagedSlotDevice(registry, "android", "active", "a", "exec");
    await assignManagedSlotDevice(registry, "ios", "idle", "b");
    await cache("amslot-free");
    await cache("amslot-stopped", "ios", true);
    await creation("amslot-create");
    const key = await assignManagedSlotDevice(registry, "android", "deleting", "c");
    await open(key, "replace", null);
    const managed = await registry.snapshotManagedDevices();
    expect(
      computeManagedSlotResourceUsage({
        managed: [...managed, ...managed],
        openJournal: await registry.listOpenSlotJournal(),
      }),
    ).toEqual({
      total: 6,
      active: 1,
      assignedIdle: 1,
      cached: 2,
      preparing: 1,
      deleting: 1,
      orphaned: 0,
    });
  });

  test("materialization keeps one charge from reservation through stable identity and binding", async () => {
    let entry = await creation("amslot-ios", "ios", "ios");
    expect((await usage()).total).toBe(1);
    entry = await advance(entry, "created", { newStableId: "UDID", newName: "amslot-ios" });
    expect((await usage()).total).toBe(1);
    await advance(entry, "committed", undefined, "UDID");
    expect(await usage()).toMatchObject({ total: 1, preparing: 0, assignedIdle: 1 });
  });

  test("concurrent reservations admit the lower id and refuse the higher until confirmed deletion", async () => {
    const existing = await assignManagedSlotDevice(registry, "android", "existing");
    let lower = await creation("amslot-lower");
    const higher = await creation("amslot-higher");
    expect(lower.owner.daemonId).not.toBe(higher.owner.daemonId);
    const admissions = await Promise.all([
      budget(2).admitCreation({ journalEntryId: lower.id }),
      budget(2).admitCreation({ journalEntryId: higher.id }),
    ]);
    expect(admissions.map((result) => result.kind)).toEqual(["admitted", "exhausted"]);
    expect(admissions[0]).toMatchObject({ usage: { total: 3 } }); // refused reservation is still a commitment
    lower = await advance(lower, "created", { newStableId: "amslot-lower" });
    await advance(lower, "committed", undefined, "amslot-lower");
    expect((await budget(2).admitCreation({ journalEntryId: higher.id })).kind).toBe("exhausted");
    const deletion = await open(existing, "replace", null);
    expect((await budget(2).admitCreation({ journalEntryId: higher.id })).kind).toBe("exhausted");
    await advance(deletion, "committed", undefined, null);
    expect(await budget(2).admitCreation({ journalEntryId: higher.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 2 },
    });
    expect(
      (await registry.snapshotManagedDevices()).filter((device) => device.scopeState !== null),
    ).toHaveLength(1);
  });

  test("restart decisions and usage derive entirely from the same registry", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-new");
    expect(await budget(1).admitCreation({ journalEntryId: mine.id })).toEqual(
      await budget(1).admitCreation({ journalEntryId: mine.id }),
    );
  });

  test("reset survivor changes assigned idle to cached without changing total", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "survivor");
    expect(await usage()).toMatchObject({ total: 1, assignedIdle: 1 });
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
    expect(await usage()).toMatchObject({ total: 1, assignedIdle: 0, cached: 1 });
  });

  test("headroom retains unrelated cache without calling the evictor", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-new");
    expect(await budget(3, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "admitted",
      evicted: [],
    });
    expect(evictor.calls).toEqual([]);
  });

  test("atomic snapshot counts an adoption once without a free pre-read", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-mine");
    const racing = new SnapshotRaceRegistry(registry);
    racing.duringSnapshot = async () => {
      await assignManagedSlotDevice(registry, "android", "amslot-cache", "adopter");
    };
    const admission = new RegistryManagedSlotResourceBudget({
      inventory,
      registry: async () => racing,
      policy: { limit: () => 2 },
    });
    expect(await admission.admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 2, cached: 0, assignedIdle: 1 },
    });
    expect(racing.reads).toEqual(["snapshot"]);
  });

  test("a vanished free row is no longer compensated as cached", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-mine");
    const row = (await registry.listFreeDevices())[0];
    const owner = { daemonId: "test", pid: 7 };
    await registry.beginFreeDeviceDeletion(row, owner);
    await registry.completeFreeDeviceDeletion(row, owner);
    inventory.remove(row.stableDeviceId);
    expect(await budget(1).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 1, cached: 0 },
    });
  });

  test("T3 lost candidates are each offered once in LRU order without eviction evidence", async () => {
    await cache("amslot-b");
    timer.advanceTime(1);
    await cache("amslot-a");
    const mine = await creation("amslot-mine");
    evictor.action = async () => ({ kind: "lost" });
    const result = await budget(2, true).admitCreation({ journalEntryId: mine.id });
    expect(evictor.calls.map((device) => device.stableDeviceId)).toEqual(["amslot-b", "amslot-a"]);
    expect(result).toMatchObject({ kind: "exhausted", evictionFailures: [], usage: { total: 3 } });
    expect(result).not.toHaveProperty("evicted"); // Exhaustion has no evicted field in the public union.
  });

  test("T4 an absent candidate still listed is never offered again and the next eviction admits", async () => {
    await cache("amslot-a");
    timer.advanceTime(1);
    await cache("amslot-b");
    const mine = await creation("amslot-mine");
    evictor.action = async (candidate) =>
      candidate.stableDeviceId === "amslot-a" ? { kind: "absent" } : absent(candidate);
    const result = await budget(2, true).admitCreation({ journalEntryId: mine.id });
    expect(evictor.calls.map((device) => device.stableDeviceId)).toEqual(["amslot-a", "amslot-b"]);
    expect(result).toMatchObject({
      kind: "admitted",
      usage: { total: 2 },
      evicted: [{ stableDeviceId: "amslot-a" }, { stableDeviceId: "amslot-b" }],
    });
  });

  test("an atomic snapshot associates a later reservation with its ranking", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-mine");
    const racing = new SnapshotRaceRegistry(registry);
    racing.duringSnapshot = async () => {
      await creation("amslot-later");
    };
    const admission = new RegistryManagedSlotResourceBudget({
      inventory,
      registry: async () => racing,
      policy: { limit: () => 2 },
    });
    expect(await admission.admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 3 },
    });
    expect(racing.reads).toEqual(["snapshot"]);
  });

  test("at capacity only the LRU cache is evicted and the other remains", async () => {
    await cache("amslot-old");
    timer.advanceTime(1);
    await cache("amslot-young");
    const mine = await creation("amslot-new");
    evictor.action = absent;
    expect(await budget(2, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 2 },
      evicted: [{ stableDeviceId: "amslot-old" }],
    });
    expect(evictor.calls.map((device) => device.stableDeviceId)).toEqual(["amslot-old"]);
    expect(await registry.listFreeDevices()).toMatchObject([{ stableDeviceId: "amslot-young" }]);
  });

  test.each([false, true])(
    "failed deletion stays charged, tries next candidate and exhausts (throws=%s)",
    async (throws) => {
      await cache("amslot-a");
      await cache("amslot-b");
      const mine = await creation("amslot-new");
      evictor.action = async () => {
        if (throws) {
          throw new Error("delete failed");
        }
        return { kind: "failed", message: "delete failed" };
      };
      expect(await budget(2, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
        kind: "exhausted",
        usage: { total: 3, cached: 2 },
        evictionFailures: [
          { stableDeviceId: "amslot-a", message: "delete failed" },
          { stableDeviceId: "amslot-b", message: "delete failed" },
        ],
      });
      expect(evictor.calls).toHaveLength(2);
    },
  );

  test("failed LRU deletion can be followed by successful eviction", async () => {
    await cache("amslot-a");
    await cache("amslot-b");
    const mine = await creation("amslot-new");
    evictor.action = async (candidate) =>
      candidate.stableDeviceId === "amslot-a"
        ? { kind: "failed", message: "unconfirmed" }
        : absent(candidate);
    expect(await budget(2, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "admitted",
      usage: { cached: 1 },
      evicted: [{ stableDeviceId: "amslot-b" }],
    });
    expect(evictor.calls.map((device) => device.stableDeviceId)).toEqual(["amslot-a", "amslot-b"]);
  });

  test("other slots' idle assignments never become eviction candidates", async () => {
    await assignManagedSlotDevice(registry, "android", "idle-a", "a");
    await assignManagedSlotDevice(registry, "ios", "idle-b", "b");
    const mine = await creation("amslot-new");
    expect(await budget(2, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "exhausted",
      usage: { assignedIdle: 2 },
      retained: [],
    });
    expect(evictor.calls).toEqual([]);
  });

  test("lost row adopted meanwhile is re-read and never counted as freed", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-new");
    evictor.action = async (candidate) => {
      await assignManagedSlotDevice(
        registry,
        candidate.platform,
        candidate.stableDeviceId,
        "adopter",
      );
      return { kind: "lost" };
    };
    expect(await budget(1, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "exhausted",
      usage: { total: 2, assignedIdle: 1, cached: 0 },
    });
    expect(evictor.calls).toHaveLength(1);
  });

  test.each(["journal", "snapshot"] as const)(
    "registry %s failure returns unknown",
    async (failAt) => {
      const admission = new RegistryManagedSlotResourceBudget({
        inventory,
        registry: async () => new ReadFailureRegistry(registry, failAt),
        policy: { limit: () => 1 },
      });
      expect(await admission.admitCreation({ journalEntryId: 1 })).toEqual({
        kind: "unknown",
        message: `${failAt} unavailable`,
      });
    },
  );

  test("throwing selector returns unknown rather than admitting", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-new");
    const admission = new RegistryManagedSlotResourceBudget({
      inventory,
      registry: async () => registry,
      policy: { limit: () => 1 },
      eviction: { selector: new ThrowingSelector(), evictor },
    });
    expect(await admission.admitCreation({ journalEntryId: mine.id })).toEqual({
      kind: "unknown",
      message: "selector unavailable",
    });
  });

  test("aborted signal rejects with its reason before eviction", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-new");
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    await expect(
      budget(1, true).admitCreation({ journalEntryId: mine.id, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(evictor.calls).toEqual([]);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "invalid limit %s throws ActionableError",
    async (limit) => {
      await expect(budget(limit).admitCreation({ journalEntryId: 1 })).rejects.toBeInstanceOf(
        ActionableError,
      );
    },
  );

  test("replacement with no new identity stays charged across the deleted phase", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "old");
    let entry = await open(key, "replace", null);
    expect(await usage()).toMatchObject({ total: 1, deleting: 1 });
    entry = await advance(entry, "deleted", undefined, null);
    expect(await usage()).toMatchObject({ total: 1, preparing: 1 });
    entry = await advance(entry, "creating", { newName: "amslot-new" });
    expect(await usage()).toMatchObject({ total: 1, preparing: 1 });
    await advance(entry, "committed", { newStableId: "amslot-new" }, "amslot-new");
    expect(await usage()).toMatchObject({ total: 1, assignedIdle: 1 });
  });

  test("ambiguous pure delete is conservatively charged only until its journal closes", async () => {
    const key = await assignManagedSlotDevice(registry, "android", "old");
    let entry = await open(key, "replace", null);
    entry = await advance(entry, "deleted", undefined, null);
    expect((await usage()).total).toBe(1);
    await advance(entry, "committed");
    expect((await usage()).total).toBe(0);
  });

  test("replace creation is charged regardless of reservation id and old/new overlap keeps both", async () => {
    const mine = await creation("amslot-mine");
    const key = await assignManagedSlotDevice(registry, "ios", "old", "replace");
    await open(key, "replace", "amslot-replacement", { newPlatform: "android" });
    expect(await usage()).toMatchObject({ total: 3, preparing: 2, deleting: 1 });
    expect((await budget(2).admitCreation({ journalEntryId: mine.id })).kind).toBe("exhausted");
  });

  test("unknown unmatched preparation and a missing caller reservation are both charged", async () => {
    await creation("amslot-unmatched");
    const admission = new RegistryManagedSlotResourceBudget({
      inventory,
      registry: async () => ({
        snapshotManagedSlotResources: async () => ({
          ...(await registry.snapshotManagedSlotResources()),
          openJournal: [],
        }),
        listFreeDevices: () => registry.listFreeDevices(),
        findDeviceHolder: (platform, id) => registry.findDeviceHolder(platform, id),
      }),
      policy: { limit: () => 1 },
    });
    expect(await admission.admitCreation({ journalEntryId: 100 })).toMatchObject({
      kind: "exhausted",
      usage: { total: 1, preparing: 1 },
    });
  });

  test("each call reads and validates the current owner-chosen limit", async () => {
    let limit: number | null = null;
    const admission = new RegistryManagedSlotResourceBudget({
      inventory,
      registry: async () => registry,
      policy: { limit: () => limit },
    });
    expect(await admission.admitCreation({ journalEntryId: 1 })).toEqual({
      kind: "admitted",
      enforced: false,
    });
    limit = 0;
    await expect(admission.admitCreation({ journalEntryId: 1 })).rejects.toBeInstanceOf(
      ActionableError,
    );
    limit = 1;
    expect((await admission.admitCreation({ journalEntryId: 1 })).kind).toBe("admitted");
  });

  test("second independent read confirms exhaustion before refusal", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-mine");
    const racing = new SnapshotRaceRegistry(registry);
    const admission = new RegistryManagedSlotResourceBudget({
      inventory,
      registry: async () => racing,
      policy: { limit: () => 1 },
    });
    expect(await admission.admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "exhausted",
      usage: { total: 2 },
    });
    expect(racing.reads).toEqual(["snapshot", "snapshot"]);
  });

  test("exhaustion reports the final selection's protected cached rows", async () => {
    await cache("personal-device");
    const mine = await creation("amslot-new");
    expect(await budget(1, true).admitCreation({ journalEntryId: mine.id })).toMatchObject({
      kind: "exhausted",
      retained: [{ stableDeviceId: "personal-device", reason: "not_daemon_created" }],
    });
    expect(evictor.calls).toEqual([]);
  });

  test("a continually lost row cannot produce an unbounded eviction loop", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-new");
    evictor.action = async () => ({ kind: "lost" });
    expect((await budget(1, true).admitCreation({ journalEntryId: mine.id })).kind).toBe(
      "exhausted",
    );
    expect(evictor.calls).toHaveLength(1);
  });

  test("cancellation during eviction is rethrown rather than reported as a failed delete", async () => {
    await cache("amslot-cache");
    const mine = await creation("amslot-new");
    const controller = new AbortController();
    const reason = new Error("cancelled in delete");
    evictor.action = async () => {
      controller.abort(reason);
      throw reason;
    };
    await expect(
      budget(1, true).admitCreation({ journalEntryId: mine.id, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(evictor.calls).toHaveLength(1);
  });

  test("missing snapshot targets are defensively deduplicated and terminal journals are ignored", async () => {
    const entry = await creation("amslot-new");
    expect(
      computeManagedSlotResourceUsage({
        managed: [],
        openJournal: [entry, { ...entry, id: entry.id + 1 }],
      }),
    ).toMatchObject({ total: 1, preparing: 1 });
    expect(
      computeManagedSlotResourceUsage({
        managed: [],
        openJournal: [{ ...entry, phase: "committed" }],
      }).total,
    ).toBe(0);
  });
});

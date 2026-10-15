import { beforeEach, describe, expect, test } from "bun:test";
import { ActionableError } from "../../../../src/models/ActionableError";
import {
  computeBindingResourceUsage,
  RegistryBindingResourceBudget,
  type BindingResourceRegistry,
} from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import type {
  ManagedDeviceEntry,
  BindingJournalEntry,
  BindingJournalTarget,
  BindingKey,
  BindingPlatform,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeInventory } from "../registry/fixtures/reconcilerFakes";
import { assignBindingDevice } from "./bindingFixtures";

class ReadFailureRegistry implements BindingResourceRegistry {
  constructor(
    private readonly registry: FakeBindingRegistry,
    private readonly failAt: "journal" | "snapshot",
  ) {}
  async listOpenBindingJournal() {
    if (this.failAt === "journal") {
      throw new Error("journal unavailable");
    }
    return this.registry.listOpenBindingJournal();
  }
  async snapshotBindingResources() {
    throw new Error(`${this.failAt} unavailable`);
  }
  async snapshotManagedDevices() {
    if (this.failAt === "snapshot") {
      throw new Error("snapshot unavailable");
    }
    return this.registry.snapshotManagedDevices();
  }
  findDeviceHolder(platform: BindingPlatform, stableDeviceId: string) {
    return this.registry.findDeviceHolder(platform, stableDeviceId);
  }
}

class SnapshotRaceRegistry implements BindingResourceRegistry {
  readonly reads: string[] = [];
  duringSnapshot: () => Promise<void> = async () => {};
  journal: () => Promise<BindingJournalEntry[]>;
  torn = false;

  constructor(private readonly registry: FakeBindingRegistry) {
    this.journal = () => registry.listOpenBindingJournal();
  }
  async snapshotBindingResources() {
    this.reads.push("snapshot");
    const action = this.duringSnapshot;
    this.duringSnapshot = async () => {};
    await action();
    return this.registry.snapshotBindingResources();
  }
  listOpenBindingJournal() {
    this.reads.push("journal");
    return this.journal();
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
      ...before.filter(
        (device) => device.holder === "session_broker" && device.scopeState !== null,
      ),
      ...after.filter((device) => device.holder === "free" || device.scopeState === null),
    ];
  }
  findDeviceHolder(platform: BindingPlatform, stableDeviceId: string) {
    return this.registry.findDeviceHolder(platform, stableDeviceId);
  }
}

describe("binding total-resource budget", () => {
  let timer: FakeTimer;
  let registry: FakeBindingRegistry;
  let inventory: FakeInventory;
  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    registry = new FakeBindingRegistry(timer, () => false);
    inventory = new FakeInventory();
  });

  function budget(limit: number | null) {
    return new RegistryBindingResourceBudget({
      inventory,
      registry: async () => registry,
      policy: { limit: () => limit },
    });
  }

  async function open(
    key: BindingKey,
    kind: "create" | "replace",
    newName: string | null,
    over: Partial<BindingJournalTarget> = {},
  ) {
    const binding = await registry.getAssignment(key);
    if (!binding) {
      throw new Error("missing binding");
    }
    const result = await registry.openBindingJournal(key, {
      kind,
      phase: kind === "create" ? "creating" : "deleting",
      owner: { daemonId: key.scopeKey, pid: 1 },
      target: {
        oldStableId: binding.stableDeviceId,
        oldName: binding.deviceName,
        newName,
        newStableId: null,
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
        ...over,
      },
      assignment: {
        kind: "state",
        expected: { generation: binding.generation, stableDeviceId: binding.stableDeviceId },
        state: kind === "create" ? "provisioning" : "replacing",
      },
    });
    if (result.kind !== "opened") {
      throw new Error(`journal ${result.kind}`);
    }
    return result.entry;
  }

  async function emptyBinding(namespace: string, platform: BindingPlatform = "android") {
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: namespace,
      runnerIncarnation: "one",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope refused");
    }
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    await registry.initBinding(key, { platform, role: "primary", requestedSpec: {} });
    return key;
  }

  async function creation(name: string, namespace = name, platform: BindingPlatform = "android") {
    return open(await emptyBinding(namespace, platform), "create", name);
  }

  async function advance(
    entry: BindingJournalEntry,
    phase: BindingJournalEntry["phase"],
    target?: Partial<BindingJournalTarget>,
    stableDeviceId?: string | null,
  ) {
    const result = await registry.advanceBindingJournal(entry.id, {
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
    return computeBindingResourceUsage(await registry.snapshotBindingResources());
  }

  test.each(["amslot-", "ambroker-"])(
    "%s inventory orphans on both platforms still consume the native budget",
    async (prefix) => {
      inventory.devices = [
        { platform: "android", name: `${prefix}upgrade-0-g1-nonce`, isRunning: false },
        {
          platform: "ios",
          name: `${prefix}upgrade-1-g1-nonce`,
          deviceId: "SIM-UPGRADE",
          isRunning: false,
        },
        { platform: "ios", name: "amslotx", deviceId: "SIM-USER", isRunning: false },
      ];
      const entry = await creation("ambroker-new-0-g1-nonce");
      expect(await budget(2).admitCreation({ journalEntryId: entry.id })).toMatchObject({
        kind: "exhausted",
        usage: { total: 3, orphaned: 2, preparing: 1 },
      });
    },
  );

  test("no limit admits without ever reading the registry", async () => {
    const admission = new RegistryBindingResourceBudget({
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
    await assignBindingDevice(registry, "android", "active", "a", "exec");
    await assignBindingDevice(registry, "ios", "idle", "b");
    await creation("amslot-create");
    const key = await assignBindingDevice(registry, "android", "deleting", "c");
    await open(key, "replace", null);
    const managed = await registry.snapshotManagedDevices();
    expect(
      computeBindingResourceUsage({
        managed: [...managed, ...managed],
        openJournal: await registry.listOpenBindingJournal(),
      }),
    ).toEqual({
      total: 4,
      active: 1,
      assignedIdle: 1,
      cached: 0,
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
    const existing = await assignBindingDevice(registry, "android", "existing");
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
    const mine = await creation("amslot-new");
    expect(await budget(1).admitCreation({ journalEntryId: mine.id })).toEqual(
      await budget(1).admitCreation({ journalEntryId: mine.id }),
    );
  });

  test("atomic snapshot counts an adoption once without a free pre-read", async () => {
    const mine = await creation("amslot-mine");
    const racing = new SnapshotRaceRegistry(registry);
    racing.duringSnapshot = async () => {
      await assignBindingDevice(registry, "android", "amslot-cache", "adopter");
    };
    const admission = new RegistryBindingResourceBudget({
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

  test("an atomic snapshot associates a later reservation with its ranking", async () => {
    await assignBindingDevice(registry, "android", "idle", "idle");
    const mine = await creation("amslot-mine");
    const racing = new SnapshotRaceRegistry(registry);
    racing.duringSnapshot = async () => {
      await creation("amslot-later");
    };
    const admission = new RegistryBindingResourceBudget({
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

  test("exhaustion exposes assigned idle rows and orphan while retained stays empty", async () => {
    await assignBindingDevice(registry, "android", "idle-a", "a");
    await assignBindingDevice(registry, "ios", "idle-b", "b");
    inventory.devices.push({ platform: "android", name: "amslot-orphan", deviceId: "orphan-id" });
    const mine = await creation("amslot-new");
    const result = await budget(2).admitCreation({ journalEntryId: mine.id });
    expect(result).toMatchObject({
      kind: "exhausted",
      usage: {
        total: 4,
        active: 0,
        assignedIdle: 2,
        cached: 0,
        preparing: 1,
        deleting: 0,
        orphaned: 1,
      },
      retained: [],
    });
    expect(result.kind === "exhausted" && result.charged).toEqual([
      { platform: "android", stableDeviceId: "idle-a", kind: "assigned_idle" },
      { platform: "ios", stableDeviceId: "idle-b", kind: "assigned_idle" },
      { platform: "android", stableDeviceId: "amslot-new", kind: "preparing" },
      { platform: "android", stableDeviceId: "amslot-orphan", kind: "orphaned" },
    ]);
  });

  test.each(["journal", "snapshot"] as const)(
    "registry %s failure returns unknown",
    async (failAt) => {
      const admission = new RegistryBindingResourceBudget({
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

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "invalid limit %s throws ActionableError",
    async (limit) => {
      await expect(budget(limit).admitCreation({ journalEntryId: 1 })).rejects.toBeInstanceOf(
        ActionableError,
      );
    },
  );

  test("replacement with no new identity stays charged across the deleted phase", async () => {
    const key = await assignBindingDevice(registry, "android", "old");
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
    const key = await assignBindingDevice(registry, "android", "old");
    let entry = await open(key, "replace", null);
    entry = await advance(entry, "deleted", undefined, null);
    expect((await usage()).total).toBe(1);
    await advance(entry, "committed");
    expect((await usage()).total).toBe(0);
  });

  test("replace creation is charged regardless of reservation id and old/new overlap keeps both", async () => {
    const mine = await creation("amslot-mine");
    const key = await assignBindingDevice(registry, "ios", "old", "replace");
    await open(key, "replace", "amslot-replacement", { newPlatform: "android" });
    expect(await usage()).toMatchObject({ total: 3, preparing: 2, deleting: 1 });
    expect((await budget(2).admitCreation({ journalEntryId: mine.id })).kind).toBe("exhausted");
  });

  test("each call reads and validates the current owner-chosen limit", async () => {
    let limit: number | null = null;
    const admission = new RegistryBindingResourceBudget({
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
    await assignBindingDevice(registry, "android", "idle", "idle");
    const mine = await creation("amslot-mine");
    const racing = new SnapshotRaceRegistry(registry);
    const admission = new RegistryBindingResourceBudget({
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

  test("missing snapshot targets are defensively deduplicated and terminal journals are ignored", async () => {
    const entry = await creation("amslot-new");
    expect(
      computeBindingResourceUsage({
        managed: [],
        openJournal: [entry, { ...entry, id: entry.id + 1 }],
      }),
    ).toMatchObject({ total: 1, preparing: 1 });
    expect(
      computeBindingResourceUsage({
        managed: [],
        openJournal: [{ ...entry, phase: "committed" }],
      }).total,
    ).toBe(0);
  });

  test("a missing toolchain contributes zero orphans while the other platform is counted", async () => {
    const limited = new RegistryBindingResourceBudget({
      registry: async () => registry,
      policy: { limit: () => 2 },
      timer,
      inventory: {
        list: async (platform) =>
          platform === "ios"
            ? { complete: false, devices: [], toolchain: "not_installed" }
            : { complete: true, devices: [{ platform: "android", name: "amslot-orphan" }] },
      },
    });
    const entry = await creation("amslot-new");
    expect(await limited.admitCreation({ journalEntryId: entry.id })).toMatchObject({
      kind: "admitted",
      usage: { orphaned: 1, total: 2 },
    });
  });

  test("a plain incomplete platform keeps orphan usage unknown", async () => {
    const limited = new RegistryBindingResourceBudget({
      registry: async () => registry,
      policy: { limit: () => 2 },
      timer,
      inventory: { list: async (platform) => ({ complete: platform === "android", devices: [] }) },
    });
    expect(await limited.admitCreation({ journalEntryId: 1 })).toMatchObject({ kind: "unknown" });
  });

  test("unknown unmatched preparation and a missing caller reservation are both charged", async () => {
    await creation("amslot-unmatched");
    const admission = new RegistryBindingResourceBudget({
      inventory,
      registry: async () => ({
        snapshotBindingResources: async () => ({
          ...(await registry.snapshotBindingResources()),
          openJournal: [],
        }),
        findDeviceHolder: (platform, id) => registry.findDeviceHolder(platform, id),
      }),
      policy: { limit: () => 1 },
    });
    expect(await admission.admitCreation({ journalEntryId: 100 })).toMatchObject({
      kind: "exhausted",
      usage: { total: 1, preparing: 1 },
    });
  });
});

import { beforeEach, describe, expect, test } from "bun:test";
import type { DeviceInfo } from "../../../../src/models/index";
import {
  computeBindingResourceUsage,
  describeBudgetExhaustion,
  RegistryBindingResourceBudget,
} from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import { DeviceManagerBindingInventory } from "../../../../src/daemon/sessionBroker/provisioning/DeviceManagerBindingInventory";
import type {
  BindingJournalEntry,
  BindingPlatform,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { SimctlUnavailableError } from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeInventory } from "../registry/fixtures/reconcilerFakes";
import { assignBindingDevice } from "./bindingFixtures";

/**
 * Owner decision (#15882): one managed-device limit is shared by every device kind the daemon
 * runs. Android phones, Wear OS, Android TV and Android Automotive emulators are all
 * `platform: "android"` with a form factor; iPhones are `ios` (a CarPlay screen is an auxiliary
 * display of its iPhone, never a separate listing); Apple Watch simulators are `watchos`.
 */
const ORPHANS: DeviceInfo[] = [
  { platform: "android", name: "ambroker-phone", formFactor: "phone", isRunning: true },
  { platform: "android", name: "ambroker-wear", formFactor: "watch", isRunning: true },
  { platform: "android", name: "ambroker-tv", formFactor: "tv", isRunning: true },
  { platform: "android", name: "ambroker-auto", formFactor: "automotive", isRunning: true },
  {
    platform: "ios",
    name: "ambroker-iphone-carplay",
    deviceId: "IPHONE-1",
    formFactor: "phone",
    isRunning: true,
    state: "Booted",
  },
  {
    platform: "watchos",
    name: "ambroker-watch",
    deviceId: "WATCH-1",
    formFactor: "watch",
    isRunning: true,
    state: "Booted",
  },
];

const CREATIONS: Array<[string, BindingPlatform]> = [
  ["Android phone", "android"],
  ["Wear OS emulator", "android"],
  ["Android TV emulator", "android"],
  ["Android Automotive emulator", "android"],
  ["iPhone simulator", "ios"],
  ["Apple Watch simulator", "watchos"],
];

describe("shared total-resource budget across phone, watch, TV and car devices", () => {
  let timer: FakeTimer;
  let registry: FakeBindingRegistry;
  let inventory: FakeInventory;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    registry = new FakeBindingRegistry(timer, () => false);
    inventory = new FakeInventory();
  });

  function budget(limit: number) {
    return new RegistryBindingResourceBudget({
      inventory,
      registry: async () => registry,
      policy: { limit: () => limit },
    });
  }

  /** An open create reservation on `platform`, as the reconciler leaves it before admission. */
  async function creation(platform: BindingPlatform, name: string): Promise<BindingJournalEntry> {
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: `creator-${name}`,
      runnerIncarnation: "one",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope refused");
    }
    const key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    await registry.initBinding(key, { platform, role: "primary", requestedSpec: {} });
    const result = await registry.openBindingJournal(key, {
      kind: "create",
      phase: "creating",
      owner: { daemonId: "d", pid: 1 },
      target: {
        oldStableId: null,
        oldName: null,
        newName: name,
        newStableId: null,
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
      },
      assignment: {
        kind: "state",
        expected: { generation: 0, stableDeviceId: null },
        state: "provisioning",
      },
    });
    if (result.kind !== "opened") {
      throw new Error(`journal ${result.kind}`);
    }
    return result.entry;
  }

  test("each running daemon-named device of every kind is one orphan unit", async () => {
    inventory.devices = ORPHANS;
    const usage = computeBindingResourceUsage({
      ...(await registry.snapshotBindingResources()),
      inventory: ORPHANS,
    });
    expect(usage).toEqual({
      total: 6,
      active: 0,
      assignedIdle: 0,
      preparing: 0,
      deleting: 0,
      orphaned: 6,
    });
  });

  test("a watch commitment charges the shared total like an Android or iOS one", async () => {
    await assignBindingDevice(registry, "android", "avd-phone", "runner-android");
    await assignBindingDevice(registry, "ios", "IPHONE-2", "runner-ios");
    await assignBindingDevice(registry, "watchos", "WATCH-2", "runner-watch", "session-w");
    expect(computeBindingResourceUsage(await registry.snapshotBindingResources())).toEqual({
      total: 3,
      active: 1,
      assignedIdle: 2,
      preparing: 0,
      deleting: 0,
      orphaned: 0,
    });
  });

  test.each([
    ["Booted", true, "running"],
    ["Booting", false, "transitioning"],
    ["Shutting Down", false, "transitioning"],
  ] as const)(
    "a daemon-named watch in state %s without a commitment is orphaned",
    async (state, running, orphanState) => {
      inventory.devices = [
        { platform: "watchos", name: "ambroker-w", deviceId: "W-9", isRunning: running, state },
      ];
      const entry = await creation("android", "ambroker-new");
      const result = await budget(1).admitCreation({ journalEntryId: entry.id });
      expect(result).toMatchObject({ kind: "exhausted", usage: { total: 2, orphaned: 1 } });
      expect(result.kind === "exhausted" && result.charged.at(-1)).toEqual({
        platform: "watchos",
        stableDeviceId: "W-9",
        kind: "orphaned",
        name: "ambroker-w",
        orphanState,
      });
    },
  );

  test("a shut-down or user-named watch holds nothing", async () => {
    inventory.devices = [
      {
        platform: "watchos",
        name: "ambroker-off",
        deviceId: "W-1",
        isRunning: false,
        state: "Shutdown",
      },
      { platform: "watchos", name: "My Watch", deviceId: "W-2", isRunning: true, state: "Booted" },
    ];
    const entry = await creation("ios", "ambroker-new");
    expect(await budget(1).admitCreation({ journalEntryId: entry.id })).toMatchObject({
      kind: "admitted",
      usage: { total: 1, orphaned: 0 },
    });
  });

  test.each(CREATIONS)(
    "with the one limit full of every kind, a new %s is refused naming the charged devices",
    async (_kind, platform) => {
      inventory.devices = ORPHANS;
      const entry = await creation(platform, "ambroker-new");
      const result = await budget(ORPHANS.length).admitCreation({ journalEntryId: entry.id });
      expect(result).toMatchObject({
        kind: "exhausted",
        limit: ORPHANS.length,
        usage: { total: ORPHANS.length + 1, orphaned: ORPHANS.length, preparing: 1 },
      });
      if (result.kind !== "exhausted") {
        throw new Error("expected exhaustion");
      }
      const orphans = result.charged.filter((charge) => charge.kind === "orphaned");
      expect(orphans.map((charge) => charge.name).sort()).toEqual(
        ORPHANS.map((device) => device.name).sort(),
      );
      const message = describeBudgetExhaustion(result);
      expect(message).toContain("ambroker-watch (watchos, orphaned: running)");
      expect(message).toContain("ambroker-tv (android, orphaned: running)");
      expect(message).toContain("ambroker-auto (android, orphaned: running)");
      expect(message).toContain("ambroker-wear (android, orphaned: running)");
      expect(message).toContain("ambroker-iphone-carplay (ios, orphaned: running)");
    },
  );

  test("phones and Android fill the limit: a watch creation is refused", async () => {
    await assignBindingDevice(registry, "android", "avd-phone", "runner-android");
    await assignBindingDevice(registry, "ios", "IPHONE-2", "runner-ios");
    const watch = await creation("watchos", "ambroker-watch-new");
    const result = await budget(2).admitCreation({ journalEntryId: watch.id });
    expect(result).toMatchObject({ kind: "exhausted", usage: { total: 3 } });
    expect(await budget(3).admitCreation({ journalEntryId: watch.id })).toMatchObject({
      kind: "admitted",
    });
  });

  test("watches fill the limit: an Android or iPhone creation is refused", async () => {
    await assignBindingDevice(registry, "watchos", "WATCH-1", "runner-watch-1");
    inventory.devices = [
      { platform: "watchos", name: "ambroker-w2", deviceId: "WATCH-2", isRunning: true },
    ];
    for (const platform of ["android", "ios"] as const) {
      const entry = await creation(platform, `ambroker-${platform}`);
      const result = await budget(2).admitCreation({ journalEntryId: entry.id });
      expect(result).toMatchObject({ kind: "exhausted" });
      expect(
        result.kind === "exhausted" &&
          result.charged.filter((charge) => charge.platform === "watchos").length,
      ).toBe(2);
    }
  });
});

describe("watch inventory behind the daemon's binding inventory", () => {
  const noImages = { listDeviceImages: async () => [] };

  test("lists Apple Watch simulators from the watch listing only", async () => {
    const watch: DeviceInfo = {
      platform: "watchos",
      name: "ambroker-w",
      deviceId: "W",
      isRunning: true,
    };
    const inventory = new DeviceManagerBindingInventory(noImages, {
      listWatchSimulators: async () => [watch],
    });
    expect(await inventory.list("watchos", {})).toEqual({ complete: true, devices: [watch] });
  });

  test("a host without simulators reports the watch toolchain as not installed", async () => {
    for (const inventory of [
      new DeviceManagerBindingInventory(noImages),
      new DeviceManagerBindingInventory(noImages, {
        listWatchSimulators: async () => {
          throw new SimctlUnavailableError("simctl unavailable");
        },
      }),
    ]) {
      expect(await inventory.list("watchos", {})).toEqual({
        complete: false,
        devices: [],
        toolchain: "not_installed",
      });
    }
  });

  test("a failed watch listing leaves admission unknown, never free", async () => {
    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer, () => false);
    const inventory = new DeviceManagerBindingInventory(noImages, {
      listWatchSimulators: async () => {
        throw new Error("simctl list timed out");
      },
    });
    expect(await inventory.list("watchos", {})).toEqual({ complete: false, devices: [] });
    const budget = new RegistryBindingResourceBudget({
      inventory,
      registry: async () => registry,
      policy: { limit: () => 4 },
      timer,
    });
    expect(await budget.admitCreation({ journalEntryId: 1 })).toMatchObject({
      kind: "unknown",
      message: expect.stringContaining("watchos inventory is incomplete"),
    });
  });
});

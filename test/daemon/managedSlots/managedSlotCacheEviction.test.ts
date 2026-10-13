import { beforeEach, describe, expect, test } from "bun:test";
import type { DeviceInfo } from "../../../src/models";
import {
  DefaultManagedSlotEvictionSelector,
  type ManagedSlotEvictionRegistry,
} from "../../../src/daemon/managedSlots/managedSlotCacheEviction";
import type {
  ManagedSlotInventory,
  ManagedSlotInventorySnapshot,
} from "../../../src/daemon/managedSlots/reconciler";
import type {
  SlotJournalTarget,
  SlotPlatform,
} from "../../../src/daemon/managedSlots/slotRegistry";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeClaims } from "./fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

class Inventory implements ManagedSlotInventory {
  devices: DeviceInfo[] = [];
  complete = true;
  failure: Error | undefined;
  calls: SlotPlatform[] = [];
  signals: Array<AbortSignal | undefined> = [];
  async list(
    platform: SlotPlatform,
    options: { signal?: AbortSignal },
  ): Promise<ManagedSlotInventorySnapshot> {
    this.calls.push(platform);
    this.signals.push(options.signal);
    if (this.failure) {
      throw this.failure;
    }
    return {
      complete: this.complete,
      devices: this.devices.filter((device) => device.platform === platform),
    };
  }
}

describe("managed-slot safe LRU cache selection", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let inventory: Inventory;
  let claims: FakeClaims;
  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    registry = new FakeSlotRegistry(timer, () => false);
    inventory = new Inventory();
    claims = new FakeClaims();
  });

  function selector(
    over: {
      isBusy?: (device: DeviceInfo) => string | undefined;
      lastUsedAtMs?: (device: { stableDeviceId: string }) => number;
    } = {},
  ) {
    return new DefaultManagedSlotEvictionSelector({ inventory, claims, ...over });
  }

  async function cache(id = "amslot-a", platform: SlotPlatform = "android", name = id) {
    const key = await assignManagedSlotDevice(registry, platform, id, `${platform}-${id}`);
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
    inventory.devices.push({ platform, name, deviceId: id, isRunning: false });
    return (await registry.listFreeDevices()).find(
      (row) => row.platform === platform && row.stableDeviceId === id,
    )!;
  }

  async function skip(
    reason: string,
    selected = selector(),
    source: ManagedSlotEvictionRegistry = registry,
  ) {
    const before = await registry.snapshotManagedDevices();
    const result = await selected.select(source, {});
    expect(result.candidates).toEqual([]);
    expect(result.skipped).toEqual([{ platform: "android", stableDeviceId: "amslot-a", reason }]);
    // Selection leaves all commitments untouched, including rows protected by held/busy checks.
    if (reason !== "row_moved") {
      expect(await registry.snapshotManagedDevices()).toEqual(before);
    }
  }

  test("stopping is skipped even when the stop claim is stale", async () => {
    const row = await cache();
    await registry.beginFreeDeviceStop({ ...row, claimedBy: "dead" }, { thresholdMs: 0 });
    timer.advanceTime(1_000_000);
    inventory.devices = []; // Stopping protects even a verified-absent row.
    await skip("stopping");
  });

  test.each(["oldStableId", "oldName", "newStableId", "newName"] as const)(
    "journal_open protects a row named by %s",
    async (field) => {
      await cache();
      const key = await assignManagedSlotDevice(registry, "android", "other", "journal");
      const target: SlotJournalTarget = {
        oldStableId: "other",
        oldName: "other",
        newStableId: null,
        newName: null,
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
      };
      target[field] = "amslot-a";
      const opened = await registry.openSlotJournal(key, {
        kind: "replace",
        phase: "intent",
        target,
        owner: { daemonId: "other-daemon", pid: 2 },
        assignment: {
          kind: "state",
          expected: { generation: 1, stableDeviceId: "other" },
          state: "replacing",
        },
      });
      expect(opened.kind).toBe("opened");
      inventory.devices = []; // Journal ownership also protects absent rows.
      await skip("journal_open");
    },
  );

  test("journal new side uses creation platform and old side uses entry platform", async () => {
    await cache();
    await cache("ios-cache", "ios", "amslot-ios");
    const key = await assignManagedSlotDevice(registry, "ios", "old-ios", "journal");
    const result = await registry.openSlotJournal(key, {
      kind: "replace",
      phase: "deleting",
      owner: { daemonId: "d", pid: 1 },
      target: {
        oldStableId: "ios-cache",
        oldName: "amslot-a",
        newPlatform: "android",
        newStableId: null,
        newName: "amslot-a",
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
      },
      assignment: {
        kind: "state",
        expected: { generation: 1, stableDeviceId: "old-ios" },
        state: "replacing",
      },
    });
    expect(result.kind).toBe("opened");
    const selected = await selector().select(registry, {});
    expect(selected.candidates).toEqual([]);
    expect(selected.skipped.map((row) => row.reason)).toEqual(["journal_open", "journal_open"]);
  });

  test("a journal on another platform does not protect a same-id free row", async () => {
    await cache();
    const key = await assignManagedSlotDevice(registry, "ios", "amslot-a", "other-platform");
    const result = await registry.openSlotJournal(key, {
      kind: "replace",
      phase: "deleting",
      owner: { daemonId: "d", pid: 1 },
      target: {
        oldStableId: "amslot-a",
        oldName: "amslot-a",
        newStableId: null,
        newName: "amslot-a",
        requestedSpec: {},
        resolvedSpec: {},
        specFingerprint: "fp",
      },
      assignment: {
        kind: "state",
        expected: { generation: 1, stableDeviceId: "amslot-a" },
        state: "replacing",
      },
    });
    expect(result.kind).toBe("opened");
    expect((await selector().select(registry, {})).candidates).toHaveLength(1);
  });

  test("incomplete inventory skips discovery_incomplete", async () => {
    await cache();
    inventory.complete = false;
    await skip("discovery_incomplete");
  });

  test("throwing inventory skips discovery_incomplete", async () => {
    await cache();
    inventory.failure = new Error("inventory failed");
    await skip("discovery_incomplete");
  });

  test("verified-absent candidates precede older listed devices without consulting claims or busy", async () => {
    await cache("amslot-old");
    timer.advanceTime(1);
    const missing = await cache();
    inventory.devices = inventory.devices.filter((device) => device.name !== "amslot-a");
    claims.beforeDescribe = async () => {};
    claims.sessionsOn = (device) => {
      expect(device.name).not.toBe("amslot-a");
      return [];
    };
    claims.describe = async (device) => {
      expect(device.name).not.toBe("amslot-a");
      return { kind: "free" };
    };
    const selected = await selector({
      isBusy: (device) => {
        expect(device.name).not.toBe("amslot-a");
        return undefined;
      },
    }).select(registry, {});
    expect(selected.candidates.map((row) => row.stableDeviceId)).toEqual([
      "amslot-a",
      "amslot-old",
    ]);
    expect(selected.candidates[0]).toMatchObject({
      platform: missing.platform,
      stableDeviceId: missing.stableDeviceId,
      fromScopeKey: missing.fromScopeKey,
      freedAtMs: missing.freedAtMs,
      name: "amslot-a",
      absent: true,
      lastUsedAtMs: missing.freedAtMs,
    });
  });

  test("a not-installed toolchain never proves a free row absent", async () => {
    await cache();
    inventory.list = async () => ({ complete: false, devices: [], toolchain: "not_installed" });
    await skip("discovery_incomplete");
  });

  test("an absent row with a deletion marker stays pending", async () => {
    const row = await cache();
    inventory.devices = [];
    await registry.beginFreeDeviceDeletion(row, { daemonId: "d", pid: 1 });
    expect((await selector().select(registry, {})).skipped[0]?.reason).toBe("deletion_pending");
  });

  test("an external name skips not_daemon_created", async () => {
    await cache();
    inventory.devices = [
      { name: "personal-simulator", deviceId: "external-udid", platform: "ios" },
    ];
    // Android stable identity is its name, so exercise the external-name check on an iOS UDID.
    const iosRegistry = new FakeSlotRegistry(timer, () => false);
    const key = await assignManagedSlotDevice(iosRegistry, "ios", "external-udid");
    await iosRegistry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await iosRegistry.completeScopeInvalidation(key.scopeKey);
    expect(await selector().select(iosRegistry, {})).toEqual({
      candidates: [],
      skipped: [{ platform: "ios", stableDeviceId: "external-udid", reason: "not_daemon_created" }],
    });
  });

  test("live session skips session_holds_device before claims and busy checks", async () => {
    await cache();
    claims.sessions.set("amslot-a", ["live-execution"]);
    claims.claims.set("amslot-a", { kind: "held", reason: "held" });
    await skip("session_holds_device", selector({ isBusy: () => "restart reservation" }));
  });

  test("foreign claim skips held", async () => {
    await cache();
    claims.claims.set("amslot-a", { kind: "held", reason: "daemon-b" });
    await skip("held");
  });

  test("unknown claim skips claim_unknown", async () => {
    await cache();
    claims.claims.set("amslot-a", { kind: "unknown", reason: "unreadable" });
    await skip("claim_unknown");
  });

  test.each(["booting", "lifecycle lease", "shutdown", "restart recovery"])(
    "busy skips %s",
    async (reason) => {
      await cache();
      await skip("busy", selector({ isBusy: () => reason }));
    },
  );

  test("concurrent adoption by another daemon skips row_moved", async () => {
    await cache();
    claims.beforeDescribe = async () => {
      await assignManagedSlotDevice(registry, "android", "amslot-a", "adopter");
    };
    await skip("row_moved");
  });

  test("re-freed row with another timestamp skips row_moved", async () => {
    await cache();
    claims.beforeDescribe = async () => {
      const key = await assignManagedSlotDevice(registry, "android", "amslot-a", "adopter");
      timer.advanceTime(1);
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(key.scopeKey);
    };
    await skip("row_moved");
  });

  test("re-freed row from another scope at the same timestamp skips row_moved", async () => {
    await cache();
    claims.beforeDescribe = async () => {
      const key = await assignManagedSlotDevice(registry, "android", "amslot-a", "adopter");
      await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
      await registry.completeScopeInvalidation(key.scopeKey);
    };
    await skip("row_moved");
  });

  test("missing final holder skips row_moved", async () => {
    await cache();
    await skip("row_moved", selector(), {
      listFreeDevices: () => registry.listFreeDevices(),
      listOpenSlotJournal: () => registry.listOpenSlotJournal(),
      findDeviceHolder: async () => null,
    });
  });

  test("LRU orders free and stopped devices with platform then stable-id ties", async () => {
    await cache("amslot-b");
    await cache("udid", "ios", "amslot-ios");
    await cache("amslot-a");
    timer.advanceTime(1);
    const young = await cache("amslot-young");
    const claim = { ...young, claimedBy: "stopper" };
    await registry.beginFreeDeviceStop(claim, { thresholdMs: 0 });
    await registry.completeFreeDeviceStop(claim);
    expect(
      (await selector().select(registry, {})).candidates.map((device) => device.stableDeviceId),
    ).toEqual(["amslot-a", "amslot-b", "udid", "amslot-young"]);
  });

  test("injected lastUsedAtMs overrides the persisted freed clock", async () => {
    await cache("amslot-a");
    timer.advanceTime(10);
    await cache("amslot-b");
    expect(
      (
        await selector({
          lastUsedAtMs: (row) => (row.stableDeviceId === "amslot-b" ? 0 : 20),
        }).select(registry, {})
      ).candidates.map((device) => device.stableDeviceId),
    ).toEqual(["amslot-b", "amslot-a"]);
  });

  test("valid and abandoned revivable slots are never offered", async () => {
    await assignManagedSlotDevice(registry, "android", "amslot-valid", "valid");
    const key = await assignManagedSlotDevice(registry, "ios", "amslot-kept", "abandoned");
    timer.advanceTime(1_000_000);
    expect((await registry.markScopeAbandoned(key.scopeKey, { thresholdMs: 0 })).kind).toBe(
      "marked",
    );
    expect((await registry.completeScopeInvalidation(key.scopeKey)).kind).toBe("invalidated");
    expect(await registry.listFreeDevices()).toEqual([]);
    expect(await selector().select(registry, {})).toEqual({ candidates: [], skipped: [] });
    expect(
      (await registry.snapshotManagedDevices()).map((device) => device.stableDeviceId),
    ).toEqual(["amslot-valid", "amslot-kept"]);
    expect(inventory.calls).toEqual([]);
  });

  test("inventory lists each platform once and forwards the signal", async () => {
    await cache("amslot-a");
    await cache("amslot-b");
    await cache("ios-a", "ios", "amslot-ios-a");
    await cache("ios-b", "ios", "amslot-ios-b");
    const signal = new AbortController().signal;
    expect((await selector().select(registry, { signal })).candidates).toHaveLength(4);
    expect(inventory.calls).toEqual(["android", "ios"]);
    expect(inventory.signals).toEqual([signal, signal]);
  });
});

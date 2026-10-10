import { beforeEach, describe, expect, test } from "bun:test";
import {
  managedSlotRefusal,
  RegistryManagedSlotExclusion,
} from "../../../src/daemon/managedSlots/managedSlotExclusion";
import {
  DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
  DeviceAssignedToManagedSlotError,
  MANAGED_SLOT_DISCOVERY_INCOMPLETE_CODE,
  ManagedSlotDiscoveryIncompleteError,
} from "../../../src/daemon/managedSlots/managedSlotRefusal";
import type { SlotRegistry } from "../../../src/daemon/managedSlots/slotRegistry";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

describe("RegistryManagedSlotExclusion", () => {
  let timer: FakeTimer;
  let registry: FakeSlotRegistry;
  let opens: number;

  const exclusionOver = (open: () => Promise<SlotRegistry>) =>
    new RegistryManagedSlotExclusion(open, timer);

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    registry = new FakeSlotRegistry(timer);
    opens = 0;
  });

  const openFake = async (): Promise<SlotRegistry> => {
    opens++;
    return registry;
  };

  test("holds every assigned device, idle or not, by any of its stable ids", async () => {
    const slot = await assignManagedSlotDevice(registry, "android", "slot-avd");
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();

    expect(
      exclusion.holderOf({
        platform: "android",
        stableIds: [undefined, "emulator-5554", "slot-avd"],
      }),
    ).toMatchObject({ holder: "slot", scopeKey: slot.scopeKey, slotIndex: 0 });
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["slot-avd"] })).toBeUndefined();
    expect(exclusion.holderOf({ platform: "android", stableIds: ["spare-avd"] })).toBeUndefined();
    expect([...exclusion.stableIdsFor("android")]).toEqual(["slot-avd"]);
    expect([...exclusion.stableIdsFor("ios")]).toEqual([]);
  });

  test("devices in the managed free pool stay excluded", async () => {
    const slot = await assignManagedSlotDevice(registry, "ios", "UDID-1");
    await registry.beginScopeInvalidation(slot.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(slot.scopeKey);
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();

    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toMatchObject({
      holder: "free",
      slotIndex: null,
    });
  });

  test("a registry never read refuses with a retryable discovery_incomplete, then recovers", async () => {
    let fail = true;
    const exclusion = exclusionOver(async () => {
      opens++;
      if (fail) {
        throw new Error("disk I/O error");
      }
      return registry;
    });

    const error = await exclusion.refresh().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ManagedSlotDiscoveryIncompleteError);
    expect((error as ManagedSlotDiscoveryIncompleteError).toPayload()).toEqual({
      code: MANAGED_SLOT_DISCOVERY_INCOMPLETE_CODE,
      retryable: true,
      retryAfterMs: 2_000,
    });

    fail = false;
    await assignManagedSlotDevice(registry, "ios", "UDID-1");
    await exclusion.refresh();
    expect(opens).toBe(2);
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeDefined();
  });

  test("an unreadable registry keeps the last good snapshot instead of freeing assignments", async () => {
    await assignManagedSlotDevice(registry, "ios", "UDID-1");
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();
    registry.snapshotManagedDevices = async () => {
      throw new Error("database is locked");
    };

    await exclusion.refresh();

    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeDefined();
  });

  test("maxAgeMs reuses a young snapshot; the default always re-reads", async () => {
    const exclusion = exclusionOver(openFake);
    await exclusion.refresh();
    await assignManagedSlotDevice(registry, "ios", "UDID-1");

    await exclusion.refresh({ maxAgeMs: 1_000 });
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeUndefined();

    timer.advanceTime(1_000);
    await exclusion.refresh({ maxAgeMs: 1_000 });
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-1"] })).toBeDefined();

    await assignManagedSlotDevice(registry, "ios", "UDID-2", "runner-b");
    await exclusion.refresh();
    expect(exclusion.holderOf({ platform: "ios", stableIds: ["UDID-2"] })).toBeDefined();
    expect(opens).toBe(1);
  });
});

describe("managedSlotRefusal", () => {
  test("refuses everyone but the slot's recorded execution session, with slot evidence", async () => {
    const timer = new FakeTimer();
    const registry = new FakeSlotRegistry(timer);
    const slot = await assignManagedSlotDevice(registry, "ios", "UDID-1", "runner-a", "exec-1");
    const exclusion = new RegistryManagedSlotExclusion(async () => registry, timer);
    await exclusion.refresh();
    const device = { platform: "ios" as const, stableIds: ["UDID-1"] };

    for (const requesterSessionUuid of [undefined, "generic-session"]) {
      const refusal = managedSlotRefusal(exclusion, {
        action: "killDevice",
        deviceId: "UDID-1",
        device,
        requesterSessionUuid,
      });
      expect(refusal).toBeInstanceOf(DeviceAssignedToManagedSlotError);
      expect(refusal?.toPayload()).toEqual({
        code: DEVICE_ASSIGNED_TO_MANAGED_SLOT_CODE,
        deviceId: "UDID-1",
        platform: "ios",
        stableId: "UDID-1",
        scopeKey: slot.scopeKey,
        declaredSlot: 0,
        retryable: false,
      });
    }
    expect(
      managedSlotRefusal(exclusion, {
        action: "killDevice",
        deviceId: "UDID-1",
        device,
        requesterSessionUuid: "exec-1",
      }),
    ).toBeUndefined();
    expect(
      managedSlotRefusal(undefined, { action: "killDevice", deviceId: "UDID-1", device }),
    ).toBeUndefined();
  });
});

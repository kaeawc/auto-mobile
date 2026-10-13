import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ManagedSlotJournal } from "../../../src/daemon/managedSlots/slotJournal";
import { FakeInventory, FakeClaims, FakeMatcher, FakeDeleter } from "./fixtures/reconcilerFakes";
import { assignManagedSlotDevice } from "./managedSlotFixtures";
import { describe, expect, test } from "bun:test";
import type { PooledDevice } from "../../../src/daemon/devicePool";
import {
  createDefaultFreeDeviceReclaimer,
  createAbsentRowEvictor,
  freeDeviceBusyReason,
  type FreeDeviceBusyPool,
} from "../../../src/daemon/managedSlots/defaultFreeDeviceReclaimer";

// The production isBusy of the free-pool reclaim sweep (#11337), over a pool fake.

function pooled(over: Partial<PooledDevice> = {}): PooledDevice {
  return {
    id: "emulator-5554",
    name: "Unknown (emulator-5554)",
    platform: "android",
    sessionId: null,
    status: "idle",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    avdName: "amslot-a",
    ...over,
  } as PooledDevice;
}

function poolOf(
  devices: PooledDevice[],
  over: { shutdownReserved?: boolean; startupLeased?: boolean } = {},
): FreeDeviceBusyPool {
  return {
    getAllDevices: () => devices,
    restartReservationExclusions: () => ({
      names: new Set<string>(),
      ids: new Set<string>(),
      resumeTargets: [],
    }),
    isUnderShutdownReservation: () => over.shutdownReserved === true,
    isDeviceLeasedForAndroidStartup: () => over.startupLeased === true,
  };
}

const DEVICE = { platform: "android" as const, name: "amslot-a", deviceId: "amslot-a" };

describe("freeDeviceBusyReason", () => {
  test("a quiet idle runtime, or a device with no runtime at all, is not busy", () => {
    expect(freeDeviceBusyReason(poolOf([pooled()]), DEVICE)).toBeUndefined();
    expect(freeDeviceBusyReason(poolOf([]), DEVICE)).toBeUndefined();
  });

  test("an in-flight boot or control call (non-idle runtime) is busy", () => {
    expect(freeDeviceBusyReason(poolOf([pooled({ status: "busy" })]), DEVICE)).toBe(
      "pooled runtime is busy",
    );
    expect(freeDeviceBusyReason(poolOf([pooled({ status: "error" })]), DEVICE)).toBe(
      "pooled runtime is error",
    );
  });

  test("a session on the runtime is busy", () => {
    expect(freeDeviceBusyReason(poolOf([pooled({ sessionId: "s1" })]), DEVICE)).toBe(
      "a session holds the runtime",
    );
  });

  test("a shutdown reservation (which restart recovery also takes) and a startup lease are busy", () => {
    expect(freeDeviceBusyReason(poolOf([pooled()], { shutdownReserved: true }), DEVICE)).toBe(
      "shutdown reservation",
    );
    expect(freeDeviceBusyReason(poolOf([pooled()], { startupLeased: true }), DEVICE)).toBe(
      "android startup lease",
    );
  });

  test("restart recovery reservations protect an AVD name and iOS UDID without a pooled runtime", () => {
    const pool = poolOf([]);
    pool.restartReservationExclusions = () => ({
      names: new Set(["amslot-a"]),
      ids: new Set(["UDID"]),
      resumeTargets: [],
    });
    expect(freeDeviceBusyReason(pool, DEVICE)).toBe("restart recovery reservation");
    expect(
      freeDeviceBusyReason(pool, { platform: "ios", name: "amslot-ios", deviceId: "UDID" }),
    ).toBe("restart recovery reservation");
    expect(freeDeviceBusyReason(pool, { ...DEVICE, name: "another" })).toBeUndefined();
  });

  test("another device's runtime is ignored", () => {
    expect(
      freeDeviceBusyReason(poolOf([pooled({ avdName: "other", status: "busy" })]), DEVICE),
    ).toBeUndefined();
  });
});

describe("createDefaultFreeDeviceReclaimer", () => {
  test("is not armed under bun test", () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(
      createDefaultFreeDeviceReclaimer({
        registry: async () => {
          throw new Error("must not open");
        },
        registryExists: () => false,
        pool: {} as never,
        executions: {} as never,
        timer: {} as never,
        claimedBy: "d",
      }),
    ).toBeUndefined();
  });
  test("absent-row wiring requires the acquisition journal and uses that registry", async () => {
    const timer = new FakeTimer();
    const registry = new FakeSlotRegistry(timer, () => false);
    expect(createAbsentRowEvictor(registry, undefined)).toBeUndefined();
    expect(createAbsentRowEvictor(registry, () => undefined)).toBeUndefined();
    const inventory = new FakeInventory();
    const journal = new ManagedSlotJournal({
      registry,
      timer,
      inventory,
      claims: new FakeClaims(),
      matcher: new FakeMatcher(),
      deleter: new FakeDeleter(inventory),
      owner: { daemonId: "d", pid: 1 },
      isOwnerLive: () => false,
      isExecOwnerLive: () => false,
    });
    const evictor = createAbsentRowEvictor(registry, (source) => {
      expect(source).toBe(registry);
      return journal;
    });
    const key = await assignManagedSlotDevice(registry, "android", "amslot-gone");
    await registry.beginScopeInvalidation(key.scopeKey, "operator_reset");
    await registry.completeScopeInvalidation(key.scopeKey);
    const [row] = await registry.listFreeDevices();
    expect(
      await evictor!.evict(
        {
          ...row!,
          name: row!.stableDeviceId,
          lastUsedAtMs: row!.freedAtMs,
          absent: true,
        },
        {},
      ),
    ).toEqual({ kind: "absent" });
    expect(await registry.listFreeDevices()).toEqual([]);
  });
});

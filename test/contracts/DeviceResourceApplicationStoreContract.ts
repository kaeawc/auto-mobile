import { describe, expect, test } from "bun:test";
import type {
  DeviceResourceApplicationRecord,
  SimulatorResourceIdentity,
} from "../../src/models/DeviceResourceReconciliation";
import type { DeviceResourceApplicationStore } from "../../src/utils/deviceResourceApplicationStore";

export interface DeviceResourceApplicationStoreHandle {
  store: DeviceResourceApplicationStore;
  dispose?: () => Promise<void>;
}

const identity: SimulatorResourceIdentity = {
  platform: "ios",
  udid: "12345678-1234-1234-1234-123456789ABC",
  runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
  deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
};

function record(
  overrides: Partial<DeviceResourceApplicationRecord> = {},
): DeviceResourceApplicationRecord {
  return {
    identity,
    resources: { wallpaperRendering: "disabled" },
    profileFingerprint: "fp-a",
    updatedAtMs: 1,
    ...overrides,
  };
}

/**
 * Shared behavioural contract for {@link DeviceResourceApplicationStore} (#11868): run it against
 * the in-memory fake and the SQLite repository over an in-memory database.
 */
export function runDeviceResourceApplicationStoreContract(
  name: string,
  make: () => Promise<DeviceResourceApplicationStoreHandle>,
): void {
  const withStore = async (
    body: (store: DeviceResourceApplicationStore) => Promise<void>,
  ): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.store);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`DeviceResourceApplicationStore contract: ${name}`, () => {
    test("an unknown incarnation reads as null", () =>
      withStore(async (store) => {
        expect(await store.get(identity)).toBeNull();
      }));

    test("a record round-trips", () =>
      withStore(async (store) => {
        await store.put(record({ resources: { widgets: "disabled" }, updatedAtMs: 7 }));
        expect(await store.get(identity)).toEqual(
          record({ resources: { widgets: "disabled" }, updatedAtMs: 7 }),
        );
      }));

    test("put replaces the whole record for an incarnation rather than merging", () =>
      withStore(async (store) => {
        await store.put(record({ resources: { wallpaperRendering: "disabled" } }));
        await store.put(
          record({
            resources: { widgets: "disabled" },
            profileFingerprint: "fp-b",
            updatedAtMs: 2,
          }),
        );
        expect(await store.get(identity)).toEqual(
          record({
            resources: { widgets: "disabled" },
            profileFingerprint: "fp-b",
            updatedAtMs: 2,
          }),
        );
      }));

    test("the udid, runtime and device type each distinguish an incarnation", () =>
      withStore(async (store) => {
        const otherRuntime = {
          ...identity,
          runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26",
        };
        const otherType = {
          ...identity,
          deviceTypeId: "com.apple.CoreSimulator.SimDeviceType.iPad",
        };
        const otherUdid = { ...identity, udid: "87654321-4321-4321-4321-CBA987654321" };
        await store.put(record({ identity, profileFingerprint: "base" }));
        await store.put(record({ identity: otherRuntime, profileFingerprint: "runtime" }));
        expect(await store.get(otherType)).toBeNull();
        expect(await store.get(otherUdid)).toBeNull();
        expect((await store.get(identity))?.profileFingerprint).toBe("base");
        expect((await store.get(otherRuntime))?.profileFingerprint).toBe("runtime");
      }));

    test("delete removes only the named incarnation and tolerates a missing one", () =>
      withStore(async (store) => {
        const otherRuntime = {
          ...identity,
          runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26",
        };
        await store.put(record({ identity }));
        await store.put(record({ identity: otherRuntime }));
        await store.delete(identity);
        await store.delete(identity);
        expect(await store.get(identity)).toBeNull();
        expect(await store.get(otherRuntime)).not.toBeNull();
      }));

    test("stored state is isolated from callers on both write and read", () =>
      withStore(async (store) => {
        const written = record({ resources: { widgets: "disabled" } });
        await store.put(written);
        written.resources.wallpaperRendering = "disabled";
        const first = await store.get(identity);
        expect(first?.resources).toEqual({ widgets: "disabled" });
        if (first) {
          first.resources.wallpaperRendering = "disabled";
          first.profileFingerprint = "mutated";
        }
        const second = await store.get(identity);
        expect(second?.resources).toEqual({ widgets: "disabled" });
        expect(second?.profileFingerprint).toBe("fp-a");
      }));
  });
}

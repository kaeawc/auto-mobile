import { describe, expect, test } from "bun:test";
import type { DisplayInventoryProvider } from "../../src/devices/DisplayInventoryProvider";
import { displayInventoryOutcome } from "../../src/models/DeviceInfo";
import type { BootedDevice } from "../../src/models";

export type InventoryScenario = "single" | "multi" | "unreadable";

export interface DisplayInventoryProviderContractHarness {
  provider: DisplayInventoryProvider;
  /** Scripts what the next inventory read observes; it never touches a cached entry. */
  script(scenario: InventoryScenario): void;
}

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

/**
 * Shared contract for every {@link DisplayInventoryProvider}: hydrate attaches a multi-panel
 * inventory and stamps its outcome, reads are cached per identity token, and invalidate
 * forces a re-read. Run against CachingDisplayInventoryProvider (replaying captured
 * dumpsys fixtures) and FakeDisplayInventoryProvider (issue #11868).
 */
export const runDisplayInventoryProviderContract = (
  description: string,
  make: () => DisplayInventoryProviderContractHarness,
): void => {
  describe(`DisplayInventoryProvider contract: ${description}`, function () {
    test("attaches the panels and postures of a multi-panel device", async function () {
      const { provider, script } = make();
      script("multi");

      const hydrated = await provider.hydrate(device, "boot-1");

      expect(hydrated.displays?.panels.map((panel) => panel.role)).toEqual(["inner", "cover"]);
      expect(hydrated.displays?.postures).toContain("opened");
      expect(hydrated[displayInventoryOutcome]).toEqual({ kind: "multi" });
      expect(hydrated.deviceId).toBe(device.deviceId);
      expect(hydrated.name).toBe(device.name);
    });

    test("leaves a proven single-panel device without an inventory", async function () {
      const { provider, script } = make();
      script("single");

      const hydrated = await provider.hydrate(device, "boot-1");

      expect(hydrated.displays).toBeUndefined();
      expect(hydrated[displayInventoryOutcome]).toEqual({ kind: "single" });
    });

    test("reports an unreadable inventory without attaching panels", async function () {
      const { provider, script } = make();
      script("unreadable");

      const hydrated = await provider.hydrate(device, "boot-1");

      expect(hydrated.displays).toBeUndefined();
      expect(hydrated[displayInventoryOutcome]?.kind).toBe("unreadable");
    });

    test("returns a device that already carries panels untouched", async function () {
      const { provider, script } = make();
      script("multi");
      const first = await provider.hydrate(device, "boot-1");
      script("single");

      const again = await provider.hydrate(first, "boot-2");

      expect(again).toBe(first);
    });

    test("reuses the inventory for the same identity token", async function () {
      const { provider, script } = make();
      script("single");
      await provider.hydrate(device, "boot-1");
      script("multi");

      const hydrated = await provider.hydrate(device, "boot-1");

      expect(hydrated.displays).toBeUndefined();
      expect(hydrated[displayInventoryOutcome]).toEqual({ kind: "single" });
    });

    test("a cached read still reflects the caller's current device fields", async function () {
      const { provider, script } = make();
      script("multi");
      await provider.hydrate(device, "boot-1");

      const renamed: BootedDevice = { ...device, name: "Renamed Pixel" };
      const hydrated = await provider.hydrate(renamed, "boot-1");

      expect(hydrated.name).toBe("Renamed Pixel");
      expect(hydrated.displays?.panels).toHaveLength(2);
      expect(hydrated[displayInventoryOutcome]).toEqual({ kind: "multi" });
    });

    test("re-reads when the identity token changes", async function () {
      const { provider, script } = make();
      script("single");
      await provider.hydrate(device, "boot-1");
      script("multi");

      const hydrated = await provider.hydrate(device, "boot-2");

      expect(hydrated.displays?.panels).toHaveLength(2);
    });

    test("re-reads after invalidate for that device only", async function () {
      const { provider, script } = make();
      const other: BootedDevice = { ...device, deviceId: "emulator-5556" };
      script("single");
      await provider.hydrate(device, "boot-1");
      await provider.hydrate(other, "boot-1");
      script("multi");

      provider.invalidate(device.deviceId);

      expect((await provider.hydrate(device, "boot-1")).displays?.panels).toHaveLength(2);
      expect((await provider.hydrate(other, "boot-1")).displays).toBeUndefined();
    });
  });
};

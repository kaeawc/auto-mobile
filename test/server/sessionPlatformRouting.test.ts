import { describe, expect, test } from "bun:test";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";

const devices = new Map([
  ["android-a", { deviceId: "emulator-5554", platform: "android" }],
  ["android-b", { deviceId: "emulator-5556", platform: "android" }],
  ["ios-a", { deviceId: "iphone", platform: "ios" }],
]);
const lookup = (id: string) => devices.get(id);

function acquired() {
  const binding = new SessionToolBinding();
  binding.bind(undefined, "android-a");
  binding.bind(undefined, "ios-a");
  return binding;
}

describe("connection device selectors", () => {
  test("routes each platform among acquired sessions regardless of acquisition order", () => {
    const binding = acquired();
    expect(binding.resolveDeviceSessionUuid(undefined, { platform: "android" }, lookup)).toBe(
      "android-a",
    );
    expect(binding.resolveDeviceSessionUuid(undefined, { platform: "ios" }, lookup)).toBe("ios-a");
    binding.bind(undefined, "android-a");
    expect(binding.resolveDeviceSessionUuid(undefined, { platform: "ios" }, lookup)).toBe("ios-a");
  });

  test("rejects ambiguous platform with actionable candidates", () => {
    const binding = acquired();
    binding.bind(undefined, "android-b");
    expect(() =>
      binding.resolveDeviceSessionUuid(undefined, { platform: "android" }, lookup),
    ).toThrow(/android-a.*emulator-5554.*android-b.*emulator-5556.*sessionUuid.*deviceId/);
    expect(
      binding.resolveDeviceSessionUuid(
        undefined,
        { platform: "android", deviceId: "emulator-5554" },
        lookup,
      ),
    ).toBe("android-a");
  });

  test("does not route to another platform or another connection's session", () => {
    const binding = new SessionToolBinding();
    binding.bind("one", "ios-a");
    binding.bind("two", "android-a");
    expect(() => binding.resolveDeviceSessionUuid("one", { platform: "android" }, lookup)).toThrow(
      /sessionUuid/,
    );
  });

  test("explicit session remains authoritative over platform", () => {
    const binding = acquired();
    expect(binding.resolveDeviceSessionUuid(undefined, { sessionUuid: "android-a" }, lookup)).toBe(
      "android-a",
    );
    expect(
      binding.resolveDeviceSessionUuid(
        undefined,
        { sessionUuid: "android-a", platform: "ios" },
        lookup,
      ),
    ).toBe("android-a");
    expect(binding.resolveDeviceSessionUuid(undefined, { sessionUuid: "stale" }, lookup)).toBe(
      "stale",
    );
  });

  test("released sessions are removed from candidates", () => {
    const binding = acquired();
    binding.unbindSession("android-a");
    expect(() =>
      binding.resolveDeviceSessionUuid(undefined, { platform: "android" }, lookup),
    ).toThrow(/sessionUuid/);
  });

  test("seeded connection cannot switch device", () => {
    const binding = new SessionToolBinding("ios-a");
    expect(() =>
      binding.resolveDeviceSessionUuid(undefined, { platform: "android" }, lookup),
    ).toThrow();
  });
});

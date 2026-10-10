import { describe, expect, test } from "bun:test";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";
import {
  DEVICE_OUTSIDE_BOUND_SESSION_CODE,
  DeviceOutsideBoundSessionError,
} from "../../src/server/deviceOutsideBoundSessionRefusal";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";

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

  test("lets an explicit unacquired device fall through to ordinary discovery", () => {
    const binding = new SessionToolBinding();
    binding.bind(undefined, "android-a");

    expect(
      binding.resolveDeviceSessionUuid(undefined, { deviceId: "emulator-5556" }, lookup),
    ).toBeUndefined();
  });

  test("does not route to another platform or another connection's session", () => {
    const binding = new SessionToolBinding();
    binding.bind("one", "ios-a");
    binding.bind("two", "android-a");
    // The connection holds nothing for android: fall through, never borrow another's (#11193).
    expect(
      binding.resolveDeviceSessionUuid("one", { platform: "android" }, lookup),
    ).toBeUndefined();
  });

  test("a platform with no matching acquired session falls through instead of throwing (#11193)", () => {
    const binding = new SessionToolBinding();
    binding.bind(undefined, "android-a");
    expect(
      binding.resolveDeviceSessionUuid(undefined, { platform: "ios" }, lookup),
    ).toBeUndefined();
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
    expect(
      binding.resolveDeviceSessionUuid(undefined, { platform: "android" }, lookup),
    ).toBeUndefined();
  });

  test("seeded connection cannot switch device, and the refusal is typed with a next step (#11274)", () => {
    const binding = new SessionToolBinding("ios-a");
    const refusal = (params: Record<string, unknown>) => {
      try {
        binding.resolveDeviceSessionUuid(undefined, params, lookup);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    for (const params of [{ platform: "android" }, { deviceId: "emulator-5554" }]) {
      const error = refusal(params);
      expect(error).toBeInstanceOf(DeviceOutsideBoundSessionError);
      expect(error).toMatchObject({ code: DEVICE_OUTSIDE_BOUND_SESSION_CODE, retryable: false });
      expect((error as Error).message).toContain("separate MCP connection");
      const wire = JSON.parse(
        shapeToolCallError(error, { toolName: "tapOn", source: "MCP" }).content[0].text,
      );
      expect(wire).toMatchObject({
        success: false,
        code: DEVICE_OUTSIDE_BOUND_SESSION_CODE,
        boundSessionUuid: "ios-a",
        boundDeviceId: "iphone",
        retryable: false,
      });
    }
  });
});

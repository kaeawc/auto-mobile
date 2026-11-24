import { describe, expect, test } from "bun:test";
import {
  hasDefinedRequirement,
  keepsPhoneDefault,
  sessionHeldAndroidDevice,
  type SessionDeviceSource,
} from "../../../../src/features/deviceLifecycle/boot/bareAndroidSelection";
import { getAndroidSchema } from "../../../../src/features/deviceLifecycle/core/schemas";
import type { BootedDevice } from "../../../../src/models";

describe("hasDefinedRequirement (#19153)", () => {
  test("counts only keys whose value is defined", () => {
    expect(hasDefinedRequirement(undefined)).toBe(false);
    expect(hasDefinedRequirement({})).toBe(false);
    expect(hasDefinedRequirement({ playStore: undefined })).toBe(false);
    expect(hasDefinedRequirement({ playStore: false })).toBe(true);
  });

  test("an undefined key that schema parsing keeps sets no requirement", () => {
    const args = getAndroidSchema.parse({ requires: { playStore: undefined } });
    expect(hasDefinedRequirement(args.requires)).toBe(false);
    expect(keepsPhoneDefault(args.requires)).toBe(true);
  });
});

describe("keepsPhoneDefault (#19153)", () => {
  test("keeps the phone for requirements a phone meets", () => {
    expect(keepsPhoneDefault(undefined)).toBe(true);
    expect(keepsPhoneDefault({ playStore: true })).toBe(true);
    expect(keepsPhoneDefault({ panels: 1 })).toBe(true);
    expect(keepsPhoneDefault({ vehicle: {} })).toBe(true);
    expect(keepsPhoneDefault({ screenRound: undefined, posture: undefined })).toBe(true);
  });

  test("drops the phone for requirements only another form factor meets", () => {
    expect(keepsPhoneDefault({ panels: 2 })).toBe(false);
    expect(keepsPhoneDefault({ posture: "half_opened" })).toBe(false);
    expect(keepsPhoneDefault({ screenRound: false })).toBe(false);
    expect(keepsPhoneDefault({ playStore: true, vehicle: { motion: "supported" } })).toBe(false);
  });
});

function sessionSource(
  session: { assignedDevice: string; platform: "android" | "ios" } | null,
  initialized = true,
): SessionDeviceSource {
  return {
    isInitialized: () => initialized,
    getSessionManager: () => ({ findSession: () => session }),
  };
}

const booted = (deviceId: string): BootedDevice => ({
  platform: "android",
  name: deviceId,
  deviceId,
});

describe("sessionHeldAndroidDevice (#19153)", () => {
  test("returns the session's booted Android device", async () => {
    const result = await sessionHeldAndroidDevice(
      "s1",
      sessionSource({ assignedDevice: "emulator-5556", platform: "android" }),
      async () => [booted("emulator-5554"), booted("emulator-5556")],
    );
    expect(result).toBe("emulator-5556");
  });

  test("ignores a session device that is no longer booted", async () => {
    const result = await sessionHeldAndroidDevice(
      "s1",
      sessionSource({ assignedDevice: "emulator-5556", platform: "android" }),
      async () => [booted("emulator-5554")],
    );
    expect(result).toBeUndefined();
  });

  test("ignores no session, an iOS session and an uninitialized daemon", async () => {
    let listed = 0;
    const list = async () => {
      listed += 1;
      return [booted("emulator-5554")];
    };
    const held = { assignedDevice: "emulator-5554", platform: "android" as const };
    expect(await sessionHeldAndroidDevice(undefined, sessionSource(held), list)).toBeUndefined();
    expect(await sessionHeldAndroidDevice("s1", sessionSource(null), list)).toBeUndefined();
    expect(
      await sessionHeldAndroidDevice(
        "s1",
        sessionSource({ assignedDevice: "UDID", platform: "ios" }),
        list,
      ),
    ).toBeUndefined();
    expect(await sessionHeldAndroidDevice("s1", sessionSource(held, false), list)).toBeUndefined();
    expect(listed).toBe(0);
  });

  test("falls back to selection when discovery fails", async () => {
    const result = await sessionHeldAndroidDevice(
      "s1",
      sessionSource({ assignedDevice: "emulator-5556", platform: "android" }),
      async () => {
        throw new Error("adb unavailable");
      },
    );
    expect(result).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  BIOMETRIC_ENROLLMENT_FAULT_KEY,
  createBiometricEnrollmentInjector,
  resolveBiometricEnrollmentInjector,
} from "../../../src/features/deviceCondition/biometricEnrollmentInjector";
import type { FingerprintEnrollmentPort } from "../../../src/features/deviceCondition/fingerprintEnrollmentPort";
import { DeviceConditionController } from "../../../src/features/deviceCondition/DeviceConditionController";
import { deviceConditionInputSchema } from "../../../src/features/deviceCondition/DeviceConditionTypes";
import { OwedResetError } from "../../../src/features/deviceCondition/OwedResetError";
import type { DeviceConditionInjector } from "../../../src/features/deviceCondition/DeviceConditionController";
import { FakeLogger } from "../../fakes/FakeLogger";

/** An emulator's lock screen and fingerprint enrollments, as the port exposes them. */
class FakeFingerprintDevice implements FingerprintEnrollmentPort {
  emulator = true;
  console = true;
  credential: "test" | "other" | undefined;
  count = 0;
  failEnroll = false;
  enrolledIds: number[] = [];
  calls: string[] = [];

  async isEmulator(): Promise<boolean> {
    return this.emulator;
  }
  async consoleSupportsFinger(): Promise<boolean> {
    return this.console;
  }
  async enrolledCount(): Promise<number> {
    return this.count;
  }
  async hasCredential(): Promise<boolean> {
    return this.credential !== undefined;
  }
  async testPinVerifies(): Promise<boolean> {
    return this.credential === "test";
  }
  async setTestPin(): Promise<void> {
    this.calls.push("setTestPin");
    this.credential = "test";
  }
  async clearTestPin(): Promise<void> {
    this.calls.push("clearTestPin");
    // Android deletes every fingerprint with the credential.
    this.credential = undefined;
    this.count = 0;
  }
  async enrollFingerprint(fingerId: number, targetCount: number): Promise<void> {
    this.calls.push(`enroll ${fingerId}`);
    if (this.failEnroll) {
      throw new Error("Settings screen not recognized");
    }
    this.enrolledIds.push(fingerId);
    this.count = targetCount;
  }
}

const controllerFor = (device: FakeFingerprintDevice) => {
  const injector = createBiometricEnrollmentInjector(device);
  return new DeviceConditionController(
    (key) => (key === BIOMETRIC_ENROLLMENT_FAULT_KEY ? injector : undefined),
    new FakeLogger(),
  );
};

describe("faults.biometricEnrollment", () => {
  test("the first add sets the test PIN and enrolls; reset clears both", async () => {
    const device = new FakeFingerprintDevice();
    const controller = controllerFor(device);

    const applied = await controller.apply({ faults: { biometricEnrollment: "add" } });

    expect(applied.changes[0]).toMatchObject({ status: "applied" });
    expect(device.calls).toEqual(["setTestPin", "enroll 1"]);
    expect(device.count).toBe(1);

    const restore = await controller.restore();
    expect(restore).toMatchObject({ verifiedClean: true, failures: [] });
    expect(device.credential).toBeUndefined();
    expect(device.count).toBe(0);
  });

  test("a second add enrolls a new finger id under the same PIN, invalidating enrollment-bound keys", async () => {
    const device = new FakeFingerprintDevice();
    const controller = controllerFor(device);

    await controller.apply({ faults: { biometricEnrollment: "add" } });
    const second = await controller.apply({ faults: { biometricEnrollment: "add" } });

    expect(second.changes[0].detail).toContain("finger id 2; 2 enrolled");
    expect(device.enrolledIds).toEqual([1, 2]);
    expect(device.calls.filter((call) => call === "setTestPin")).toHaveLength(1);

    const cleared = await controller.apply({ faults: { biometricEnrollment: "unset" } });
    expect(cleared.changes[0]).toMatchObject({ status: "cleared" });
    expect(device.calls.filter((call) => call === "clearTestPin")).toHaveLength(1);
    expect(device.count).toBe(0);
    expect(cleared.active).toEqual([]);
  });

  test("none removes every fingerprint the condition added", async () => {
    const device = new FakeFingerprintDevice();
    const controller = controllerFor(device);
    await controller.apply({ faults: { biometricEnrollment: "add" } });

    const removed = await controller.apply({ faults: { biometricEnrollment: "none" } });

    expect(removed.changes[0]).toMatchObject({ status: "applied" });
    expect(device.count).toBe(0);
    expect(device.credential).toBeUndefined();
    expect(await controller.restore()).toMatchObject({ verifiedClean: true });
  });

  test("none is unchanged with nothing enrolled and refused for fingerprints it did not add", async () => {
    const device = new FakeFingerprintDevice();
    const injector = createBiometricEnrollmentInjector(device);
    expect(await injector.apply("none")).toMatchObject({ status: "unchanged" });

    device.credential = "other";
    device.count = 1;
    await expect(injector.apply("none")).rejects.toThrow(/not added by faults.biometricEnrollment/);
    expect(device.calls).toEqual([]);
  });

  test("refuses a physical device without touching it", async () => {
    const device = new FakeFingerprintDevice();
    device.emulator = false;
    await expect(createBiometricEnrollmentInjector(device).apply("add")).rejects.toThrow(
      /needs an Android emulator/,
    );
    expect(device.calls).toEqual([]);
  });

  test("refuses when the emulator console is unavailable", async () => {
    const device = new FakeFingerprintDevice();
    device.console = false;
    await expect(createBiometricEnrollmentInjector(device).apply("add")).rejects.toThrow(
      /emulator console is unavailable/,
    );
    expect(device.calls).toEqual([]);
  });

  test("refuses a lock screen it did not set, since it could not restore it", async () => {
    const device = new FakeFingerprintDevice();
    device.credential = "other";
    await expect(createBiometricEnrollmentInjector(device).apply("add")).rejects.toThrow(
      /already has a lock screen/,
    );
    expect(device.calls).toEqual([]);
  });

  test("refuses a sixth fingerprint", async () => {
    const device = new FakeFingerprintDevice();
    device.credential = "test";
    device.count = 5;
    await expect(createBiometricEnrollmentInjector(device).apply("add")).rejects.toThrow(
      /at most 5/,
    );
  });

  test("a failed enrollment keeps the reset owed so release clears the PIN", async () => {
    const device = new FakeFingerprintDevice();
    device.failEnroll = true;
    const error = await createBiometricEnrollmentInjector(device)
      .apply("add")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OwedResetError);
    expect(device.credential).toBe("test");

    const other = new FakeFingerprintDevice();
    other.failEnroll = true;
    const controller = controllerFor(other);
    const result = await controller.apply({ faults: { biometricEnrollment: "add" } });
    expect(result.changes[0]).toMatchObject({ status: "unsupported" });
    expect(result.active).toEqual([BIOMETRIC_ENROLLMENT_FAULT_KEY]);
    expect(await controller.restore()).toMatchObject({ verifiedClean: true });
    expect(other.credential).toBeUndefined();
  });

  test("reset reports a credential that survives clearing the PIN", async () => {
    const device = new FakeFingerprintDevice();
    const controller = controllerFor(device);
    await controller.apply({ faults: { biometricEnrollment: "add" } });
    device.clearTestPin = async () => {
      device.credential = "other";
    };

    const restore = await controller.restore();

    expect(restore.verifiedClean).toBe(false);
    expect(restore.failures[0].error).toContain("did not remove the lock-screen credential");
  });

  test("rejects an unknown value", async () => {
    await expect(
      createBiometricEnrollmentInjector(new FakeFingerprintDevice()).apply("on"),
    ).rejects.toThrow(/Expected one of: add, none/);
  });

  test("the request schema accepts add, none and unset only", () => {
    for (const value of ["add", "none", "unset"]) {
      expect(
        deviceConditionInputSchema.safeParse({ faults: { biometricEnrollment: value } }).success,
      ).toBe(true);
    }
    expect(
      deviceConditionInputSchema.safeParse({ faults: { biometricEnrollment: "remove" } }).success,
    ).toBe(false);
  });

  test("resolves only for Android and its own key, caching per device", () => {
    const android: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "e" };
    const ios: BootedDevice = { deviceId: "sim", platform: "ios", name: "s" };
    const cache = new Map<string, DeviceConditionInjector>();
    const deps = { cache, portFactory: () => new FakeFingerprintDevice() };

    const injector = resolveBiometricEnrollmentInjector(
      android,
      BIOMETRIC_ENROLLMENT_FAULT_KEY,
      deps,
    );
    expect(injector?.key).toBe(BIOMETRIC_ENROLLMENT_FAULT_KEY);
    expect(resolveBiometricEnrollmentInjector(android, BIOMETRIC_ENROLLMENT_FAULT_KEY, deps)).toBe(
      injector,
    );
    expect(resolveBiometricEnrollmentInjector(ios, BIOMETRIC_ENROLLMENT_FAULT_KEY, deps)).toBe(
      undefined,
    );
    expect(resolveBiometricEnrollmentInjector(android, "faults.lockScreen", deps)).toBe(undefined);
  });
});

import { describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  applyStateAfterBiometricCaptureFailure,
  runSessionBiometricMutation,
} from "../../src/server/sessionBiometricEnrollment";
import type {
  DeviceStateResult,
  SetDeviceStateInput,
} from "../../src/features/utility/DeviceState";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

describe("runSessionBiometricMutation", () => {
  test("publishes enrollment before a tracked mutation and restores after it settles", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => {} }),
      () => ({ restore: async (enrollment) => restored.push(enrollment) }),
    );
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    try {
      await manager.createSession("session-1", "sim-1", "ios");
      const mutation = runSessionBiometricMutation(
        manager,
        "session-1",
        "sim-1",
        "not_enrolled",
        async () => {
          started.resolve();
          await finished.promise;
          return "changed";
        },
      );
      await started.promise;

      const release = manager.releaseSession("session-1");
      expect(restored).toEqual([]);

      finished.resolve();
      await expect(mutation).resolves.toBe("changed");
      await release;

      expect(restored).toEqual(["not_enrolled"]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("does not mutate an old simulator after the session rebinds", async () => {
    const manager = new SessionManager(
      new FakeTimer(),
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    let mutationStarted = false;
    try {
      await manager.createSession("session-1", "sim-a", "ios");
      await manager.rebindSession("session-1", "sim-b", "ios");

      await expect(
        runSessionBiometricMutation(manager, "session-1", "sim-a", "enrolled", async () => {
          mutationStarted = true;
        }),
      ).rejects.toThrow("bound to sim-b, not sim-a");

      expect(mutationStarted).toBe(false);
      expect(manager.getBiometricEnrollment("session-1")).toBeUndefined();
    } finally {
      manager.stopCleanupTimer();
    }
  });
});

describe("applyStateAfterBiometricCaptureFailure", () => {
  const failure: DeviceStateResult = {
    success: false,
    deviceId: "emulator-5554",
    platform: "android",
    biometrics: { supported: false, error: "iOS Simulator biometrics are unsupported" },
    error: "iOS Simulator biometrics are unsupported",
  };

  const setterReturning = (result: DeviceStateResult) => {
    const inputs: SetDeviceStateInput[] = [];
    return {
      inputs,
      setState: async (input: SetDeviceStateInput) => {
        inputs.push(input);
        return result;
      },
    };
  };

  test("applies the independent Do Not Disturb field and keeps the biometric failure", async () => {
    const setter = setterReturning({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      doNotDisturb: { supported: true, enabled: true, mode: "priority" },
    });

    const result = await applyStateAfterBiometricCaptureFailure(
      setter,
      { doNotDisturb: { mode: "priority" }, biometrics: { enrollment: "enrolled" } },
      failure,
    );

    expect(setter.inputs).toEqual([{ doNotDisturb: { mode: "priority" } }]);
    expect(result.doNotDisturb).toEqual({ supported: true, enabled: true, mode: "priority" });
    expect(result.biometrics).toEqual(failure.biometrics);
    expect(result.success).toBe(false);
    expect(result.error).toBe("iOS Simulator biometrics are unsupported");
  });

  test("reports both failures when the sibling field also fails", async () => {
    const setter = setterReturning({
      success: false,
      deviceId: "emulator-5554",
      platform: "android",
      doNotDisturb: { supported: false },
      error: "DND unsupported",
    });

    const result = await applyStateAfterBiometricCaptureFailure(
      setter,
      { doNotDisturb: { enabled: true }, biometrics: { enrollment: "enrolled" } },
      failure,
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("iOS Simulator biometrics are unsupported; DND unsupported");
  });

  test("forwards networkCondition after a biometric capture failure (#6012 review)", async () => {
    const setter = setterReturning({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
      networkCondition: { supported: true, capability: "partial", appliedProfile: "3g" },
    });

    const result = await applyStateAfterBiometricCaptureFailure(
      setter,
      { networkCondition: { profile: "3g" }, biometrics: { enrollment: "enrolled" } },
      failure,
    );

    // The network mutation is applied, not silently dropped.
    expect(setter.inputs).toEqual([{ networkCondition: { profile: "3g" } }]);
    expect(result.networkCondition).toEqual({
      supported: true,
      capability: "partial",
      appliedProfile: "3g",
    });
    expect(result.biometrics).toEqual(failure.biometrics);
    expect(result.success).toBe(false);
  });

  test("returns the biometric failure untouched when nothing else was requested", async () => {
    const setter = setterReturning({
      success: true,
      deviceId: "emulator-5554",
      platform: "android",
    });

    const result = await applyStateAfterBiometricCaptureFailure(
      setter,
      { biometrics: { enrollment: "enrolled" } },
      failure,
    );

    expect(setter.inputs).toEqual([]);
    expect(result).toBe(failure);
  });
});

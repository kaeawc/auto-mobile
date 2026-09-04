import { describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runSessionNetworkMutation } from "../../src/server/sessionNetworkCondition";
import { applyStateAfterBiometricCaptureFailure } from "../../src/server/sessionBiometricEnrollment";
import type { DeviceStateResult } from "../../src/features/utility/DeviceState";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";

describe("runSessionNetworkMutation", () => {
  const makeManager = (timer: FakeTimer, restored: string[]) =>
    new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => {} }),
      () => ({ restore: async () => {} }),
      () => ({ restore: async (profile) => restored.push(profile) }),
    );

  test("registers the restore slot before a tracked mutation and restores after release", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    try {
      await manager.createSession("net-1", "emulator-5554", "android");
      const mutation = runSessionNetworkMutation(
        manager,
        "net-1",
        "emulator-5554",
        true,
        async () => {
          started.resolve();
          await finished.promise;
          return "shaped";
        },
      );
      await started.promise;

      // The slot is published before the mutation completes, so a release that
      // begins now already knows the device must be restored.
      expect(manager.getNetworkCondition("net-1")).toEqual({ initialProfile: "none" });

      const release = manager.releaseSession("net-1");
      // The tracked mutation is awaited by release, so no restore has run yet.
      expect(restored).toEqual([]);

      finished.resolve();
      await expect(mutation).resolves.toBe("shaped");
      await release;

      expect(restored).toEqual(["none"]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("registers the slot for an override-only degrade (#6012 review P1)", async () => {
    // The handler passes registerRestore=true for an override-only request, so
    // this asserts the slot is recorded even though no named profile was set.
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-override", "emulator-5554", "android");
      await runSessionNetworkMutation(
        manager,
        "net-override",
        "emulator-5554",
        true,
        async () => {},
      );
      expect(manager.getNetworkCondition("net-override")).toEqual({ initialProfile: "none" });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("does not register a slot when the request does not degrade", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-reset", "emulator-5554", "android");
      await runSessionNetworkMutation(manager, "net-reset", "emulator-5554", false, async () => {});
      expect(manager.getNetworkCondition("net-reset")).toBeUndefined();
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("does not shape an old device after the session rebinds", async () => {
    const manager = new SessionManager(
      new FakeTimer(),
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    let mutationStarted = false;
    try {
      await manager.createSession("net-rebind", "emulator-5554", "android");
      await manager.rebindSession("net-rebind", "emulator-5556", "android");

      await expect(
        runSessionNetworkMutation(manager, "net-rebind", "emulator-5554", true, async () => {
          mutationStarted = true;
        }),
      ).rejects.toThrow("bound to emulator-5556, not emulator-5554");

      expect(mutationStarted).toBe(false);
      expect(manager.getNetworkCondition("net-rebind")).toBeUndefined();
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("the biometric-capture-failure fallback registers the slot via the tracked setter (#6012 review P1)", async () => {
    // The handler wraps its setter in runSessionNetworkMutation, then hands that
    // tracked setter to applyStateAfterBiometricCaptureFailure. This composes the
    // two to prove the fallback registers the restore slot (previously it applied
    // networkCondition directly and leaked).
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-fallback", "emulator-5554", "android");
      const applied: DeviceStateResult = {
        success: true,
        deviceId: "emulator-5554",
        platform: "android",
        networkCondition: { supported: true, capability: "partial", appliedProfile: "3g" },
      };
      const trackedSetter = (input: { networkCondition?: unknown }) =>
        input.networkCondition
          ? runSessionNetworkMutation(
              manager,
              "net-fallback",
              "emulator-5554",
              true,
              async () => applied,
            )
          : Promise.resolve(applied);

      const failure: DeviceStateResult = {
        success: false,
        deviceId: "emulator-5554",
        platform: "android",
        biometrics: { supported: false, error: "biometrics unsupported on Android" },
        error: "biometrics unsupported on Android",
      };
      await applyStateAfterBiometricCaptureFailure(
        { setState: trackedSetter },
        { networkCondition: { profile: "3g" }, biometrics: { enrollment: "enrolled" } },
        failure,
      );

      expect(manager.getNetworkCondition("net-fallback")).toEqual({ initialProfile: "none" });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("runs the mutation untracked when there is no session", async () => {
    let ran = false;
    const result = await runSessionNetworkMutation(
      undefined,
      undefined,
      "emulator-5554",
      true,
      async () => {
        ran = true;
        return 42;
      },
    );
    expect(ran).toBe(true);
    expect(result).toBe(42);
  });
});

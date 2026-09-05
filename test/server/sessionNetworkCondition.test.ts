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

  test("schedules a per-condition TTL for a degrade carrying expiresInSeconds (#6085)", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-ttl-wire", "emulator-5554", "android");
      await runSessionNetworkMutation(
        manager,
        "net-ttl-wire",
        "emulator-5554",
        true,
        async () => {},
        30,
      );

      // The TTL fires after 30s and resets the device to `none`.
      timer.advanceTime(30_000);
      await manager.getPendingDeviceCleanup("emulator-5554");
      expect(restored).toEqual(["none"]);
      expect(manager.getNetworkCondition("net-ttl-wire")).toBeUndefined();
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("a later reset cancels a pending TTL rather than racing it (#6085)", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-ttl-cancel", "emulator-5554", "android");
      // Degrade with a TTL, then a manual reset (registerRestore=false) before it fires.
      await runSessionNetworkMutation(
        manager,
        "net-ttl-cancel",
        "emulator-5554",
        true,
        async () => {},
        30,
      );
      await runSessionNetworkMutation(
        manager,
        "net-ttl-cancel",
        "emulator-5554",
        false,
        async () => {},
      );

      // The reset cancelled the timer, so advancing past the TTL fires no restore.
      timer.advanceTime(60_000);
      expect(manager.getPendingDeviceCleanup("emulator-5554")).toBeNull();
      expect(restored).toEqual([]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("cancels the prior TTL before a slow re-apply so it cannot clear the freshly-shaped slot (#6085 review)", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    try {
      await manager.createSession("net-reapply", "emulator-5554", "android");
      // First apply arms a 30s TTL.
      await runSessionNetworkMutation(
        manager,
        "net-reapply",
        "emulator-5554",
        true,
        async () => {},
        30,
      );

      // A slow re-apply begins; its tracked mutation blocks partway through.
      const reapply = runSessionNetworkMutation(
        manager,
        "net-reapply",
        "emulator-5554",
        true,
        async () => {
          started.resolve();
          await finished.promise;
        },
        30,
      );
      await started.promise;

      // The prior TTL was cancelled BEFORE the mutation ran, so advancing past its
      // original deadline while the re-apply is still in flight fires NO restore —
      // the freshly-published slot is not cleared out from under the re-apply.
      timer.advanceTime(60_000);
      expect(restored).toEqual([]);
      expect(manager.getNetworkCondition("net-reapply")).toEqual({ initialProfile: "none" });

      finished.resolve();
      await reapply;

      // The new TTL is armed only after the mutation settled, and fires on its own clock.
      timer.advanceTime(30_000);
      await manager.getPendingDeviceCleanup("emulator-5554");
      expect(restored).toEqual(["none"]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("preserves the original TTL deadline when a manual reset fails (#6178 item 1)", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-reset-fail", "emulator-5554", "android");
      // Timed degrade arms a 30s TTL.
      await runSessionNetworkMutation(
        manager,
        "net-reset-fail",
        "emulator-5554",
        true,
        async () => {},
        30,
      );

      // 10s elapse, then a manual reset (registerRestore=false) whose emulator
      // command fails — DeviceState resolves this as `success: false`, not a throw.
      timer.advanceTime(10_000);
      const resetResult = await runSessionNetworkMutation(
        manager,
        "net-reset-fail",
        "emulator-5554",
        false,
        async () => ({ success: false, deviceId: "emulator-5554", platform: "android" }),
      );
      expect(resetResult).toEqual({
        success: false,
        deviceId: "emulator-5554",
        platform: "android",
      });

      // The failed reset must not have cancelled the original degrade's TTL: it
      // still fires at its ORIGINAL deadline (20s of its 30s remain), not never
      // and not from a fresh 30s.
      timer.advanceTime(19_000);
      expect(restored).toEqual([]);
      timer.advanceTime(1_000);
      await manager.getPendingDeviceCleanup("emulator-5554");
      expect(restored).toEqual(["none"]);
      expect(manager.getNetworkCondition("net-reset-fail")).toBeUndefined();
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("preserves the original TTL deadline when a manual reset throws (#6178 item 1)", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-reset-throw", "emulator-5554", "android");
      await runSessionNetworkMutation(
        manager,
        "net-reset-throw",
        "emulator-5554",
        true,
        async () => {},
        30,
      );

      timer.advanceTime(10_000);
      await expect(
        runSessionNetworkMutation(manager, "net-reset-throw", "emulator-5554", false, async () => {
          throw new Error("emulator console rejected reset");
        }),
      ).rejects.toThrow("emulator console rejected reset");

      timer.advanceTime(20_000);
      await manager.getPendingDeviceCleanup("emulator-5554");
      expect(restored).toEqual(["none"]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("B's late failed re-apply does not re-arm A's TTL over C's live TTL (#6178 PR #6183 review, P1)", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    const startedB = Promise.withResolvers<void>();
    const finishedB = Promise.withResolvers<void>();
    try {
      await manager.createSession("net-overlap", "emulator-5554", "android");

      // A: timed degrade, 30s TTL.
      await runSessionNetworkMutation(
        manager,
        "net-overlap",
        "emulator-5554",
        true,
        async () => {},
        30,
      );

      // B: a slow re-apply that will eventually fail. Its tracked mutation blocks
      // partway through, snapshotting and cancelling A's TTL before it does.
      const mutationB = runSessionNetworkMutation(
        manager,
        "net-overlap",
        "emulator-5554",
        true,
        async () => {
          startedB.resolve();
          await finishedB.promise;
          return { success: false, deviceId: "emulator-5554", platform: "android" as const };
        },
        40,
      );
      await startedB.promise;

      // C: arrives while B is still in flight and applies successfully with its
      // own 50s TTL — this bumps the generation counter past B's.
      await runSessionNetworkMutation(
        manager,
        "net-overlap",
        "emulator-5554",
        true,
        async () => {},
        50,
      );

      // B now settles as a failure. Its attempt to re-arm A's original deadline
      // must be skipped: the generation has moved on to C, so B's stale snapshot
      // must neither resurrect A's deadline nor clobber C's live timer.
      finishedB.resolve();
      await mutationB;

      // A's original 30s deadline passes and fires nothing.
      timer.advanceTime(30_000);
      expect(restored).toEqual([]);

      // C's own 50s TTL still fires on schedule and restores.
      timer.advanceTime(20_000);
      await manager.getPendingDeviceCleanup("emulator-5554");
      expect(restored).toEqual(["none"]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("a failed re-apply restores the prior deadline and does not arm a fresh TTL of its own (#6178 PR #6183 review, P2)", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-reapply-fail", "emulator-5554", "android");
      // A: 30s TTL.
      await runSessionNetworkMutation(
        manager,
        "net-reapply-fail",
        "emulator-5554",
        true,
        async () => {},
        30,
      );

      timer.advanceTime(10_000);

      // A failing re-apply that ALSO carries its own (very different) TTL. If the
      // failure path fell through to schedule a fresh TTL for it, the device
      // would instead be reset ~999s from now rather than at the ORIGINAL
      // 20s-remaining deadline.
      const result = await runSessionNetworkMutation(
        manager,
        "net-reapply-fail",
        "emulator-5554",
        true,
        async () => ({ success: false, deviceId: "emulator-5554", platform: "android" as const }),
        999,
      );
      expect(result.success).toBe(false);

      // The ORIGINAL deadline (20s remaining) fires — not a fresh 999s TTL from
      // the failed re-apply, and not never.
      timer.advanceTime(19_000);
      expect(restored).toEqual([]);
      timer.advanceTime(1_000);
      await manager.getPendingDeviceCleanup("emulator-5554");
      expect(restored).toEqual(["none"]);
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("a combined request where DND fails but networkCondition succeeds is not treated as a network failure (#6178 PR #6183 review, P3)", async () => {
    const timer = new FakeTimer();
    const restored: string[] = [];
    const manager = makeManager(timer, restored);
    try {
      await manager.createSession("net-combined", "emulator-5554", "android");
      // A: 30s TTL.
      await runSessionNetworkMutation(
        manager,
        "net-combined",
        "emulator-5554",
        true,
        async () => {},
        30,
      );

      timer.advanceTime(10_000);

      // A combined request with NO TTL of its own: the TOP-LEVEL aggregate is
      // success:false because DND failed, but the networkCondition sub-result
      // applied cleanly. (No expiresInSeconds is deliberate: it isolates this
      // case from the #6178 item 2 fix — a wrongly-triggered rearm is the ONLY
      // thing that could still fire below.)
      const combined: DeviceStateResult = {
        success: false,
        deviceId: "emulator-5554",
        platform: "android",
        doNotDisturb: { supported: true, enabled: false, error: "DND toggle rejected" },
        networkCondition: { supported: true, capability: "partial", appliedProfile: "3g" },
        error: "DND toggle rejected",
      };
      const result = await runSessionNetworkMutation(
        manager,
        "net-combined",
        "emulator-5554",
        true,
        async () => combined,
      );
      expect(result).toEqual(combined);

      // The network mutation is judged a SUCCESS from its own sub-result, so A's
      // original TTL is correctly retired (not revived) — and since this request
      // carried no TTL of its own, nothing is ever scheduled to fire again.
      timer.advanceTime(1_000_000);
      expect(restored).toEqual([]);
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

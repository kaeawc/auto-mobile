import { expect, spyOn, test } from "bun:test";
import { SessionManager, SESSION_RELEASE_TEARDOWN_CAP_MS } from "../../src/daemon/sessionManager";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

for (const reason of ["keep-screen-awake", "biometric-enrollment", "network-condition"] as const) {
  test(`${reason}: capped release and late retry give-ups restore one saved baseline`, async () => {
    const timer = new FakeTimer();
    const initial = Promise.withResolvers<void>();
    const recovery = Promise.withResolvers<void>();
    const writes: unknown[] = [];
    let recovering = false;
    let restored: unknown;
    const restore = async (baseline: unknown) => {
      writes.push(baseline);
      if (writes.length === 1) {
        await initial.promise;
      } else if (recovering) {
        await recovery.promise;
        restored = baseline;
      } else {
        throw new Error("bounded retry failed");
      }
    };
    const manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      () => ({
        restore: async (state) => {
          await restore(state);
          return { status: "restored" as const };
        },
      }),
      () => ({ restore }),
      { networkCondition: () => ({ restore }) },
    );
    manager.stopCleanupTimer();
    const markers = new InMemoryDeviceHealthMarkers(timer);
    manager.setDeviceHealthMarkers(
      markers,
      () => 1,
      () => true,
    );
    const mark = spyOn(markers, "mark");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const step = async (ms: number) => {
      await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
      await drainUntilQuiescent(timer);
    };
    const awake = { applied: true, method: "svc" as const, svcWasEnabled: false };
    const baseline =
      reason === "keep-screen-awake"
        ? awake
        : reason === "biometric-enrollment"
          ? "not_enrolled"
          : "none";
    try {
      await manager.createSession("owner", "fake-device", "android");
      if (reason === "keep-screen-awake") {
        manager.setKeepScreenAwake("owner", awake);
      } else if (reason === "biometric-enrollment") {
        manager.setBiometricEnrollment("owner", { initialEnrollment: "not_enrolled" });
      } else {
        manager.setNetworkCondition("owner", { initialProfile: "none" });
      }
      const release = manager.releaseSession("owner");
      await step(0);
      await step(SESSION_RELEASE_TEARDOWN_CAP_MS);
      await release;
      expect(markers.get("fake-device", 1, reason)).toBeDefined();
      expect(manager.getDeviceHealthRecovery("fake-device", 1, reason).recovering).toBe(true);
      initial.reject(new Error("initial restore failed late"));
      await step(0);
      await step(250);
      await step(250);
      expect(mark.mock.calls.filter(([, , markedReason]) => markedReason === reason)).toHaveLength(
        2,
      );
      expect(manager.getDeviceHealthRecovery("fake-device", 1, reason).recovering).toBe(true);
      recovering = true;
      await step(500);
      expect(restored).toBeUndefined();
      expect(markers.get("fake-device", 1, reason)).toBeDefined();
      recovery.resolve();
      await step(0);
      expect(writes).toEqual([baseline, baseline, baseline, baseline]);
      expect(restored).toEqual(baseline);
      expect(markers.get("fake-device", 1, reason)).toBeUndefined();
    } finally {
      initial.resolve();
      recovery.resolve();
      manager.stopCleanupTimer();
      timer.reset();
      mark.mockRestore();
      warn.mockRestore();
    }
  });
}

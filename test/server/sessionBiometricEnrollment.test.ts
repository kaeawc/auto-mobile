import { describe, expect, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runSessionBiometricMutation } from "../../src/server/sessionBiometricEnrollment";
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
});

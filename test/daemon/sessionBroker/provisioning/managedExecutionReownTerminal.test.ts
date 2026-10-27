import { expect, test } from "bun:test";
import { SessionManager, TerminalSessionError } from "../../../../src/daemon/sessionManager";
import {
  ManagedExecutionReowner,
  MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS,
} from "../../../../src/daemon/sessionBroker/provisioning/executionReowner";
import type {
  BindingAssignmentRecord,
  ClaimExecutionResult,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FakeDbWriteBarrier } from "../../../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainMicrotasks } from "../../../helpers/fakeTimerStepping";
import { sessionOwnershipLostPayload } from "../../../../src/daemon/deviceSessionResult";

for (const refusal of [
  "scope_not_valid",
  "binding_missing",
  "device_assigned_elsewhere",
  "busy",
] as const) {
  test(`${refusal} releases a managed session through the ownership-lost hook`, async () => {
    const timer = new FakeTimer();
    const sessions = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    sessions.stopCleanupTimer();
    const id = "reown-terminal";
    await sessions.createSession(id, "device", "android");
    await sessions.adoptManagedExecutionLivenessPolicy(id);
    const assignment: BindingAssignmentRecord = {
      scopeKey: "scope",
      bindingIndex: 0,
      role: "app",
      platform: "android",
      generation: 1,
      stableDeviceId: "device",
      deviceName: "device",
      requestedSpec: {},
      resolvedSpec: {},
      specFingerprint: "fp",
      state: "ready",
      execOwner: { daemonId: "previous", pid: 100, sessionUuid: id },
      settler: null,
      updatedAtMs: 0,
    };
    const losses: number[] = [];
    const releases: Promise<string | null>[] = [];
    const reowner = new ManagedExecutionReowner({
      owner: () => ({ daemonId: "current", pid: 200 }),
      timer,
      isSessionHeld: (uuid) => sessions.isLiveManagedExecutionSession(uuid),
      isSessionPresent: (uuid) =>
        sessions.hasSession(uuid) || sessions.getReleasingSession(uuid) !== null,
      registry: async () => ({
        findExecutionAssignments: async () => [assignment],
        claimExecution: async (): Promise<ClaimExecutionResult> => {
          switch (refusal) {
            case "scope_not_valid":
              return { kind: refusal, scope: null };
            case "binding_missing":
              return { kind: refusal };
            case "device_assigned_elsewhere":
              return { kind: refusal, holder: assignment };
            case "busy":
              throw new Error("SQLITE_BUSY: claim");
          }
        },
      }),
      onOwnershipLost: (uuid) => {
        losses.push(timer.now());
        releases.push(sessions.releaseSession(uuid, "binding-ownership-lost"));
      },
    });
    sessions.setReleaseDeviceHold((uuid) => reowner.releaseDeviceHold(uuid));
    try {
      await reowner.reown([id], { rehydrated: true });
      if (refusal === "busy") {
        await timer.advanceTimeAsync(MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS, () =>
          drainMicrotasks(100),
        );
        await drainMicrotasks(100);
      }
      expect(losses).toEqual([refusal === "busy" ? MANAGED_EXECUTION_REOWN_MAX_UNCONFIRMED_MS : 0]);
      await Promise.all(releases);
      await reowner.whenIdle();
      expect(sessions.hasSession(id)).toBe(false);
      const snapshot = sessions.getTerminalReleaseSnapshot(id);
      expect(snapshot?.releaseReason).toBe("binding-ownership-lost");
      if (!snapshot) {
        throw new Error("ownership loss must retain the terminal release");
      }
      const error = new TerminalSessionError(id, snapshot);
      expect(
        sessionOwnershipLostPayload({
          message: error.message,
          sessionUuid: id,
          reason: error.release.releaseReason,
          release: error.release,
        }).error,
      ).toMatchObject({
        code: "session_ownership_lost",
        retryable: false,
        nextAction: "acquire_new_session",
      });
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      reowner.close();
      await reowner.whenIdle();
      sessions.stopCleanupTimer();
    }
  });
}

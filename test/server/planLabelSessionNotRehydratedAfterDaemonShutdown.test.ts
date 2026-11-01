import { deliverDaemonHeartbeat } from "../helpers/daemonHeartbeatHandler";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cancelAndReleaseSession,
  releaseSessionAndDevice,
} from "../../src/daemon/releaseSessionAndDevice";
import { TerminalSessionError } from "../../src/daemon/sessionManager";
import { deviceRestartReleaseReason } from "../../src/db/deviceSessionRepository";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { executionTracker } from "../../src/daemon/executionTracker";
import {
  BASE,
  LABEL_B,
  createPlanSessionHunt,
  deviceA,
  deviceB,
  twoDevicePlan,
  type HuntDaemon,
  type PlanSessionHunt,
} from "../helpers/planSessionHarness";

// A daemon shutdown while a multi-device plan runs releases every known session with
// `daemon-shutdown` (daemon.ts `releaseActiveSessionsForShutdown`), including the plan's derived
// `<base>:B` session. `daemon-shutdown` is a recoverable handoff, but a derived label session
// lives only as long as its plan run (#11572), and that run ended with the daemon: the restarted
// daemon rehydrates the caller's own session and never the label session, which would hold label
// B's device with no label map, no base and no plan, heartbeated by nobody. The caller, told by
// the retryable shutdown outcome to run its plan again, gets its labels minted by the new run.

describe("daemon shutdown while a multi-device plan runs", () => {
  let hunt: PlanSessionHunt;
  let monitor: SessionHeartbeatMonitor | undefined;

  const setUp = async (): Promise<void> => {
    hunt = await createPlanSessionHunt([deviceA, deviceB]);
    await hunt.acquire();
  };

  beforeAll(async () => {
    await setUp();
    try {
      await hunt.runPlan(twoDevicePlan(["B"]));
    } finally {
      hunt.tearDown();
    }
  });
  beforeEach(setUp);
  afterEach(() => {
    void monitor?.stop();
    monitor = undefined;
    hunt.tearDown();
  });

  /** daemon.ts `releaseActiveSessionsForShutdown`: cancel and release every known session. */
  const shutDown = ({ sessionManager, pool }: HuntDaemon): void => {
    // daemon.ts `quiesceProvisioningIngress` fences session creation before the releases.
    sessionManager.stopAcceptingSessionCreations();
    for (const sessionId of sessionManager.getAllKnownSessionIds()) {
      const deviceId = sessionManager.getSession(sessionId)?.assignedDevice ?? null;
      void cancelAndReleaseSession(sessionId, "daemon-shutdown", () =>
        releaseSessionAndDevice({ manager: sessionManager, pool }, deviceId, sessionId, {
          reason: "daemon-shutdown",
        }),
      );
    }
  };

  /** Run the two-device plan as a tracked call and shut the daemon down during its step on B. */
  const shutDownMidPlan = async (labelDeviceRestarting = false): Promise<void> => {
    const execution = executionTracker.startExecution("executePlan", "hunt-connection", BASE);
    hunt.setProbeStep(async (_device, signal) => {
      const { sessionManager, pool } = hunt.daemon();
      const labelDevice = sessionManager.getSession(LABEL_B)?.assignedDevice;
      if (labelDeviceRestarting && labelDevice) {
        // Label B's device went away for a restart first: its session waits out that handoff.
        const reason = deviceRestartReleaseReason(labelDevice);
        await releaseSessionAndDevice({ manager: sessionManager, pool }, labelDevice, LABEL_B, {
          reason,
        });
      }
      shutDown(hunt.daemon());
      // The shutdown aborted this call; the step unwinds on its next turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    });
    try {
      const result = await runWithToolSelectionContext(
        { execution: { executionId: execution.id, startTime: execution.startTime } },
        () => hunt.runPlan(twoDevicePlan(["B", "A"]), execution.abortController.signal),
      );
      // The plan answers for itself, and tells its caller the daemon went away: run it again.
      expect([result.success, result.code, result.retryable]).toEqual([
        false,
        "daemon_shutting_down",
        true,
      ]);
    } finally {
      executionTracker.endExecution(execution.id);
      hunt.setProbeStep(async () => undefined);
    }
    // Both rows are the recoverable handoff, the label session's included.
    expect((await hunt.persistence.getSession(BASE))?.release_reason).toBe("daemon-shutdown");
  };

  test.each([
    ["a daemon shutdown", false],
    ["its device restarting", true],
  ])(
    "the restarted daemon does not bring back a label session released for %s",
    async (_why, labelDeviceRestarting) => {
      await shutDownMidPlan(labelDeviceRestarting);
      const row = await hunt.persistence.getSession(LABEL_B);
      const labelDevice = row?.device_id ?? "";
      const rowReason = labelDeviceRestarting ? `device-restart:${labelDevice}` : "daemon-shutdown";
      expect([row?.source, row?.release_reason]).toEqual(["plan-label", rowReason]);

      const restarted = await hunt.restartDaemon();
      const { sessionManager, pool } = restarted;
      const summary = await sessionManager.rehydratePersistedSessions(pool);

      // The caller's own session is the recoverable one.
      expect(summary.rehydrated).toEqual([BASE]);
      // `<base>:B` is not: its row stays as the shutdown left it, and its device is free.
      expect(summary.skipped).toEqual([{ sessionUuid: LABEL_B, reason: "not-recoverable" }]);
      expect(sessionManager.getSession(LABEL_B)).toBeNull();
      expect(hunt.poolHolder(labelDevice)).toBeUndefined();

      // Naming the label session does not recover it either: only a plan run mints it.
      await expect(
        sessionManager.getOrCreateSession(LABEL_B, pool, "ios", { requireIssuedSession: true }),
      ).rejects.toBeInstanceOf(TerminalSessionError);
      await expect(sessionManager.getOrCreateSession(LABEL_B, pool, "ios")).rejects.toBeInstanceOf(
        TerminalSessionError,
      );
      // Nor while a new plan run has published its labels and not yet allocated them: the row
      // is the previous run's, not a handoff of this one.
      sessionManager.setDeviceLabels(BASE, { A: BASE, B: LABEL_B });
      expect(sessionManager.getBaseSessionOfDerivedLabel(LABEL_B)).toBe(BASE);
      await expect(
        sessionManager.getOrCreateSession(LABEL_B, pool, "ios", { requireIssuedSession: true }),
      ).rejects.toBeInstanceOf(TerminalSessionError);
      expect(hunt.poolHolder(labelDevice)).toBeUndefined();
      expect((await hunt.persistence.getSession(LABEL_B))?.release_reason).toBe(rowReason);
    },
  );

  test("the plan can be run again under the same base once the daemon is back", async () => {
    await shutDownMidPlan();

    const restarted = await hunt.restartDaemon();
    const { sessionManager } = restarted;
    await sessionManager.rehydratePersistedSessions(restarted.pool);
    // daemon.ts startup: owner windows open, then the heartbeat monitor starts.
    sessionManager.startRehydratedOwnerWindows();
    monitor = new SessionHeartbeatMonitor(
      sessionManager,
      () => false,
      async (sessionId, reason) => {
        const deviceId = sessionManager.getSession(sessionId)?.assignedDevice ?? null;
        await releaseSessionAndDevice(
          { manager: sessionManager, pool: restarted.pool },
          deviceId,
          sessionId,
          {
            reason,
          },
        );
      },
      { timer: hunt.timer },
    );
    monitor.start();

    // The owner is back and heartbeats the session it holds, every second, for 12 s.
    for (let second = 0; second < 12; second++) {
      await deliverDaemonHeartbeat(sessionManager, BASE);
      await hunt.timer.advanceTimeAsync(1_000);
    }
    expect(sessionManager.getSession(BASE)?.assignedDevice).toBe(deviceA.deviceId);
    // Nothing held label B's device meanwhile, and nothing was reaped for it.
    expect(sessionManager.getTerminalReleaseSnapshot(LABEL_B)).toBeUndefined();
    expect(restarted.pool.getAllDevices().filter((d) => d.sessionId).length).toBe(1);

    const rerun = await hunt.runPlan(twoDevicePlan(["B", "A"]));

    expect(rerun.error).toBeUndefined();
    expect(rerun.success).toBe(true);
  });
});

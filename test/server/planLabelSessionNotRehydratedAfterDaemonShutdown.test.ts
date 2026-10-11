import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  cancelAndReleaseSession,
  releaseSessionAndDevice,
} from "../../src/daemon/releaseSessionAndDevice";
import { SessionHeartbeatMonitor } from "../../src/daemon/SessionHeartbeatMonitor";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { executionTracker } from "../../src/server/executionTracker";
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

// Hunt 2026-10-10 (plan sessions). A daemon shutdown while a multi-device plan runs releases
// every known session with `daemon-shutdown` (daemon.ts `releaseActiveSessionsForShutdown`),
// including the plan's derived `<base>:B` session. `daemon-shutdown` is a recoverable handoff, so
// the restarted daemon rehydrates `<base>:B` as a session of its own: it holds label B's device,
// has no label map and no link to its base (`getBaseSessionOfDerivedLabel` is undefined), and no
// plan is running. The plan's own auto-release cannot prevent it: its `plan-auto-release` joins the
// shutdown release already in flight and does not replace the reason.
//
// Nothing owns that session: a client heartbeats the session it named (the base), never a label
// session. So one lease plus grace later the heartbeat monitor reaps `<base>:B` as
// `rehydration-owner-timeout`, a TERMINAL reason. From then on the caller, told by the retryable
// shutdown outcome to run its plan again, is refused for good: the base is fine, but label B's
// UUID is fenced.
//
// Owner contracts: derived `<base>:<label>` sessions live only while the plan runs; a daemon
// shutdown mid-plan is recoverable (the plan can be run again); plan session UUIDs are
// re-issuable by name.

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
    monitor?.stop();
    monitor = undefined;
    hunt.tearDown();
  });

  /** daemon.ts `releaseActiveSessionsForShutdown`: cancel and release every known session. */
  const shutDown = ({ sessionManager, pool }: HuntDaemon): void => {
    for (const sessionId of sessionManager.getAllKnownSessionIds()) {
      const deviceId = sessionManager.getSession(sessionId)?.assignedDevice ?? null;
      void cancelAndReleaseSession(sessionId, "daemon-shutdown", () =>
        releaseSessionAndDevice(sessionManager, pool, deviceId, sessionId, "daemon-shutdown"),
      );
    }
  };

  /** Run the two-device plan as a tracked call and shut the daemon down during its step on B. */
  const shutDownMidPlan = async (): Promise<void> => {
    const execution = executionTracker.startExecution("executePlan", "hunt-connection", BASE);
    hunt.setProbeStep(async (_device, signal) => {
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
      expect(result.success).toBe(false);
    } finally {
      executionTracker.endExecution(execution.id);
      hunt.setProbeStep(async () => undefined);
    }
    // Both rows are the recoverable handoff, the label session's included.
    expect((await hunt.persistence.getSession(BASE))?.release_reason).toBe("daemon-shutdown");
  };

  test("the restarted daemon does not bring the plan's label session back to hold a device", async () => {
    await shutDownMidPlan();

    const restarted = await hunt.restartDaemon();
    const summary = await restarted.sessionManager.rehydratePersistedSessions(restarted.pool);

    // The caller's own session is the recoverable one.
    expect(summary.rehydrated).toContain(BASE);
    // FAILS: `<base>:B` is rehydrated too and holds IOS-B, with no plan, no label map and no base.
    expect(restarted.sessionManager.getSession(LABEL_B)).toBeNull();
    expect(hunt.poolHolder(deviceB.deviceId)).toBeUndefined();
  });

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
        await releaseSessionAndDevice(sessionManager, restarted.pool, deviceId, sessionId, reason);
      },
      hunt.timer,
    );
    monitor.start();

    // The owner is back and heartbeats the session it holds, every second, for 12 s.
    for (let second = 0; second < 12; second++) {
      sessionManager.recordHeartbeat(BASE);
      await hunt.timer.advanceTimeAsync(1_000);
    }
    expect(sessionManager.getSession(BASE)?.assignedDevice).toBe(deviceA.deviceId);

    const rerun = await hunt.runPlan(twoDevicePlan(["B", "A"]));

    // FAILS: "TerminalSessionError: Session <base>:B is terminal after rehydration-owner-timeout
    // and cannot be reused. Acquire a new device with getAndroid or getApple."
    expect(rerun.error).toBeUndefined();
    expect(rerun.success).toBe(true);
  });
});

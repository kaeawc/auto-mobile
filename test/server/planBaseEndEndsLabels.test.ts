import { DaemonState } from "../../src/daemon/daemonState";
import { beforeAll, describe, expect, test } from "bun:test";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { planBaseEndFields } from "../../src/server/planExecutionOrchestrator";
import { INTERNAL_MCP_SESSION_PARAM } from "../../src/daemon/constants";
import { SESSION_OWNERSHIP_LOST_CODE } from "../../src/daemon/sessionReleasedDuringCall";
import { TerminalSessionError } from "../../src/daemon/sessionManager";
import {
  hasActiveSessionExecution,
  latestSessionExecutionDeadlineMs,
  subscribeToolCallEndActivity,
} from "../../src/daemon/toolCallActivity";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { executionTracker } from "../../src/server/executionTracker";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { drainMicrotasks, FAKE_TIMER_QUIET_TURNS } from "../helpers/fakeTimerStepping";
import {
  BASE,
  LABEL_B,
  createPlanSessionHunt,
  deviceA,
  deviceB,
  deviceC,
  twoDevicePlan,
  type PlanRunResult,
  type PlanSessionHunt,
} from "../helpers/planSessionHarness";

// #11640, owner decision 2026-10-11: the base's end ends its labels. Reproduced through a real
// `executePlan` run (registry, orchestrator, session manager, pool and release cascade over fakes):
// plan steps on label B stamp only the label, so once the plan's own call no longer holds the base
// past its idle deadline, the base is expired and unscanned while the label is still live.

const OWNER = "conn-owner";
const STRANGER = "conn-stranger";
/** The plan call's request deadline, after which it no longer holds its base (plus the grace). */
const PLAN_DEADLINE_MS = 60_000;
const DEADLINE_GRACE_MS = 10_000;

beforeAll(async () => {
  const warm = await createPlanSessionHunt([deviceA, deviceB, deviceC]);
  try {
    // Pay the harness's cold tool/schema initialization outside each scenario's budget.
    await warm.acquire();
    await warm.runPlan(twoDevicePlan(["B", "B", "B"]));
  } finally {
    warm.tearDown();
  }
});

interface LongPlan {
  hunt: PlanSessionHunt;
  released: Array<[string, string]>;
  /** Devices the probe step ran on, in order. */
  ran: string[];
  /** A control call from `connection` naming `sessionUuid`, as the daemon's tool path runs it. */
  call(connection: string, sessionUuid: string): Promise<unknown>;
  /** Runs when the base is expired and unscanned and the label is live, inside the plan's step. */
  whenBaseOutlived(body: () => Promise<void>): void;
  /** Replace what each step does after it reached the label's device (1-based step number). */
  setStep(step: (number: number) => Promise<void>): void;
  /** Run a three-step plan on label B under a plan call with this request deadline. */
  run(planDeadlineMs?: number): Promise<PlanRunResult>;
}

const longPlanOnItsLabel = (body: (plan: LongPlan) => Promise<void>) => async (): Promise<void> => {
  const hunt = await createPlanSessionHunt([deviceA, deviceB, deviceC]);
  const unsubscribe: Array<() => void> = [];
  try {
    const { sessionManager, pool } = hunt.daemon();
    // daemon.ts: a call in flight vetoes its session's idle release until its request deadline.
    sessionManager.setActiveSessionExecutionChecker((id, query) =>
      hasActiveSessionExecution(executionTracker, sessionManager, pool, id, query),
    );
    sessionManager.setSessionExecutionDeadlineLookup((id, query) =>
      latestSessionExecutionDeadlineMs(executionTracker, sessionManager, pool, id, {
        onSessionClock: true,
        ...query,
      }),
    );
    unsubscribe.push(subscribeToolCallEndActivity(executionTracker, sessionManager, pool));
    const released: Array<[string, string]> = [];
    sessionManager.onSessionRelease((id, _deviceId, reason) => {
      released.push([id, reason]);
    });
    await pool.bindOrReuseDeviceSession(
      BASE,
      deviceA.deviceId,
      "ios",
      undefined,
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      OWNER,
    );
    sessionManager.setDeviceReadiness(BASE, "automationReady");
    const baseIdleDeadline = sessionManager.peekSession(BASE)!.expiresAt;

    const ran: string[] = [];
    let outlived: () => Promise<void> = async () => undefined;
    let onStep = async (step: number): Promise<void> => {
      if (step === 1) {
        // Past the plan call's deadline and grace; the next step stamps the label here.
        hunt.timer.advanceTime(PLAN_DEADLINE_MS + DEADLINE_GRACE_MS);
      } else if (step === 2) {
        hunt.timer.advanceTime(baseIdleDeadline - sessionManager.sessionNow() + 1);
        await outlived();
      }
    };
    let step = 0;
    hunt.setProbeStep(async (device) => {
      ran.push(device.deviceId);
      await onStep(++step);
    });

    await body({
      hunt,
      released,
      ran,
      call: async (connection, sessionUuid) => {
        const execution = executionTracker.startExecution("huntProbe", connection, sessionUuid);
        try {
          return await runWithToolSelectionContext(
            { execution: { executionId: execution.id, startTime: execution.startTime } },
            () =>
              ToolRegistry.getTool("huntProbe")!.handler({
                sessionUuid,
                platform: "ios",
                [INTERNAL_MCP_SESSION_PARAM]: connection,
              }),
          );
        } finally {
          executionTracker.endExecution(execution.id);
        }
      },
      whenBaseOutlived: (then) => {
        outlived = then;
      },
      setStep: (then) => {
        onStep = then;
      },
      run: async (planDeadlineMs = PLAN_DEADLINE_MS) => {
        const planExecution = executionTracker.startExecution("executePlan", OWNER, BASE);
        const deadline = hunt.timer.now() + planDeadlineMs;
        executionTracker.setExecutionDeadline(planExecution.id, () => deadline);
        try {
          const response: { structuredContent?: PlanRunResult; content: Array<{ text: string }> } =
            await runWithToolSelectionContext(
              {
                execution: {
                  executionId: planExecution.id,
                  startTime: planExecution.startTime,
                },
              },
              () =>
                ToolRegistry.getTool("executePlan")!.handler({
                  planContent: twoDevicePlan(["B", "B", "B"]),
                  startStep: 0,
                  platform: "ios",
                  sessionUuid: BASE,
                  deviceAllocationTimeoutMs: 1_000,
                  abortStrategy: "immediate",
                  [INTERNAL_MCP_SESSION_PARAM]: OWNER,
                }),
            );
          return response.structuredContent ?? JSON.parse(response.content[0].text);
        } finally {
          executionTracker.endExecution(planExecution.id);
        }
      },
    });
  } finally {
    unsubscribe.forEach((end) => end());
    hunt.tearDown();
  }
};

const terminalRefusal = async (attempt: Promise<unknown>): Promise<TerminalSessionError> => {
  const error: unknown = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TerminalSessionError)) {
    throw new Error(`expected a terminal refusal, got ${String(error)}`);
  }
  return error;
};

describe("a plan whose steps run on a label for longer than its base's idle window", () => {
  test(
    "runs to the end while its own call's request deadline still holds the base",
    longPlanOnItsLabel(async (plan) => {
      const { sessionManager } = plan.hunt.daemon();
      const idleMs = sessionManager.peekSession(BASE)!.sessionTimeoutMs;
      const baseStampedAt = sessionManager.peekSession(BASE)!.lastUsedAt;
      const baseLiveAfterStep: boolean[] = [];
      plan.setStep(async () => {
        // Each step stamps the label; nothing stamps the base.
        plan.hunt.timer.advanceTime(idleMs - 1_000);
        baseLiveAfterStep.push(sessionManager.peekSession(BASE) !== null);
      });

      const result = await plan.run(10 * idleMs);

      expect(result.success).toBe(true);
      expect(plan.ran).toEqual([deviceB.deviceId, deviceB.deviceId, deviceB.deviceId]);
      // Nearly three idle windows passed without a stamp on the base, which the plan's call held.
      expect(baseLiveAfterStep).toEqual([true, true, true]);
      expect(sessionManager.sessionNow() - baseStampedAt).toBeGreaterThan(2 * idleMs);
    }),
  );
});

describe("a plan whose base idles out while its steps run on a label", () => {
  test.each([BASE, LABEL_B])(
    "result fields for the terminal refusal of %s are a pure read",
    (sessionUuid) =>
      longPlanOnItsLabel(async (plan) => {
        const { sessionManager } = plan.hunt.daemon();
        let checked = false;
        plan.whenBaseOutlived(async () => {
          const ended = sessionManager.peekTerminalAnswerForEndedSession(sessionUuid);
          expect(ended).toBeInstanceOf(TerminalSessionError);
          const failedStep = { stepIndex: 1, tool: "huntProbe", device: "B", error: String(ended) };
          expect(planBaseEndFields(BASE, false, failedStep)).toMatchObject({
            code: SESSION_OWNERSHIP_LOST_CODE,
            retryable: false,
            details: { sessionUuid: BASE, reason: "lazy-expiry" },
          });
          expect(
            planBaseEndFields(BASE, false, {
              ...failedStep,
              error: `ordinary error mentions ${ended}`,
            }),
          ).toEqual({});
          await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
          expect(plan.released).toEqual([]);
          expect(sessionManager.hasSession(BASE)).toBe(true);
          checked = true;
        });
        await plan.run();
        expect(checked).toBe(true);
      })(),
  );

  test(
    "the label still holds its device against a stranger's exact-device bind",
    longPlanOnItsLabel(async (plan) => {
      const { sessionManager, pool } = plan.hunt.daemon();
      let checked = false;
      plan.whenBaseOutlived(async () => {
        const label = sessionManager.getSession(LABEL_B);
        expect(label?.sessionId).toBe(LABEL_B);
        await expect(
          pool.bindOrReuseDeviceSession(
            "5e550000-0000-4000-8000-0000000000ff",
            deviceB.deviceId,
            "ios",
            undefined,
            undefined,
            undefined,
            false,
            undefined,
            undefined,
            undefined,
            STRANGER,
          ),
        ).rejects.toBeInstanceOf(InputDeviceOwnedError);
        expect(plan.hunt.poolHolder(deviceB.deviceId)).toBe(LABEL_B);
        expect(sessionManager.getSession(LABEL_B)).toBe(label);
        expect(plan.released).toEqual([]);
        checked = true;
      });
      await plan.run();
      expect(checked).toBe(true);
    }),
  );

  test(
    "an ordinary step failure stays ordinary and building its fields releases nothing",
    longPlanOnItsLabel(async (plan) => {
      const { sessionManager } = plan.hunt.daemon();
      plan.whenBaseOutlived(async () => {
        const stampedAt = sessionManager.getSession(LABEL_B)?.lastUsedAt;
        expect(
          planBaseEndFields(BASE, false, {
            stepIndex: 1,
            tool: "huntProbe",
            device: "B",
            error: "Error: ordinary probe failure unrelated to sessions",
          }),
        ).toEqual({});
        await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
        expect(plan.released).toEqual([]);
        expect(sessionManager.hasSession(BASE)).toBe(true);
        expect(sessionManager.getSession(LABEL_B)?.lastUsedAt).toBe(stampedAt);
        throw new Error("ordinary probe failure unrelated to sessions");
      });
      const result = await plan.run();
      expect(result.success).toBe(false);
      expect(result.error).toContain("ordinary probe failure unrelated to sessions");
      expect(result.code).toBeUndefined();
      await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
      expect(plan.released.filter(([id]) => id === BASE)).toEqual([[BASE, "lazy-expiry"]]);
      expect(plan.released.filter(([id]) => id === LABEL_B)).toEqual([[LABEL_B, "lazy-expiry"]]);
      expect(plan.hunt.poolHolder(deviceA.deviceId)).toBeUndefined();
      expect(plan.hunt.poolHolder(deviceB.deviceId)).toBeUndefined();
    }),
  );

  test.each([
    ["a stranger connection", STRANGER],
    ["the owner", OWNER],
  ])(
    "%s naming the label is refused with the base's end, and base and label end",
    (_who, connection) =>
      longPlanOnItsLabel(async (plan) => {
        const { sessionManager } = plan.hunt.daemon();
        let refused: TerminalSessionError | undefined;
        let ranBefore = -1;
        plan.whenBaseOutlived(async () => {
          expect(sessionManager.peekSession(BASE)).toBeNull();
          ranBefore = plan.ran.length;
          refused = await terminalRefusal(plan.call(connection, LABEL_B));
          await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);
        });

        await plan.run();

        expect(refused?.sessionUuid).toBe(LABEL_B);
        expect(refused?.release).toMatchObject({ releaseReason: "lazy-expiry", terminal: true });
        // The refused call never reached the label's device.
        expect(plan.ran.slice(ranBefore)).toEqual([]);
        expect(plan.released).toEqual([
          [BASE, "lazy-expiry"],
          [LABEL_B, "lazy-expiry"],
        ]);
        expect(plan.hunt.poolHolder(deviceB.deviceId)).toBeUndefined();
      })(),
  );

  test(
    "the plan's next step fails typed, naming the base's release reason",
    longPlanOnItsLabel(async (plan) => {
      const result = await plan.run();
      await drainMicrotasks(FAKE_TIMER_QUIET_TURNS);

      expect(result.success).toBe(false);
      expect(result.code).toBe(SESSION_OWNERSHIP_LOST_CODE);
      expect(result.retryable).toBe(false);
      expect(result.details).toEqual({ sessionUuid: BASE, reason: "lazy-expiry", idle: true });
      expect(result.error).toContain("lazy-expiry");
      expect(result.error).not.toContain("is not allocated");
      // Two steps ran on the label's device; the third was refused before reaching any device.
      expect(plan.ran).toEqual([deviceB.deviceId, deviceB.deviceId]);
      expect(plan.released).toEqual([
        [BASE, "lazy-expiry"],
        [LABEL_B, "lazy-expiry"],
      ]);
      expect(plan.hunt.poolHolder(deviceA.deviceId)).toBeUndefined();
      expect(plan.hunt.poolHolder(deviceB.deviceId)).toBeUndefined();
    }),
  );
});

for (const reason of ["cleanup-expired", "heartbeat-timeout"] as const) {
  test(`plan base end qualifies only the idle reason: ${reason}`, async () => {
    const hunt = await createPlanSessionHunt([deviceA]);
    try {
      const { sessionManager } = hunt.daemon();
      await hunt.acquire();
      await sessionManager.releaseSession(BASE, reason);
      const ended = sessionManager.peekTerminalAnswerForEndedSession(BASE)!;
      expect(
        planBaseEndFields(BASE, false, { index: 0, tool: "observe", error: String(ended) }).details,
      ).toEqual({
        sessionUuid: BASE,
        reason,
        ...(reason === "cleanup-expired" ? { idle: true } : {}),
      });
    } finally {
      hunt.tearDown();
      expect(DaemonState.getInstance().isInitialized()).toBe(false);
      expect(executionTracker.getActiveExecutionCount()).toBe(0);
    }
  });
}

import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DaemonState } from "../../src/daemon/daemonState";
import { z } from "zod/v4";

/**
 * End-to-end regression coverage for issue #6234 at the PlanExecutor boundary:
 * a multi-device recovery that resumes inside a barrier generation must re-arrive
 * every participant (no lone survivor that would deadlock at waitAtBarrier), and
 * a resume point outside any generation must be left exactly as-is.
 *
 * Uses a fake `barrier` tool that only records which device arrived, so the test
 * observes *which arrivals execute* deterministically without a real coordinator
 * rendezvous, FakeTimer, or a device.
 */
describe("PlanExecutor barrier-generation resume (#6234)", () => {
  let planExecutor: DefaultPlanExecutor;
  let barrierArrivals: string[];
  let actionArrivals: string[];

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    barrierArrivals = [];
    actionArrivals = [];

    const daemonState = DaemonState.getInstance();
    if (daemonState.isInitialized()) {
      daemonState.reset();
    }

    const barrierSchema = z.object({
      device: z.string().optional(),
      lock: z.string().optional(),
      deviceCount: z.number().optional(),
      platform: z.string().optional(),
      sessionUuid: z.string().optional(),
    });
    ToolRegistry.register(
      "barrier",
      "Fake barrier tool for #6234 resume test",
      barrierSchema,
      mock(async (params: any) => {
        barrierArrivals.push(params.device);
        return { success: true };
      }),
    );

    const actionSchema = z.object({
      device: z.string().optional(),
      text: z.string().optional(),
      platform: z.string().optional(),
      sessionUuid: z.string().optional(),
    });
    ToolRegistry.register(
      "fakeAction",
      "Fake action tool for #6234 resume test",
      actionSchema,
      mock(async (params: any) => {
        actionArrivals.push(params.device);
        return { success: true };
      }),
    );
  });

  afterEach(() => {
    ToolRegistry.unregister("barrier");
    ToolRegistry.unregister("fakeAction");
    const daemonState = DaemonState.getInstance();
    if (daemonState.isInitialized()) {
      daemonState.reset();
    }
  });

  const buildPlan = (): Plan => ({
    name: "barrier-resume-plan",
    mcpVersion: "1.0",
    devices: ["A", "B"],
    steps: [
      { tool: "barrier", params: { device: "A", lock: "L", deviceCount: 2 } }, // 0 gen0
      { tool: "barrier", params: { device: "B", lock: "L", deviceCount: 2 } }, // 1 gen0
      { tool: "fakeAction", params: { device: "A", text: "after" } }, // 2
    ],
  });

  test("resuming inside a barrier generation re-arrives BOTH devices (no lone survivor)", async () => {
    // startStep=1 lands between A's arrival (0) and B's arrival (1). Without the
    // guard, device A's track would skip its arrival (0 < 1) while device B
    // re-arrives alone at step 1 -> deadlock. The guard rewinds to 0.
    const result = await planExecutor.executePlan(buildPlan(), 1, "android");

    expect(result.success).toBe(true);
    expect(barrierArrivals.sort()).toEqual(["A", "B"]);
  });

  test("resuming after a completed barrier generation skips it entirely and is unaffected", async () => {
    // startStep=2 is past the whole generation: both arrivals are skipped
    // uniformly and only the trailing action runs. No rewind, no re-arrival.
    const result = await planExecutor.executePlan(buildPlan(), 2, "android");

    expect(result.success).toBe(true);
    expect(barrierArrivals).toEqual([]);
  });

  test("a fresh run (startStep 0) arrives both devices exactly once", async () => {
    const result = await planExecutor.executePlan(buildPlan(), 0, "android");

    expect(result.success).toBe(true);
    expect(barrierArrivals.sort()).toEqual(["A", "B"]);
  });

  test("recovery replays only the changing-participant generation, not completed destructive work", async () => {
    const plan: Plan = {
      name: "changing-barrier-participants",
      mcpVersion: "1.0",
      devices: ["A", "B", "C"],
      steps: [
        { tool: "barrier", params: { device: "A", lock: "L", deviceCount: 2 } },
        { tool: "barrier", params: { device: "B", lock: "L", deviceCount: 2 } },
        { tool: "fakeAction", params: { device: "B", text: "destructive" } },
        { tool: "barrier", params: { device: "A", lock: "L", deviceCount: 2 } },
        { tool: "barrier", params: { device: "C", lock: "L", deviceCount: 2 } },
      ],
    };

    const result = await planExecutor.executePlan(plan, 4, "android");

    expect(result.success).toBe(true);
    expect(barrierArrivals.sort()).toEqual(["A", "C"]);
    expect(actionArrivals).toEqual([]);
  });
});

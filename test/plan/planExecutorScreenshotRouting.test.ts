import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import type { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ScreenshotJobTracker } from "../../src/utils/ScreenshotJobTracker";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

describe("PlanExecutor screenshot cancellation routing", () => {
  const toolName = "screenshotRoutingStep";
  const baseSessionUuid = "screenshot-routing-base";
  const schema = z.object({
    device: z.string().optional(),
    deviceId: z.string().optional(),
    platform: z.string().optional(),
    sessionUuid: z.string().optional(),
  });
  type Event = { cancel: string } | { step: z.infer<typeof schema> };
  let events: Event[];
  let executor: DefaultPlanExecutor;
  let sessionManager: SessionManager;
  let restoreSpies: Array<() => void>;

  beforeEach(async () => {
    DaemonState.getInstance().reset();
    events = [];
    restoreSpies = [];
    const timer = new FakeTimer();
    executor = new DefaultPlanExecutor(timer);
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    await sessionManager.createSession(baseSessionUuid, "device-A", "android");
    await sessionManager.createSession("session-for-B", "device-B", "android");
    // Use the registered map rather than assuming derived UUID spelling.
    sessionManager.setDeviceLabels(baseSessionUuid, { A: baseSessionUuid, B: "session-for-B" });
    const daemonState = DaemonState.getInstance();
    const initialized = spyOn(daemonState, "isInitialized").mockReturnValue(true);
    const manager = spyOn(daemonState, "getSessionManager").mockReturnValue(sessionManager);
    const cancellation = spyOn(ScreenshotJobTracker, "cancelJob").mockImplementation((id) => {
      events.push({ cancel: id });
    });
    restoreSpies.push(
      () => cancellation.mockRestore(),
      () => manager.mockRestore(),
      () => initialized.mockRestore(),
    );
    ToolRegistry.register(toolName, "Fake screenshot routing step", schema, async (params) => {
      events.push({ step: schema.parse(params) });
      return { success: true };
    });
    const tool = ToolRegistry.getTool(toolName)!;
    tool.requiresDevice = true;
  });

  afterEach(() => {
    ToolRegistry.unregister(toolName);
    for (const restore of restoreSpies) {
      restore();
    }
    sessionManager.stopCleanupTimer();
    DaemonState.getInstance().reset();
  });

  const parallelPlan = (labels: string[]): Plan => ({
    name: "screenshot-routing",
    mcpVersion: "1.0",
    devices: ["A", "B"],
    steps: labels.map((device) => ({ tool: toolName, params: { device } })),
  });

  test("every step cancels only its own track's resolved device", async () => {
    const result = await executor.executePlan(
      parallelPlan(["A", "B", "A", "B"]),
      0,
      "android",
      "device-A",
      baseSessionUuid,
    );

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(4);
    const cancellations = events.filter((event) => "cancel" in event);
    expect(cancellations.filter((event) => event.cancel === "device-A")).toHaveLength(2);
    expect(cancellations.filter((event) => event.cancel === "device-B")).toHaveLength(2);
    expect(events).toHaveLength(8);
    for (let index = 1; index < events.length; index += 2) {
      const event = events[index];
      expect("step" in event).toBe(true);
      if (!("step" in event)) {
        throw new Error("Expected a step immediately after its cancellation");
      }
      expect(events[index - 1]).toEqual({
        cancel: event.step.device === "A" ? "device-A" : "device-B",
      });
      expect(event.step.deviceId).toBeUndefined();
      expect(event.step.sessionUuid).toBe(baseSessionUuid);
    }
  });

  test.each(["no daemon", "no session UUID", "no label map", "missing label", "missing session"])(
    "an unresolved B track skips cancellation: %s",
    async (scenario) => {
      if (scenario === "no daemon") {
        spyOn(DaemonState.getInstance(), "isInitialized").mockReturnValue(false);
      } else if (scenario === "no label map") {
        const labels = spyOn(sessionManager, "getDeviceLabels").mockReturnValue(undefined);
        restoreSpies.push(() => labels.mockRestore());
      } else if (scenario === "missing label") {
        sessionManager.setDeviceLabels(baseSessionUuid, { A: baseSessionUuid });
      } else if (scenario === "missing session") {
        sessionManager.setDeviceLabels(baseSessionUuid, {
          A: baseSessionUuid,
          B: "unknown-session",
        });
      }

      const result = await executor.executePlan(
        parallelPlan(["B", "B"]),
        0,
        "android",
        "device-A",
        scenario === "no session UUID" ? undefined : baseSessionUuid,
      );

      // This fake tool accepts labels without allocation; normal tool routing
      // still decides whether an unresolved label can execute.
      expect(result.success).toBe(true);
      expect(result.executedSteps).toBe(2);
      expect(events.filter((event) => "cancel" in event)).toEqual([]);
      expect(events.filter((event) => "step" in event)).toHaveLength(2);
    },
  );

  test("a sequential plan still cancels the supplied base device before each step", async () => {
    const plan: Plan = {
      name: "sequential-screenshot-routing",
      mcpVersion: "1.0",
      steps: [
        { tool: toolName, params: {} },
        { tool: toolName, params: {} },
      ],
    };
    const result = await executor.executePlan(plan, 0, "android", "device-A");

    expect(result.success).toBe(true);
    expect(events).toEqual([
      { cancel: "device-A" },
      { step: { deviceId: "device-A", platform: "android" } },
      { cancel: "device-A" },
      { step: { deviceId: "device-A", platform: "android" } },
    ]);
  });
});

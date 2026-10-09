import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { unregisterTemporaryTools } from "../helpers/withTemporaryTool";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { DaemonState } from "../../src/daemon/daemonState";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";

/**
 * Regression guard for issue #3053 part 2: PlanExecutor must mark its tool-to-tool
 * calls internal (`__internalNoDiff`) so a plan step's finalized envelope is never
 * diffed or stripped under `--actions-diff-observe`/`--actions-no-observe`. This
 * pins the marker injection at the PlanExecutor boundary (the wrapped-handler →
 * finalize half is covered by toolRegistry.internalNoDiff.test.ts) and confirms
 * the marker does not disturb the success/error step logic.
 */
type ToolRegistryDeviceSessionManager = (typeof ToolRegistry)["deviceSessionManager"];

describe("PlanExecutor internal no-diff marker (#3053)", () => {
  let planExecutor: DefaultPlanExecutor;
  let capturedArgs: Record<string, unknown>[];
  let originalDeviceSessionManager: ToolRegistryDeviceSessionManager;

  const schema = z.object({
    text: z.string().optional(),
    platform: z.string().optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  beforeEach(() => {
    // These tests exercise the daemon-less direct path; an initialized DaemonState left by another
    // file would route sess-1 through a real SessionManager and its file-backed database.
    DaemonState.getInstance().reset();
    // Resolve the device through a fake instead of the process-wide DeviceSessionManager singleton,
    // whose connected-device cache and pins other files mutate.
    const fakeDeviceSessionManager = new FakeDeviceSessionManager();
    fakeDeviceSessionManager.setConnectedDevices([
      { name: "Pixel A", deviceId: "emulator-5554", platform: "android" },
    ]);
    originalDeviceSessionManager = ToolRegistry["deviceSessionManager"];
    ToolRegistry["deviceSessionManager"] = fakeDeviceSessionManager;
    planExecutor = new DefaultPlanExecutor();
    capturedArgs = [];
  });

  afterEach(() => {
    ToolRegistry["deviceSessionManager"] = originalDeviceSessionManager;
    unregisterTemporaryTools("tapOn");
  });

  function registerCapturingTool(success: boolean): void {
    ToolRegistry.register("tapOn", "Mock tapOn", schema, async (args: any) => {
      capturedArgs.push(args);
      return createStructuredToolResponse(
        success ? { success: true, message: "ok" } : { success: false, error: "not found" },
      );
    });
    (ToolRegistry.getTool("tapOn") as { requiresDevice: boolean }).requiresDevice = true;
  }

  test("EC2.4: injects __internalNoDiff on the tool call and leaves success logic intact", async () => {
    registerCapturingTool(true);
    const plan: Plan = { name: "p", steps: [{ tool: "tapOn", params: { text: "Go" } }] };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554", "sess-1");

    expect(result.success).toBe(true);
    expect(capturedArgs).toHaveLength(1);
    // The internal marker reaches the handler (set after schema.parse).
    expect(capturedArgs[0].__internalNoDiff).toBe(true);
    // Existing injected routing params are unaffected.
    expect(capturedArgs[0].sessionUuid).toBe("sess-1");
  });

  test("EC2.4: a failed step still gets the marker and reports failure normally", async () => {
    registerCapturingTool(false);
    const plan: Plan = { name: "p", steps: [{ tool: "tapOn", params: { text: "Missing" } }] };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    expect(capturedArgs[0].__internalNoDiff).toBe(true);
  });
});

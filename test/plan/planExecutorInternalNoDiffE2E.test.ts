import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { ObserveResult } from "../../src/models/ObserveResult";

/**
 * End-to-end guard for issue #3053 part 2: run a real `DefaultPlanExecutor` step
 * through the wrapped `tool.handler` → `finalizeToolResponse` chain with
 * `--actions-diff-observe` on, and prove the plan step's observation is NEVER
 * diffed and NEVER advances the agent-facing diff baseline. The two halves are
 * unit-tested separately (PlanExecutor sets `__internalNoDiff`; the wrapped
 * handler honors it); this pins that the whole seam holds together.
 */
describe("PlanExecutor → finalize internal no-diff (end-to-end, #3053)", () => {
  const androidA: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };

  let planExecutor: DefaultPlanExecutor;
  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let daemonSessionManager: SessionManager | undefined;
  let originalDiff: boolean;

  function sameScreenObserve(): ObserveResult {
    return {
      updatedAt: 1,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
      viewHierarchy: {
        packageName: "com.example",
        hierarchy: { node: { "resource-id": "com.example:id/root", "content-desc": "keep" } as any },
      },
    } as ObserveResult;
  }

  const baseSchema = z.object({
    platform: z.enum(["ios", "android"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
    text: z.string().optional(),
  });

  async function setupAutolockedSession(): Promise<string> {
    fakeDeviceSessionManager.setConnectedDevices([androidA]);
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer);
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA]);
    const pool = new DevicePool(daemonSessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    return (await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1"))!;
  }

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    ToolRegistry.clearTools();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
    originalDiff = serverConfig.isActionsDiffObserveEnabled();
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  });

  afterEach(() => {
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    serverConfig.setActionsDiffObserveEnabled(originalDiff);
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
    registerInteractionTools();
  });

  test("a plan tapOn step neither diffs its observation nor advances the agent baseline", async () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    const sessionId = await setupAutolockedSession();

    ToolRegistry.registerDeviceAware("observe", "observe", baseSchema,
                                     async () => createStructuredToolResponse(sameScreenObserve()));
    ToolRegistry.registerDeviceAware("tapOn", "tapOn", baseSchema,
                                     async () => createStructuredToolResponse({ success: true, observation: sameScreenObserve() }));
    (ToolRegistry.getTool("tapOn") as { planExecutable: boolean }).planExecutable = true;
    (ToolRegistry.getTool("observe") as { planExecutable: boolean }).planExecutable = true;

    // Seed the agent-facing baseline via a normal (non-plan) observe call.
    await ToolRegistry.getTool("observe")!.handler({ platform: "android", __mcpSessionId: "mcp-session-1" });
    const baselineAfterObserve = daemonSessionManager!.getLastRenderedObservation(sessionId);
    expect(baselineAfterObserve).toBeDefined();

    // Run a plan whose tapOn step routes to the same session.
    const plan: Plan = { name: "p", steps: [{ tool: "tapOn", params: { text: "Go" } }] };
    const result = await planExecutor.executePlan(plan, 0, "android", androidA.deviceId, sessionId);
    expect(result.success).toBe(true);

    // The internal plan step must NOT have advanced the agent-facing baseline —
    // proving it emitted the full observation (not a diff) and left the baseline
    // for the agent's own next action.
    expect(daemonSessionManager!.getLastRenderedObservation(sessionId)).toBe(baselineAfterObserve);
  });
});

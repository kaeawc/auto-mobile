import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { createDefaultPlanExecutor } from "../../src/server/planExecutorFactory";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/**
 * End-to-end guard for issue #3053 part 2: run a real `createDefaultPlanExecutor()` step
 * through the wrapped `tool.handler` → `finalizeToolResponse` chain with
 * `--actions-diff-observe` on, and prove the plan step's observation is NEVER
 * diffed and NEVER advances the agent-facing diff baseline. The two halves are
 * unit-tested separately (PlanExecutor sets `__internalNoDiff`; the wrapped
 * handler honors it); this pins that the whole seam holds together.
 */
describe("PlanExecutor → finalize internal no-diff (end-to-end, #3053)", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };

  let planExecutor: ReturnType<typeof createDefaultPlanExecutor>;
  let fakeDeviceReadiness: FakeDeviceReadiness;
  let originalDeviceReadiness: ReturnType<
    typeof ToolRegistry.getCollaboratorsForTesting
  >["deviceReadiness"];
  let daemonSessionManager: SessionManager | undefined;
  let originalDiff: boolean;
  let restorePipelineOverrides: () => void;

  function sameScreenObserve(): ObserveResult {
    return {
      updatedAt: 1,
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      observationId: "obs-no-diff",
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
      viewHierarchy: {
        packageName: "com.example",
        hierarchy: {
          node: { $: { "resource-id": "com.example:id/root", "content-desc": "keep" } },
        },
      },
    };
  }

  const baseSchema = z.object({
    platform: z.enum(["ios", "android"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
    text: z.string().optional(),
  });

  async function setupAutolockedSession(): Promise<string> {
    fakeDeviceReadiness.setConnectedDevices([androidA]);
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA]);
    const pool = new DevicePool(
      createDevicePoolDependencies(daemonSessionManager, "daemon-session", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    return (await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1"))!;
  }

  beforeEach(() => {
    planExecutor = createDefaultPlanExecutor();
    ToolRegistry.clearTools();
    fakeDeviceReadiness = new FakeDeviceReadiness();
    originalDeviceReadiness = ToolRegistry.getCollaboratorsForTesting().deviceReadiness;
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: fakeDeviceReadiness });
    originalDiff = serverConfig.isActionsDiffObserveEnabled();
    // The default provider reads the device's displays over adb, and "emulator-5554" is a real
    // emulator on a developer's machine.
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    // #6227: `setupAutolockedSession` creates its session directly via
    // `DevicePool.autolockDevice` (bypassing the `deviceTools.ts` acquisition
    // recorder), so it drives real per-session accessibility-service setup
    // against a fake device. The shared test preload
    // (test/setup/testPreload.ts) installs a no-op readiness driver so that
    // setup cannot block on real `adb`/network.
  });

  afterEach(() => {
    restorePipelineOverrides();
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: originalDeviceReadiness });
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

    ToolRegistry.registerDeviceAware("observe", "observe", baseSchema, async () =>
      createStructuredToolResponse(sameScreenObserve()),
    );
    ToolRegistry.registerDeviceAware("tapOn", "tapOn", baseSchema, async () =>
      createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
    );
    (ToolRegistry.getTool("tapOn") as { planExecutable: boolean }).planExecutable = true;
    (ToolRegistry.getTool("observe") as { planExecutable: boolean }).planExecutable = true;

    // Seed the agent-facing baseline via a normal (non-plan) observe call.
    await ToolRegistry.getTool("observe")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
    });
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

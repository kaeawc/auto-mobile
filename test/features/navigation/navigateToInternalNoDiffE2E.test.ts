import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import { NavigateTo } from "../../../src/features/navigation/NavigateTo";
import { FakeDeviceReadiness } from "../../fakes/FakeDeviceReadiness";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";
import { createHierarchyForTest } from "../observe/observeScreenTestBuilders";
import { createReplayNavigationGraph } from "../../helpers/replayNavigationGraph";
import { FakeDisplayInventoryProvider } from "../../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { BootedDevice } from "../../../src/models";
import { DaemonState } from "../../../src/daemon/daemonState";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { DevicePool } from "../../../src/daemon/devicePool";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import { serverConfig } from "../../../src/utils/ServerConfig";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type { UIStateSetup } from "../../../src/features/navigation/interfaces/UIStateSetup";
import type { ScreenTransitionWaiter } from "../../../src/features/navigation/interfaces/ScreenTransitionWaiter";

import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

/**
 * End-to-end guard for issue #3087 (the NavigateTo half): run a real `NavigateTo`
 * replay through the wrapped `tool.handler` → `finalizeToolResponse` chain with
 * `--actions-diff-observe` on, and prove the replayed navigation step's
 * observation NEVER advances the agent-facing diff baseline
 * (`lastRenderedObservation`). This mirrors the PlanExecutor E2E
 * (test/plan/planExecutorInternalNoDiffE2E.test.ts) for the navigation call site,
 * closing the gap that a spy-on-args test cannot: it exercises the actual
 * wrapper+finalize+baseline seam, so if a future refactor stopped routing
 * NavigateTo's replay through `markInternalToolCall`, this fails while the plan
 * E2E stays green.
 *
 * The replayed `interaction.args` carry an explicit `sessionUuid` so the wrapper
 * resolves the session and `canDiff` would be true — which is exactly what makes
 * the "advances the baseline" bug observable: without the internal marker the
 * baseline WOULD be overwritten with this internal observation.
 */
describe("NavigateTo → finalize internal no-diff (end-to-end, #3087)", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };

  let fakeDeviceReadiness: FakeDeviceReadiness;
  let originalDeviceReadiness: ReturnType<
    typeof ToolRegistry.getCollaboratorsForTesting
  >["deviceReadiness"];
  let daemonSessionManager: SessionManager | undefined;
  let originalDiff: boolean;
  let restorePipelineOverrides: (() => void) | undefined;

  function sameScreenObserve(): ObserveResult {
    return {
      updatedAt: 1,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 },
      viewHierarchy: createHierarchyForTest({
        packageName: "com.example",
        hierarchy: {
          node: { "resource-id": "com.example:id/root", "content-desc": "keep" },
        },
      }),
    } as ObserveResult;
  }

  const baseSchema = z.record(z.string(), z.unknown());

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
    ToolRegistry.clearTools();
    fakeDeviceReadiness = new FakeDeviceReadiness();
    originalDeviceReadiness = ToolRegistry.getCollaboratorsForTesting().deviceReadiness;
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: fakeDeviceReadiness });
    originalDiff = serverConfig.isActionsDiffObserveEnabled();
    restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  });

  afterEach(() => {
    restorePipelineOverrides?.();
    restorePipelineOverrides = undefined;
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: originalDeviceReadiness });
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    serverConfig.setActionsDiffObserveEnabled(originalDiff);
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
  });

  test("a NavigateTo tapOn replay neither diffs its observation nor advances the agent baseline", async () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    const sessionId = await setupAutolockedSession();

    ToolRegistry.registerDeviceAware("observe", "observe", baseSchema, async () =>
      createStructuredToolResponse(sameScreenObserve()),
    );
    ToolRegistry.registerDeviceAware("tapOn", "tapOn", baseSchema, async () =>
      createStructuredToolResponse({ success: true, observation: sameScreenObserve() }),
    );

    // Seed the agent-facing baseline via a normal (non-nav) observe call.
    await ToolRegistry.getTool("observe")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
    });
    const baselineAfterObserve = daemonSessionManager!.getLastRenderedObservation(sessionId);
    expect(baselineAfterObserve).toBeDefined();

    // A single-edge path whose replayed interaction resolves to the same session
    // (sessionUuid in the stored args) — so absent the internal marker the tapOn
    // observation WOULD overwrite the baseline.
    const edge = {
      from: "Home",
      to: "Detail",
      edgeType: "tool" as const,
      timestamp: 0,
      interaction: {
        toolName: "tapOn",
        args: { action: "tap", text: "Go", platform: "android", sessionUuid: sessionId },
        timestamp: 0,
      },
    };
    const navManager = createReplayNavigationGraph(edge);
    const uiStateSetup: UIStateSetup = {
      setupUIState: async () => [],
      setupScrollPosition: async () => null,
    };
    const screenWaiter: ScreenTransitionWaiter = {
      waitForScreen: async () => true,
    };

    // Authorize replay with the running session that holds the device lock, as production does.
    const navigateTo = new NavigateTo(androidA, undefined, {
      uiStateSetup,
      screenWaiter,
      navigationManager: navManager,
      sessionUuid: sessionId,
    });
    const result = await navigateTo.execute({ targetScreen: "Detail", platform: "android" });
    expect(result.success).toBe(true);

    // The internal nav replay must NOT have advanced the agent-facing baseline —
    // it emitted the full observation (not a diff) and left the baseline for the
    // agent's own next action. Identity check: same object as before the replay.
    expect(daemonSessionManager!.getLastRenderedObservation(sessionId)).toBe(baselineAfterObserve);
  });
});

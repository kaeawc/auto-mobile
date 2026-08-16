import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { ObserveResult } from "../../src/models/ObserveResult";
import { runWithToolCapabilityContext } from "../../src/features/toolCapabilities/toolCapabilityContext";

/**
 * Internal tool-to-tool no-diff guard (issue #3053 part 2).
 *
 * PlanExecutor calls the wrapped `tool.handler` (so `finalizeToolResponse` runs)
 * with an injected `sessionUuid`, so a plan step's envelope would be diffed
 * (`--actions-diff-observe`) or stripped (`--actions-no-observe`) when those flags
 * are on. A current or future internal consumer that reads
 * `.observation.viewHierarchy` off that finalized envelope must always find the
 * full observation. The `__internalNoDiff` marker (set by PlanExecutor after
 * `schema.parse`, mirroring `__mcpSessionId`) is read by the wrapped handler and
 * forwarded to finalize as `internal`, which forces the full sanitized observation.
 *
 * These exercise the real wrapped-handler → finalize path end-to-end.
 */
describe("ToolRegistry internal no-diff guard (#3053)", () => {
  const androidA: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };
  const enabledCapabilityProfile = { isEnabled: async () => true };

  function runWithEnabledCapabilities<T>(fn: () => Promise<T>): Promise<T> {
    return runWithToolCapabilityContext(
      { sessionToolProfileService: enabledCapabilityProfile },
      fn,
    );
  }

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let daemonSessionManager: SessionManager | undefined;
  let originalDiff: boolean;
  let originalNoObserve: boolean;

  /** Same-screen observation so `isSameObservationScreen` holds between calls. */
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

  async function setupAutolockedSession(): Promise<string> {
    fakeDeviceSessionManager.setConnectedDevices([androidA]);
    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA]);
    const pool = new DevicePool(daemonSessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    const sessionId = (await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1"))!;

    // Seed the typed keep-awake slot so ensureKeepScreenAwake short-circuits
    // instead of touching a device during setup (issue #2973).
    daemonSessionManager.setKeepScreenAwake(sessionId, { applied: false, skipReason: "disabled" });
    return sessionId;
  }

  const baseSchema = z.object({
    platform: z.enum(["ios", "android"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  function registerObserveAndTap(): void {
    ToolRegistry.registerDeviceAware(
      "observe",
      "observe",
      baseSchema,
      async () => createStructuredToolResponse(sameScreenObserve())
    );
    ToolRegistry.registerDeviceAware(
      "tapOn",
      "tapOn",
      baseSchema,
      async () => createStructuredToolResponse({ success: true, observation: sameScreenObserve() })
    );
  }

  function lowConfidenceObserve(checked = false): ObserveResult {
    const observation = sameScreenObserve();
    observation.activeWindow = { appId: "com.example", activityName: ".Main", layoutSeqSum: 1 };
    observation.screenIdentity = {
      platform: "ios",
      source: "heuristic",
      confidence: "low",
      key: "bundle=com.example|focus=Search",
      components: { bundleId: "com.example", focusedField: "Search" } as any,
    };
    observation.viewHierarchy = {
      packageName: "com.example",
      hierarchy: {
        node: {
          "resource-id": "com.example:id/root",
          "content-desc": "keep",
          "node": [
            {
              "resource-id": "com.example:id/field",
              "checked": checked ? "true" : undefined,
            } as any,
          ],
        } as any,
      },
    };
    return observation;
  }

  function registerObserveAndTextActions(): void {
    ToolRegistry.registerDeviceAware(
      "observe",
      "observe",
      baseSchema,
      async () => createStructuredToolResponse(lowConfidenceObserve(false))
    );
    ToolRegistry.registerDeviceAware(
      "inputText",
      "inputText",
      baseSchema.extend({
        text: z.string().optional(),
        imeAction: z.string().optional(),
      }),
      async () => createStructuredToolResponse({ success: true, observation: lowConfidenceObserve(true) })
    );
    ToolRegistry.registerDeviceAware(
      "imeAction",
      "imeAction",
      baseSchema.extend({
        action: z.string().optional(),
      }),
      async () => createStructuredToolResponse({ success: true, observation: lowConfidenceObserve(true) })
    );
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
    originalDiff = serverConfig.isActionsDiffObserveEnabled();
    originalNoObserve = serverConfig.isActionsNoObserveEnabled();
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  });

  afterEach(() => {
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    serverConfig.setActionsDiffObserveEnabled(originalDiff);
    serverConfig.setActionsNoObserveEnabled(originalNoObserve);
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
  });

  test("EC2.3: an internal tapOn keeps the full observation; a normal tapOn diffs it", async () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    serverConfig.setActionsNoObserveEnabled(false);
    await setupAutolockedSession();
    registerObserveAndTap();

    // Establish the baseline via observe (resets lastRenderedObservation).
    await ToolRegistry.getTool("observe")!.handler({ platform: "android", __mcpSessionId: "mcp-session-1" });

    // A normal (non-internal) same-screen tapOn emits a diff.
    const normal = await ToolRegistry.getTool("tapOn")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
    });
    expect((normal.structuredContent as any).observation.isDiff).toBe(true);

    // Re-seed the baseline (the diffing tapOn advanced it), then an internal tapOn
    // must emit the FULL observation instead of a diff.
    await ToolRegistry.getTool("observe")!.handler({ platform: "android", __mcpSessionId: "mcp-session-1" });
    const internal = await ToolRegistry.getTool("tapOn")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
      __internalNoDiff: true,
    });
    const obs = (internal.structuredContent as any).observation;
    expect(obs.isDiff).toBeUndefined();
    expect(obs.viewHierarchy.hierarchy.node["resource-id"]).toBe("com.example:id/root");
  });

  test("EC2.3: an internal tapOn keeps its observation even with --actions-no-observe on", async () => {
    serverConfig.setActionsNoObserveEnabled(true);
    serverConfig.setActionsDiffObserveEnabled(false);
    await setupAutolockedSession();
    registerObserveAndTap();

    // Normal tapOn: observation stripped.
    const normal = await ToolRegistry.getTool("tapOn")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
    });
    expect((normal.structuredContent as any).observation).toBeUndefined();

    // Internal tapOn: observation preserved for internal consumers.
    const internal = await ToolRegistry.getTool("tapOn")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
      __internalNoDiff: true,
    });
    expect((internal.structuredContent as any).observation).toBeDefined();
    expect((internal.structuredContent as any).observation.viewHierarchy).toBeDefined();
  });

  test("action policy: ToolRegistry forwards submit IME args so they emit full on uncertain identity", async () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    serverConfig.setActionsNoObserveEnabled(false);
    await setupAutolockedSession();
    registerObserveAndTextActions();

    await ToolRegistry.getTool("observe")!.handler({ platform: "android", __mcpSessionId: "mcp-session-1" });
    const inputSearch = await ToolRegistry.getTool("inputText")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
      text: "query",
      imeAction: "search",
    });
    expect((inputSearch.structuredContent as any).observation.isDiff).toBeUndefined();
    expect((inputSearch.structuredContent as any).observation.viewHierarchy).toBeDefined();
    expect((inputSearch.structuredContent as any).observationDiff).toMatchObject({
      mode: "full",
      reason: "screen_changed",
    });

    await ToolRegistry.getTool("observe")!.handler({ platform: "android", __mcpSessionId: "mcp-session-1" });
    const imeGo = await runWithEnabledCapabilities(() => ToolRegistry.getTool("imeAction")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
      action: "go",
    }));
    expect((imeGo.structuredContent as any).observation.isDiff).toBeUndefined();
    expect((imeGo.structuredContent as any).observation.viewHierarchy).toBeDefined();
    expect((imeGo.structuredContent as any).observationDiff).toMatchObject({
      mode: "full",
      reason: "screen_changed",
    });
  });

  test("action policy: ToolRegistry forwards traversal IME args so they still diff", async () => {
    serverConfig.setActionsDiffObserveEnabled(true);
    serverConfig.setActionsNoObserveEnabled(false);
    await setupAutolockedSession();
    registerObserveAndTextActions();

    await ToolRegistry.getTool("observe")!.handler({ platform: "android", __mcpSessionId: "mcp-session-1" });
    const inputNext = await ToolRegistry.getTool("inputText")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
      text: "query",
      imeAction: "next",
    });
    expect((inputNext.structuredContent as any).observation.isDiff).toBe(true);
    expect((inputNext.structuredContent as any).observationDiff).toMatchObject({
      mode: "diff",
      reason: "diff_emitted",
    });

    await ToolRegistry.getTool("observe")!.handler({ platform: "android", __mcpSessionId: "mcp-session-1" });
    const imePrevious = await runWithEnabledCapabilities(() => ToolRegistry.getTool("imeAction")!.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
      action: "previous",
    }));
    expect((imePrevious.structuredContent as any).observation.isDiff).toBe(true);
    expect((imePrevious.structuredContent as any).observationDiff).toMatchObject({
      mode: "diff",
      reason: "diff_emitted",
    });
  });
});

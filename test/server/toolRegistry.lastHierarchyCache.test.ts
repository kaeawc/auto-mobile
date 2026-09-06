import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import {
  createJSONToolResponse,
  createStructuredToolResponse,
  stringifyToolResponse,
} from "../../src/utils/toolUtils";
import type { ObserveResult } from "../../src/models/ObserveResult";

/**
 * Integration coverage for the `lastHierarchy` session-cache write. The
 * ObserveResult can be the top-level structured payload (`observe`) or nested
 * under `.observation` on an action result; both must update the full,
 * untrimmed cache before `finalizeToolResponse` applies any wire projection.
 */
describe("ToolRegistry observe lastHierarchy cache repair (#2758)", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let daemonSessionManager: SessionManager | undefined;

  function makeObserveResult(): ObserveResult {
    return {
      updatedAt: 42,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: {
        hierarchy: {
          node: {
            "resource-id": "com.example:id/root",
            "view-id": "com.example:id/root", // redundant duplicate
            clickable: "false", // default-false boolean
            "content-desc": "root",
          } as any,
        },
      },
    } as ObserveResult;
  }

  /**
   * Stand up a daemon-backed session locked to `androidA` and pre-seed keep-awake
   * state so `createToolExecutionContext` performs no real device I/O. Returns the
   * resolved autolock sessionId whose cache the tool call will populate.
   */
  async function setupAutolockedSession(): Promise<string> {
    fakeDeviceSessionManager.setConnectedDevices([androidA]);

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA]);
    const pool = new DevicePool(
      daemonSessionManager,
      "daemon-session",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    const sessionId = (await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1"))!;

    // Seed the typed keep-awake slot so ensureKeepScreenAwake short-circuits
    // instead of touching a device during setup (issue #2973).
    daemonSessionManager.setKeepScreenAwake(sessionId, { applied: false, skipReason: "disabled" });
    return sessionId;
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  });

  afterEach(() => {
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
  });

  const toolSchema = z.object({
    platform: z.enum(["ios", "android"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  test("populates lastHierarchy from structuredContent and sanitizes the returned response", async () => {
    const sessionId = await setupAutolockedSession();

    const observeResult = makeObserveResult();
    // Inject a rogue `screenshot` field: the dead lastScreenshot cache chain was
    // removed (#3221), so even a payload that carries one must NOT be cached.
    (observeResult as any).screenshot = "base64-screenshot-data";
    ToolRegistry.registerDeviceAware("observe", "observe", toolSchema, async () =>
      createStructuredToolResponse(observeResult),
    );
    const tool = ToolRegistry.getTool("observe")!;

    // Skeleton is the default observe projection now; this test asserts the served
    // full view hierarchy is sanitized, so opt into the full projection per-call.
    const response = await tool.handler({
      platform: "android",
      project: "full",
      __mcpSessionId: "mcp-session-1",
    });

    // Caches are populated (were dormant before the fix) with the FULL hierarchy.
    // #2917: the canonical slots are the typed top-level fields, NOT customData.
    const cacheData = daemonSessionManager!.getSession(sessionId)!.cacheData;
    const cachedHierarchy = cacheData.lastHierarchy as any;
    expect(cachedHierarchy).toBeDefined();
    expect(cachedHierarchy.hierarchy.node["view-id"]).toBe("com.example:id/root");
    expect(cachedHierarchy.hierarchy.node.clickable).toBe("false");
    // Observe timestamp is stamped alongside the hierarchy.
    expect(typeof cacheData.lastObserveTime).toBe("number");
    // The dead screenshot cache chain is removed (#3221): no lastScreenshot slot
    // is written even when the payload carries a `screenshot` field.
    expect((cacheData as Record<string, unknown>).lastScreenshot).toBeUndefined();
    // The dormant-decoy keys never leak into an untyped bag — the `customData`
    // escape hatch no longer exists at all (#2917/#2973).
    expect((cacheData as Record<string, unknown>).customData).toBeUndefined();

    // Returned wire response is sanitized at the chokepoint.
    const returnedRoot = (response.structuredContent as ObserveResult).viewHierarchy!.hierarchy
      .node as any;
    expect(returnedRoot["view-id"]).toBeUndefined();
    expect(returnedRoot.clickable).toBeUndefined();
    expect(returnedRoot["content-desc"]).toBe("root");
  });

  test("sanitizes a tapOn action response's .observation end-to-end through the chokepoint", async () => {
    const sessionId = await setupAutolockedSession();

    const observation = makeObserveResult();
    ToolRegistry.registerDeviceAware("tapOn", "tapOn", toolSchema, async () =>
      createStructuredToolResponse({
        success: true,
        message: "Tapped on element",
        observation,
      }),
    );
    const tool = ToolRegistry.getTool("tapOn")!;

    const response = await tool.handler({
      platform: "android",
      // project:"full" opts out of the #5872 skeleton default so this test can
      // assert the raw hierarchy is sanitized end-to-end through the chokepoint.
      project: "full",
      __mcpSessionId: "mcp-session-1",
    });

    // Action's nested observation is sanitized in BOTH representations.
    const scRoot = (response.structuredContent as any).observation.viewHierarchy.hierarchy.node;
    expect(scRoot["view-id"]).toBeUndefined();
    expect(scRoot.clickable).toBeUndefined();
    expect((response.structuredContent as any).success).toBe(true);

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.observation.viewHierarchy.hierarchy.node["view-id"]).toBeUndefined();
    expect(response.content[0].text).toBe(stringifyToolResponse(response.structuredContent));

    const cacheData = daemonSessionManager!.getSession(sessionId)!.cacheData;
    const cachedHierarchy = cacheData.lastHierarchy as any;
    expect(cachedHierarchy).toBeDefined();
    expect(cachedHierarchy.hierarchy.node["view-id"]).toBe("com.example:id/root");
    expect(cachedHierarchy.hierarchy.node.clickable).toBe("false");
    expect(typeof cacheData.lastObserveTime).toBe("number");
    expect((cacheData as Record<string, unknown>).customData).toBeUndefined();
  });

  test("caches a text-only action response's nested observation", async () => {
    const sessionId = await setupAutolockedSession();
    const observation = makeObserveResult();
    ToolRegistry.registerDeviceAware("inputText", "inputText", toolSchema, async () =>
      createJSONToolResponse({
        success: true,
        message: "Input complete",
        observation,
      }),
    );
    const tool = ToolRegistry.getTool("inputText")!;

    await tool.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
    });

    const cacheData = daemonSessionManager!.getSession(sessionId)!.cacheData;
    const cachedHierarchy = cacheData.lastHierarchy as any;
    expect(cachedHierarchy).toBeDefined();
    expect(cachedHierarchy.hierarchy.node["view-id"]).toBe("com.example:id/root");
    expect(cachedHierarchy.hierarchy.node.clickable).toBe("false");
    expect(typeof cacheData.lastObserveTime).toBe("number");
  });
});

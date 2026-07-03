import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { KEEP_SCREEN_AWAKE_STATE_KEY } from "../../src/utils/KeepScreenAwakeManager";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { ObserveResult } from "../../src/models/ObserveResult";

/**
 * Integration coverage for issue #2758: the `lastHierarchy` session-cache write
 * must read the ObserveResult out of the MCP envelope's `structuredContent`
 * (previously it read `response.viewHierarchy`, which never existed on the
 * envelope, so the cache was silently never populated — the #2761 diff baseline
 * depends on it). Also verifies the `finalizeToolResponse` chokepoint sanitizes
 * the observe response while the cache keeps the full untrimmed hierarchy.
 */
describe("ToolRegistry observe lastHierarchy cache repair (#2758)", () => {
  const androidA: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let daemonSessionManager: SessionManager | undefined;
  let originalDropElements: boolean;

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
            "clickable": "false", // default-false boolean
            "content-desc": "root",
          } as any,
        },
      },
    } as ObserveResult;
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
    originalDropElements = serverConfig.isObserveResultDropElementsEnabled();
    serverConfig.setObserveResultDropElementsEnabled(false);
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
  });

  afterEach(() => {
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    serverConfig.setObserveResultDropElementsEnabled(originalDropElements);
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
  });

  test("populates lastHierarchy from structuredContent and sanitizes the returned response", async () => {
    fakeDeviceSessionManager.setConnectedDevices([androidA]);

    const timer = new FakeTimer();
    daemonSessionManager = new SessionManager(timer);
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA]);
    const pool = new DevicePool(daemonSessionManager, "daemon-session", timer, undefined, fakeDeviceUtils);
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    const sessionId = await pool.autolockDevice(androidA.deviceId, "android", "mcp-session-1");

    // Pre-seed keep-awake state so createToolExecutionContext skips real device I/O.
    const session = daemonSessionManager.getSession(sessionId)!;
    daemonSessionManager.updateSessionCache(sessionId, {
      ...session.cacheData,
      customData: {
        ...(session.cacheData.customData ?? {}),
        [KEEP_SCREEN_AWAKE_STATE_KEY]: { applied: false, skipReason: "test" },
      },
    });

    const observeResult = makeObserveResult();
    ToolRegistry.registerDeviceAware(
      "observe",
      "observe",
      z.object({
        platform: z.enum(["ios", "android"]).optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      async () => createStructuredToolResponse(observeResult)
    );
    const tool = ToolRegistry.getTool("observe")!;

    const response = await tool.handler({
      platform: "android",
      __mcpSessionId: "mcp-session-1",
    });

    // Cache is populated (was dormant before the fix) with the FULL hierarchy.
    const cached = daemonSessionManager.getSession(sessionId)!.cacheData.customData?.lastHierarchy as any;
    expect(cached).toBeDefined();
    expect(cached.hierarchy.node["view-id"]).toBe("com.example:id/root");
    expect(cached.hierarchy.node.clickable).toBe("false");

    // Returned wire response is sanitized at the chokepoint.
    const returnedRoot = (response.structuredContent as ObserveResult).viewHierarchy!.hierarchy.node as any;
    expect(returnedRoot["view-id"]).toBeUndefined();
    expect(returnedRoot.clickable).toBeUndefined();
    expect(returnedRoot["content-desc"]).toBe("root");
  });
});

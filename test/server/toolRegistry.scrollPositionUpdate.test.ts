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
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { NavigationGraphManager } from "../../src/features/navigation/NavigationGraphManager";
import type { ScrollPosition } from "../../src/utils/interfaces/NavigationGraph";

/**
 * Integration coverage for issue #2897: the swipeOn scroll-position update block
 * in `toolRegistry` must read `success`/`found` out of the MCP envelope's
 * `structuredContent`. `createStructuredToolResponse` only hoists `success`/`error`
 * to the envelope top level — `found` lives under `structuredContent`, so the prior
 * `response?.found` read was always `undefined` and `updateScrollPosition` never ran
 * after a `swipeOn` with `lookFor`. Same envelope-vs-structuredContent bug class as
 * #2758 / PR #2891.
 */
describe("ToolRegistry swipeOn scroll-position update repair (#2897)", () => {
  const androidA: BootedDevice = { name: "Pixel A", deviceId: "emulator-5554", platform: "android" };

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let daemonSessionManager: SessionManager | undefined;
  let spiedSessionIds: string[];

  /**
   * Stand up a daemon-backed session locked to `androidA` and pre-seed keep-awake
   * state so `createToolExecutionContext` performs no real device I/O. Returns the
   * resolved autolock sessionId whose NavigationGraphManager the tool call targets.
   */
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

  /**
   * Spy on the session-scoped NavigationGraphManager's updateScrollPosition,
   * capturing every ScrollPosition it is called with. Getting the instance here
   * eagerly guarantees the tool handler resolves the same instance later.
   */
  function spyScrollPosition(sessionId: string): ScrollPosition[] {
    spiedSessionIds.push(sessionId);
    const manager = NavigationGraphManager.getInstanceForSession(sessionId);
    const captured: ScrollPosition[] = [];
    (manager as any).updateScrollPosition = (scrollPosition: ScrollPosition) => {
      captured.push(scrollPosition);
    };
    return captured;
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    spiedSessionIds = [];
  });

  afterEach(() => {
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    for (const sessionId of spiedSessionIds) {
      NavigationGraphManager.releaseSession(sessionId);
    }
    delete process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK;
    delete process.env.AUTO_MOBILE_DEVICE_POOL_AUTOLOCK;
  });

  const swipeSchema = z.object({
    platform: z.enum(["ios", "android"]).optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    lookFor: z.any().optional(),
    container: z.any().optional(),
    speed: z.number().optional(),
  });

  function registerSwipeOn(found: boolean): void {
    ToolRegistry.registerDeviceAware(
      "swipeOn",
      "swipeOn",
      swipeSchema,
      async () => createStructuredToolResponse({
        success: true,
        found,
        message: found ? "Swiped up and found element after 1 swipe(s)" : "Swiped up",
        observation: {},
        scrollIterations: 1,
      })
    );
  }

  test("invokes updateScrollPosition when swipeOn with lookFor reports found=true", async () => {
    const sessionId = await setupAutolockedSession();
    const captured = spyScrollPosition(sessionId);
    registerSwipeOn(true);
    const tool = ToolRegistry.getTool("swipeOn")!;

    await tool.handler({
      platform: "android",
      direction: "up",
      lookFor: { text: "Target", elementId: "com.example:id/target" },
      __mcpSessionId: "mcp-session-1",
    });

    expect(captured.length).toBe(1);
    expect(captured[0].direction).toBe("up");
    expect(captured[0].targetElement.text).toBe("Target");
    expect(captured[0].targetElement.resourceId).toBe("com.example:id/target");
  });

  test("does NOT invoke updateScrollPosition when found=false", async () => {
    const sessionId = await setupAutolockedSession();
    const captured = spyScrollPosition(sessionId);
    registerSwipeOn(false);
    const tool = ToolRegistry.getTool("swipeOn")!;

    await tool.handler({
      platform: "android",
      direction: "up",
      lookFor: { text: "Target" },
      __mcpSessionId: "mcp-session-1",
    });

    expect(captured.length).toBe(0);
  });

  test("does NOT invoke updateScrollPosition when lookFor is absent", async () => {
    const sessionId = await setupAutolockedSession();
    const captured = spyScrollPosition(sessionId);
    registerSwipeOn(true);
    const tool = ToolRegistry.getTool("swipeOn")!;

    await tool.handler({
      platform: "android",
      direction: "up",
      __mcpSessionId: "mcp-session-1",
    });

    expect(captured.length).toBe(0);
  });
});

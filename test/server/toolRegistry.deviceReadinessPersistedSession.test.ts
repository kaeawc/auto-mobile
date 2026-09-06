import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { AndroidCtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { DeviceSession } from "../../src/db/types";

/**
 * #6227: `createToolExecutionContext`'s persisted daemon-session path — a
 * caller-provided `sessionUuid` recovered from a persisted, non-terminal
 * device-session row (e.g. live during a daemon restart) rather than freshly
 * minted — must honor a tool's declared `deviceReadiness` the same way the
 * legacy/no-session path already does via `DeviceSessionManager.ensureDeviceReady`'s
 * `readiness` option. A `booted`-only tool must never pay for (or fail on)
 * full CtrlProxy accessibility-service setup on this path.
 */
describe("ToolRegistry persisted daemon-session deviceReadiness gating (#6227)", () => {
  const androidA: BootedDevice = {
    name: "Pixel A",
    deviceId: "emulator-5554",
    platform: "android",
  };

  const nonTerminalPersisted = (sessionUuid: string, deviceId: string): DeviceSession => ({
    session_uuid: sessionUuid,
    device_id: deviceId,
    platform: "android",
    status: "active",
    source: null,
    autolock_enabled: 0,
    mcp_session_id: null,
    daemon_session_id: "old-daemon",
    created_at_ms: 1,
    last_used_at_ms: 20,
    expires_at_ms: 30,
    released_at_ms: null,
    release_reason: null,
    session_timeout_ms: 60_000,
    heartbeat_timeout_ms: 60_000,
    has_received_heartbeat: 1,
    created_at: "2026-09-03T00:00:00.000Z",
    updated_at: "2026-09-03T00:00:00.000Z",
  });

  let fakeDeviceSessionManager: FakeDeviceSessionManager;
  let originalDeviceSessionManager: unknown;
  let daemonSessionManager: SessionManager | undefined;
  let originalGetInstance: typeof AndroidCtrlProxyManager.getInstance;
  let originalClientGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let setupCalls: number;

  /**
   * Stand up a daemon with a device pool that has NOT bound `sessionUuid` to any
   * device yet, but whose persistence layer reports `sessionUuid` as a
   * persisted, non-terminal row (recovered across a daemon restart). This
   * drives `createToolExecutionContext` through its persisted-session recovery
   * branch, which is exactly the "new session" branch that runs
   * `setupSession`'s automation-only setup — the branch this issue's gate must
   * skip when the tool declares `deviceReadiness: "booted"`.
   */
  async function setupPersistedDaemonSession(sessionUuid: string): Promise<void> {
    fakeDeviceSessionManager.setConnectedDevices([androidA]);

    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const persisted = nonTerminalPersisted(sessionUuid, androidA.deviceId);
    daemonSessionManager = new SessionManager(timer, {
      async getSession() {
        return persisted;
      },
      async upsertActiveSession(): Promise<void> {},
      async recordActivity(): Promise<void> {},
      async markReleased(): Promise<void> {},
      async markStaleActiveSessionsExpired(): Promise<void> {},
    });
    const fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [androidA]);
    const pool = new DevicePool(
      daemonSessionManager,
      "new-daemon",
      timer,
      undefined,
      fakeDeviceUtils,
    );
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = (ToolRegistry as any).deviceSessionManager;
    (ToolRegistry as any).deviceSessionManager = fakeDeviceSessionManager;
    (ToolRegistry as any).toolCallRepository = {
      async recordToolCall(): Promise<void> {},
    };
    setupCalls = 0;
    originalGetInstance = AndroidCtrlProxyManager.getInstance;
    originalClientGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyManager.getInstance = () =>
      ({
        resetSetupState: () => {},
        setup: async () => {
          setupCalls += 1;
          return { success: true, message: "ok" };
        },
      }) as any;
    AndroidCtrlProxyClient.getInstance = (() => ({
      waitForConnection: async () => true,
      close: async () => {},
    })) as any;
    AndroidCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    (ToolRegistry as any).deviceSessionManager = originalDeviceSessionManager;
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    AndroidCtrlProxyManager.getInstance = originalGetInstance;
    AndroidCtrlProxyClient.getInstance = originalClientGetInstance;
    AndroidCtrlProxyClient.resetInstances();
  });

  test("skips accessibility-service setup for a booted-only tool on the persisted session path", async () => {
    const sessionUuid = "restarted-session-booted";
    await setupPersistedDaemonSession(sessionUuid);

    ToolRegistry.registerDeviceAware(
      "bootedOnlyProbe",
      "Booted-only probe",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ success: true }),
      { deviceReadiness: "booted" },
    );

    const response = await ToolRegistry.getTool("bootedOnlyProbe")!.handler({
      platform: "android",
      sessionUuid,
    });

    expect(response).toMatchObject({ success: true });
    expect(setupCalls).toBe(0);
    expect(daemonSessionManager?.getSession(sessionUuid)?.assignedDevice).toBe(androidA.deviceId);
  });

  test("still runs accessibility-service setup for an automationReady tool on the persisted session path", async () => {
    const sessionUuid = "restarted-session-automation-ready";
    await setupPersistedDaemonSession(sessionUuid);

    ToolRegistry.registerDeviceAware(
      "automationReadyProbe",
      "Automation-ready probe",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ success: true }),
      { deviceReadiness: "automationReady" },
    );

    const response = await ToolRegistry.getTool("automationReadyProbe")!.handler({
      platform: "android",
      sessionUuid,
    });

    expect(response).toMatchObject({ success: true });
    expect(setupCalls).toBe(1);
  });

  test("upgrades setup when a booted-first persisted session is later reused by an automationReady tool (#6227)", async () => {
    const sessionUuid = "restarted-session-upgrade";
    await setupPersistedDaemonSession(sessionUuid);

    ToolRegistry.registerDeviceAware(
      "bootedFirstProbe",
      "Booted-first probe",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ success: true }),
      { deviceReadiness: "booted" },
    );
    ToolRegistry.registerDeviceAware(
      "automationReadySecondProbe",
      "Automation-ready-second probe",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ success: true }),
      { deviceReadiness: "automationReady" },
    );

    const bootedResponse = await ToolRegistry.getTool("bootedFirstProbe")!.handler({
      platform: "android",
      sessionUuid,
    });
    expect(bootedResponse).toMatchObject({ success: true });
    expect(setupCalls).toBe(0);

    // Same recovered sessionUuid, now reused by an automationReady tool — the
    // `existingSession` fast path must upgrade rather than leave the session
    // disconnected/unprepared (#6227 P1 follow-up).
    const automationResponse = await ToolRegistry.getTool("automationReadySecondProbe")!.handler({
      platform: "android",
      sessionUuid,
    });
    expect(automationResponse).toMatchObject({ success: true });
    expect(setupCalls).toBe(1);
    expect(daemonSessionManager?.getDeviceReadiness(sessionUuid)).toBe("automationReady");
  });

  test("a tool not declaring deviceReadiness is unaffected (defaults to full setup, matching pre-fix behavior)", async () => {
    const sessionUuid = "restarted-session-default";
    await setupPersistedDaemonSession(sessionUuid);

    ToolRegistry.registerDeviceAware(
      "defaultReadinessProbe",
      "Default readiness probe",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ success: true }),
    );

    const response = await ToolRegistry.getTool("defaultReadinessProbe")!.handler({
      platform: "android",
      sessionUuid,
    });

    expect(response).toMatchObject({ success: true });
    expect(setupCalls).toBe(1);
  });
});

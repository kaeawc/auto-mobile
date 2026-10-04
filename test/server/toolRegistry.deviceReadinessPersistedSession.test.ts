import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { BootedDevice } from "../../src/models";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  SessionManager,
  TerminalSessionError,
  type SessionRecoveryTarget,
} from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { stubCtrlProxySetup, type CtrlProxySetupStub } from "../helpers/stubCtrlProxySetup";
import type { DeviceSession } from "../../src/db/types";
import { deviceRestartReleaseReason } from "../../src/db/deviceSessionRepository";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../../src/daemon/constants";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";
import { ActionableError } from "../../src/models/ActionableError";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";

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
    stable_device_id: androidA.name,
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
  let originalToolCallRepository: unknown;
  let daemonSessionManager: SessionManager | undefined;
  let ctrlProxyStub: CtrlProxySetupStub;
  let restoreInventory: () => void;

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
    // Keep the cleanup interval parked while asserting the recovered session.
    // Auto-advance drives recurring intervals as fast as the event loop allows,
    // which can expire this 60-second session during a slower coverage run.
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
      createDevicePoolDependencies(daemonSessionManager, "new-daemon", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    await pool.initializeWithDevices([androidA]);
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
  }

  async function setupRestartRecovery() {
    const sessionUuid = "restart-deadline-session";
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    const persisted = {
      ...nonTerminalPersisted(sessionUuid, androidA.deviceId),
      status: "released" as const,
      released_at_ms: 0,
      release_reason: deviceRestartReleaseReason(androidA.name),
      // Keep the issued session alive beyond its separate restart grace period.
      expires_at_ms: 600_000,
    };
    persistence.seed(persisted);
    daemonSessionManager = new SessionManager(timer, persistence);
    daemonSessionManager.stopCleanupTimer();
    const incidents = new InMemoryEmulatorLossIncidentStore(timer);
    const manager = new FakeDeviceManager();
    const pool = new DevicePool(
      createDevicePoolDependencies(daemonSessionManager, "new-daemon", {
        timer,
        deviceManager: manager,
        retryExecutor: new DefaultRetryExecutor(timer),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        emulatorLossIncidentStore: incidents,
      }),
    );
    DaemonState.getInstance().initialize(daemonSessionManager, pool);
    const targets: (SessionRecoveryTarget | undefined)[] = [];
    const assign = pool.assignDeviceToSession.bind(pool);
    spyOn(pool, "assignDeviceToSession").mockImplementation((id, platform, target) => {
      targets.push(target);
      return assign(id, platform, target);
    });
    ToolRegistry.registerDeviceAware(
      "restartDeadlineProbe",
      "Restart deadline probe",
      z.object({ sessionUuid: z.string().optional() }),
      async () => ({ success: true }),
      { deviceReadiness: "booted" },
    );
    const call = (deadline?: number) =>
      ToolRegistry.getTool("restartDeadlineProbe")!.handler({
        sessionUuid,
        platform: "android",
        ...(deadline === undefined ? {} : { [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: deadline }),
      });
    return { timer, persistence, persisted, targets, call, incidents, manager, pool };
  }

  beforeEach(() => {
    ToolRegistry.clearTools();
    restoreInventory = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    fakeDeviceSessionManager = new FakeDeviceSessionManager();
    originalDeviceSessionManager = Reflect.get(ToolRegistry, "deviceSessionManager");
    Reflect.set(ToolRegistry, "deviceSessionManager", fakeDeviceSessionManager);
    originalToolCallRepository = Reflect.get(ToolRegistry, "toolCallRepository");
    Reflect.set(ToolRegistry, "toolCallRepository", {
      async recordToolCall(): Promise<void> {},
    });
    ctrlProxyStub = stubCtrlProxySetup();
  });

  afterEach(() => {
    restoreInventory();
    Reflect.set(ToolRegistry, "deviceSessionManager", originalDeviceSessionManager);
    Reflect.set(ToolRegistry, "toolCallRepository", originalToolCallRepository);
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    daemonSessionManager?.stopCleanupTimer();
    ctrlProxyStub.restore();
  });

  test.each([undefined, 180_500, 241_000])(
    "registry settled loss terminalizes after the restart window with request deadline %s",
    async (deadline) => {
      const { timer, call, persistence, persisted, incidents, manager, pool } =
        await setupRestartRecovery();
      const incident = await incidents.open({
        deviceId: androidA.deviceId,
        avdName: androidA.name,
        detectionPath: "watched-process-exit",
        processExit: { code: 1, signal: null },
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
        session: {
          sessionUuid: persisted.session_uuid,
          state: "recovering",
          lastHeartbeatMs: 0,
          hasReceivedHeartbeat: false,
          heartbeatTimeoutMs: 60_000,
        },
      });
      await incidents.completeRecovery(incident.id, "not-attempted");
      const originalRow = { ...persisted };
      await expect(call(120_000)).rejects.toThrow("180 seconds remaining");
      expect(await persistence.getSession?.(persisted.session_uuid)).toEqual(originalRow);
      timer.advanceTime(240_000);
      await expect(call(deadline)).rejects.toThrow("recovery reason: target-absent");
      expect(await persistence.getSession?.(persisted.session_uuid)).toMatchObject({
        release_reason: "identity-recovery-target-absent",
        released_at_ms: 240_000,
      });
      manager.bootedDevices = [androidA];
      await pool.addDevice(androidA);
      await expect(call(360_000)).rejects.toThrow(TerminalSessionError);
    },
  );

  test.each([181_000, 240_000])(
    "registry deadline %s does not interrupt terminalization at the restart deadline",
    async (deadline) => {
      const { timer, call, persistence, persisted } = await setupRestartRecovery();
      const request = call(deadline).catch((error: unknown) => error);
      await drainUntilQuiescent(timer);
      timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS);
      expect(String(await request)).toContain("recovery reason: target-absent");
      expect(await persistence.getSession?.(persisted.session_uuid)).toMatchObject({
        release_reason: "identity-recovery-target-absent",
      });
      await expect(call(deadline)).rejects.toThrow(TerminalSessionError);
    },
  );

  test("registry settled restart loss carries recovery fields to the client error payload", async () => {
    const { timer, call, persisted, incidents } = await setupRestartRecovery();
    const incident = await incidents.open({
      deviceId: androidA.deviceId,
      avdName: androidA.name,
      detectionPath: "watched-process-exit",
      processExit: { code: null, signal: "SIGKILL" },
      recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      session: {
        sessionUuid: persisted.session_uuid,
        state: "recovering",
        lastHeartbeatMs: 0,
        hasReceivedHeartbeat: false,
        heartbeatTimeoutMs: 60_000,
      },
    });
    await incidents.completeRecovery(incident.id, "not-attempted");
    timer.advanceTime(60_001);
    const error = await call(120_000).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ActionableError);
    expect(error).not.toHaveProperty("code");
    const details = {
      sessionUuid: persisted.session_uuid,
      platform: "android",
      deviceId: androidA.deviceId,
      stableDeviceId: androidA.name,
      incidentId: incident.id,
      detectionPath: "watched-process-exit",
      processExit: { code: null, signal: "SIGKILL" },
      recoveryOutcome: "not-attempted",
      retry: { sameSession: true },
      recoveryWindowRemainingMs: 119_999,
      fallback: { action: "acquire_replacement_session", tools: ["getAndroid", "getApple"] },
    };
    expect(error).toMatchObject({ details });
    const result = shapeToolCallError(error, { toolName: "restartDeadlineProbe", source: "MCP" });
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("structuredContent");
    const payload = JSON.parse(result.content[0].text);
    expect(payload).toEqual({ error: { message: error.message, ...details } });
    expect(payload.error.message).toContain("(120 seconds remaining)");
    expect(payload.error.message.toLowerCase().match(/acquire a new device/g)).toHaveLength(1);
    expect(payload.error.message.indexOf("The session can still resume")).toBeLessThan(
      payload.error.message.indexOf("acquire a new device"),
    );
  });

  test("registry restart recovery returns the actionable error before the request deadline", async () => {
    const { timer, call, targets, persisted, persistence } = await setupRestartRecovery();
    const originalRow = { ...persisted };
    let failure: unknown;
    const request = call(3_500).catch((error: unknown) => {
      failure = error;
    });
    await drainUntilQuiescent(timer);
    expect(targets[0]?.requestDeadlineMs).toBe(3_500);
    expect(targets[0]?.restartRecoveryDeadlineMs).toBe(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    timer.advanceTime(2_499);
    await drainUntilQuiescent(timer);
    expect(failure).toBeUndefined();
    timer.advanceTime(1);
    await request;
    expect(String(failure)).toContain("Cannot safely recover session");
    expect(String(failure)).toContain("getAndroid or getApple");
    expect(String(failure)).toContain("178 seconds remaining");
    expect(failure).toMatchObject({
      details: {
        deviceId: androidA.deviceId,
        stableDeviceId: androidA.name,
        retry: { sameSession: true },
        recoveryWindowRemainingMs: 177_500,
        fallback: { action: "acquire_replacement_session", tools: ["getAndroid", "getApple"] },
      },
    });
    expect(failure).not.toHaveProperty("details.incidentId");
    const result = shapeToolCallError(failure, { toolName: "restartDeadlineProbe", source: "MCP" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error.recoveryWindowRemainingMs).toBe(177_500);
    expect(payload.error).not.toHaveProperty("incidentId");
    expect(timer.now()).toBe(2_500);
    expect(timer.getPendingTimeouts()).toEqual([]);
    expect(await persistence.getSession?.(persisted.session_uuid)).toEqual(originalRow);
  });

  test("registry restart recovery without a deadline retains the restart recovery window", async () => {
    const { timer, call, targets } = await setupRestartRecovery();
    let failure: unknown;
    const request = call().catch((error: unknown) => {
      failure = error;
    });
    await drainUntilQuiescent(timer);
    expect(targets[0]?.requestDeadlineMs).toBeUndefined();
    timer.advanceTime(DEFAULT_DEVICE_READY_TIMEOUT_MS - 1);
    await drainUntilQuiescent(timer);
    expect(failure).toBeUndefined();
    timer.advanceTime(1);
    await request;
    expect(String(failure)).toContain("Cannot safely recover session");
    expect(String(failure)).toContain("recovery reason: target-absent");
    expect(timer.now()).toBe(DEFAULT_DEVICE_READY_TIMEOUT_MS);
  });

  test.each([undefined, 7_500])(
    "a second registry recovery call uses only its own deadline (%s)",
    async (secondDeadline) => {
      const { timer, call, targets, persistence, persisted } = await setupRestartRecovery();
      const first = call(3_500).catch((error: unknown) => error);
      await drainUntilQuiescent(timer);
      timer.advanceTime(2_500);
      expect(String(await first)).toContain("Cannot safely recover session");
      const second = call(secondDeadline).catch((error: unknown) => error);
      await drainUntilQuiescent(timer);
      expect(targets).toHaveLength(2);
      expect(targets[1]?.requestDeadlineMs).toBe(secondDeadline);
      expect(targets[1]).not.toBe(targets[0]);
      expect(targets[0]?.requestDeadlineMs).toBe(3_500);
      expect(await persistence.getSession?.(persisted.session_uuid)).not.toHaveProperty(
        "requestDeadlineMs",
      );
      const expectedEnd =
        secondDeadline === undefined ? DEFAULT_DEVICE_READY_TIMEOUT_MS : secondDeadline - 1_000;
      timer.advanceTime(expectedEnd - timer.now());
      expect(String(await second)).toContain("Cannot safely recover session");
      expect(timer.now()).toBe(expectedEnd);
    },
  );

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
    expect(ctrlProxyStub.setupCallCount()).toBe(0);
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
    expect(ctrlProxyStub.setupCallCount()).toBe(1);
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
    expect(ctrlProxyStub.setupCallCount()).toBe(0);

    // Same recovered sessionUuid, now reused by an automationReady tool — the
    // `existingSession` fast path must upgrade rather than leave the session
    // disconnected/unprepared (#6227 P1 follow-up).
    const automationResponse = await ToolRegistry.getTool("automationReadySecondProbe")!.handler({
      platform: "android",
      sessionUuid,
    });
    expect(automationResponse).toMatchObject({ success: true });
    expect(ctrlProxyStub.setupCallCount()).toBe(1);
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
    expect(ctrlProxyStub.setupCallCount()).toBe(1);
  });
});

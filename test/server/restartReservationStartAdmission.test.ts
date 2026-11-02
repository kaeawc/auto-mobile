import { toolJson } from "../helpers/toolResponse";
import { withWireDeadline } from "../helpers/requestDeadline";
import { isolateEmptyToolRegistry } from "../helpers/withTemporaryTool";
import { describe, expect, spyOn } from "bun:test";
import { z } from "zod/v4";
import { SessionRecoveryAssignmentError } from "../../src/models/SessionRecoveryAssignmentError";
import { InMemoryEmulatorLossIncidentStore } from "../../src/daemon/emulatorLossIncident";
import { McpSessionRecoveryInProgressError } from "../../src/daemon/McpSessionRecoveryInProgressError";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import { SessionManager, TerminalSessionError } from "../../src/daemon/sessionManager";
import { getDbWriteBarrier, resetDbWriteBarrier } from "../../src/db/dbWriteBarrier";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import type { BootedDevice, DeviceInfo, Platform } from "../../src/models";
import {
  getDeviceToolsDependencies,
  registerDeviceTools,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  drainMicrotasks,
  drainUntil,
  settleWithFakeTime,
  settleByFakeEvents,
} from "../helpers/fakeTimerStepping";
import { warmedTests } from "../helpers/warmedTests";

isolateEmptyToolRegistry();

const HOLDER = "restart-holder";
const CONNECTION = "holder-connection";
class RestartDeviceManager extends FakeDeviceUtils {
  beforeReady?: () => Promise<void>;
  override async waitForDeviceReady(...args: Parameters<FakeDeviceUtils["waitForDeviceReady"]>) {
    await this.beforeReady?.();
    return super.waitForDeviceReady(...args);
  }
  override async killDevice(device: BootedDevice) {
    await super.killDevice(device);
    this.setBootedDevices(device.platform, []);
  }
}

describe("start admission and owner resume for restart reservations", () => {
  const cleanups: Array<() => void> = [];
  const test = warmedTests(() => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      cleanup();
    }
    resetDeviceToolsDependencies();
    ToolRegistry.clearTools();
    DaemonState.getInstance().reset();
    resetDbWriteBarrier();
    expect(ToolRegistry.getAllTools()).toHaveLength(0);
    expect(DaemonState.getInstance().isInitialized()).toBe(false);
    expect(getDbWriteBarrier().inFlightCount()).toBe(0);
    expect(getDbWriteBarrier().isDraining()).toBe(false);
    expect(getDeviceToolsDependencies().deviceManagerFactory).not.toBe(lastManagerFactory);
  });
  let lastManagerFactory: (() => RestartDeviceManager) | undefined;

  async function fixture(
    options: {
      platform?: Platform;
      running?: boolean;
      connection?: string;
      label?: boolean;
      idleMs?: number;
      autolock?: boolean;
      ownerToken?: string;
      serialReuse?: boolean;
    } = {},
  ) {
    const platform = options.platform ?? "android";
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: options.autolock ? "1" : "0" };
    const holder = options.label ? `${HOLDER}:phone` : HOLDER;
    const timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    const manager = new RestartDeviceManager();
    const device: BootedDevice = {
      platform,
      name: "restart-phone",
      deviceId: platform === "android" ? "emulator-5554" : "restart-sim",
    };
    const image: DeviceInfo = { ...device, source: "local", isRunning: false };
    manager.setBootedDevices(platform, [device]);
    manager.setDeviceImages(platform, [image]);
    manager.setMockChildProcess(device.name, null);
    const persistence = new FakeDeviceSessionPersistence();
    const incidents = new InMemoryEmulatorLossIncidentStore(timer);
    const autolockWrites: Array<{ sessionId: string; mcpSessionId: string | null }> = [];
    const sessions = new SessionManager(timer, persistence, {
      barrier: () => new FakeDbWriteBarrier(),
      keepScreenAwakeRestorer: () => ({ restore: async () => ({ status: "restored" as const }) }),
    });
    sessions.attachDaemonSessionId("restart-start-daemon");
    sessions.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "restart-start-daemon", {
        env,
        timer,
        deviceManager: manager,
        emulatorLossIncidentStore: incidents,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
        idGenerator: new FakeIdGenerator(options.autolock ? [holder] : []),
        deviceSessionRepository: {
          markAutolockSession: async (id, metadata) => {
            autolockWrites.push({ sessionId: id, mcpSessionId: metadata.mcpSessionId ?? null });
            const row = (await persistence.getSession!(id))!;
            row.autolock_enabled = 1;
            row.mcp_session_id = metadata.mcpSessionId ?? null;
          },
        },
      }),
    );
    const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      env,
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    const previousCollaborators = ToolRegistry.getCollaboratorsForTesting();
    const deviceSessions = new FakeDeviceReadiness();
    deviceSessions.setConnectedDevices([device]);
    ToolRegistry.setCollaboratorsForTesting({ deviceReadiness: deviceSessions });
    ToolRegistry.setCollaboratorsForTesting({
      toolCallRepository: { recordToolCall: async () => {} },
    });
    cleanups.push(() => {
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      restorePipeline();
      ToolRegistry.setCollaboratorsForTesting(previousCollaborators);
      expect(ToolRegistry.getCollaboratorsForTesting()).toEqual(previousCollaborators);
    });
    lastManagerFactory = () => manager;
    setDeviceToolsDependencies({
      env,
      timer,
      idGenerator: new FakeIdGenerator(),
      deviceManagerFactory: lastManagerFactory,
      notifyResourcesChanged: async () => {},
      notifyDeviceInventoryResourcesChanged: async () => {},
      syncInstalledAppResourceRegistry: async () => false,
      ensureCtrlProxyReady: async () => {},
    });
    await pool.initializeWithDevices([device]);
    DaemonState.getInstance().initialize(sessions, pool);
    if (options.autolock) {
      expect(
        await pool.autolockDevice(
          device.deviceId,
          platform,
          options.connection,
          undefined,
          undefined,
          device,
        ),
      ).toBe(holder);
    } else {
      await pool.bindOrReuseDeviceSession({
        sessionId: holder,
        deviceId: device.deviceId,
        platform,
        expectedIdentity: device,
        allowSessionRebind: false,
        mcpSessionId: options.connection,
      });
    }
    // Keep idle expiry beyond the fixed restart window, so the retry pin measures that window.
    const live = sessions.getSession(holder)!;
    live.expiresAt = timer.now() + (options.idleMs ?? 600_000);
    live.sessionTimeoutMs = options.idleMs ?? 600_000;
    const liveRow = (await persistence.getSession!(holder))!;
    liveRow.expires_at_ms = live.expiresAt;
    liveRow.session_timeout_ms = live.sessionTimeoutMs;
    if (options.label) {
      await sessions.createSession(HOLDER, "spare-device", platform);
      sessions.setDeviceLabels(HOLDER, { phone: holder, tablet: `${HOLDER}:tablet` });
    }
    if (options.ownerToken) {
      expect(
        await sessions.claimLivenessOwnership(options.label ? HOLDER : holder, options.ownerToken),
      ).toBe("claimed");
    }
    const internals = pool.testHooks;
    if (options.serialReuse) {
      const replacement = { ...device, name: "AVD-B", observedAt: timer.now() };
      manager.setBootedDevices(platform, [replacement]);
      expect(await pool.settlePooledRuntimeIdentity(device.deviceId)).toBe("replaced");
      manager.setDeviceImages(platform, [
        { ...image, deviceId: "emulator-5556" },
        { ...image, ...replacement, isRunning: true },
      ]);
    } else {
      await internals.releaseDisconnectedRecoverySessionWithRetry(
        holder,
        device.deviceId,
        `device-restart:${platform === "android" ? device.name : device.deviceId}`,
      );
      await pool.releaseDevice(device.deviceId, holder);
      if (!options.running) {
        manager.setBootedDevices(platform, []);
        await pool.removeDevice(
          device.deviceId,
          true,
          pool.getDevice(device.deviceId) ?? undefined,
        );
      }
    }
    await drainMicrotasks(0);
    registerDeviceTools();
    ToolRegistry.registerDeviceAware(
      "restartControl",
      "Exercise recovered control admission",
      z.object({ sessionUuid: z.string() }),
      { handler: async (target) => ({ deviceId: target.deviceId }), deviceReadiness: "booted" },
    );
    manager.clearHistory();
    autolockWrites.length = 0;
    // In-band deadline keys become the ambient request deadline, as at MCP ingress (#15663).
    const call = (name: string, args: Record<string, unknown>, routingSessionUuid?: string) =>
      withWireDeadline(args, (rest) =>
        runWithToolSelectionContext({ routingSessionUuid }, () =>
          ToolRegistry.getTool(name)!.handler(rest),
        ),
      );
    const exact = platform === "android" ? { avdName: device.name } : { udid: device.deviceId };
    const start = (args: Record<string, unknown> = exact, routing?: string) =>
      call(platform === "android" ? "getAndroid" : "getApple", args, routing);
    return {
      timer,
      manager,
      sessions,
      persistence,
      pool,
      internals,
      device,
      image,
      holder,
      autolockWrites,
      call,
      start,
    };
  }

  async function refusal(f: Awaited<ReturnType<typeof fixture>>, start: () => Promise<unknown>) {
    const row = { ...(await f.persistence.getSession!(f.holder))! };
    const reservation = f.internals.rehydrationReservations.get(f.holder);
    f.timer.advanceTime(12_345);
    const error = await start().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(InputDeviceOwnedError);
    expect({
      starts: f.manager.getCallCount("startDevice"),
      kills: f.manager.getCallCount("killDevice"),
    }).toEqual({ starts: 0, kills: 0 });
    expect(error).toMatchObject({
      code: "device_owned_by_other_session",
      deviceId: f.device.deviceId,
      retryable: true,
      retryAfterMs: 167_655,
    });
    expect((error as Error).message).toContain(`is already assigned to session ${f.holder}`);
    expect(f.manager.getCallCount("startDevice")).toBe(0);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
    expect(f.internals.rehydrationReservations.get(f.holder)).toBe(reservation);
    expect(await f.persistence.getSession!(f.holder)).toEqual(row);
  }

  for (const args of [
    { avdName: "restart-phone" },
    { deviceId: "restart-phone" },
    { deviceId: "emulator-5554" },
  ]) {
    test(`rival getAndroid exact ${JSON.stringify(args)} refuses before boot`, async () => {
      const f = await fixture();
      await refusal(f, () => f.start(args));
    });
  }
  test("settlement handoff refuses a rival exact-name start before boot", async () => {
    const f = await fixture({ serialReuse: true });
    await refusal(f, () => f.start({ avdName: f.device.name }));
    expect(f.pool.getDevice(f.device.deviceId)).toMatchObject({ name: "AVD-B", sessionId: null });
  });

  test("settlement handoff lets a rival start the reused serial as B with a new session", async () => {
    const f = await fixture({ serialReuse: true });
    expect(await f.start({ deviceId: f.device.deviceId })).toMatchObject({
      structuredContent: {
        runtime: { deviceId: f.device.deviceId, session: { sessionUuid: "fake-1" } },
      },
    });
    expect(f.pool.getDevice(f.device.deviceId)).toMatchObject({
      name: "AVD-B",
      sessionId: "fake-1",
    });
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(true);
    expect(f.sessions.getSession(HOLDER)).toBeNull();
    expect(f.manager.getCallCount("startDevice")).toBe(0);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
  });

  for (const reconnect of [false, true]) {
    test(`settlement handoff owner reconnect=${reconnect} boots A on a new serial with the same session`, async () => {
      const f = await fixture({
        serialReuse: true,
        connection: CONNECTION,
        ownerToken: "holder-token",
      });
      f.timer.advanceTime(500);
      let answered = false;
      let pending: unknown;
      const recovery = f.sessions
        .getOrCreateSession(HOLDER, f.pool, undefined, { requireIssuedSession: true })
        .then(
          (value) => {
            answered = true;
            pending = value;
          },
          (error: unknown) => {
            answered = true;
            pending = error;
          },
        );
      await drainMicrotasks(80);
      expect(answered).toBe(true);
      await recovery;
      expect(pending).toBeInstanceOf(SessionRecoveryAssignmentError);
      expect(pending).toMatchObject({
        details: {
          code: "session_recovery_pending",
          detectionPath: "serial-reuse",
          recoveryOutcome: "not-attempted",
          retryable: true,
          recoveryWindowRemainingMs: 179_500,
        },
      });
      expect((await f.persistence.getSession!(HOLDER))?.release_reason).toBe(
        `device-restart:${f.device.name}`,
      );
      expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(true);
      expect(f.pool.getDevice(f.device.deviceId)).toMatchObject({ name: "AVD-B", sessionId: null });
      const connection = reconnect ? "reconnected" : CONNECTION;
      if (reconnect) {
        expect(
          await f.pool.restoreOwnedDeviceSessionsForMcpSession(
            [HOLDER],
            connection,
            "holder-token",
          ),
        ).toEqual([]);
      }
      expect(await f.start({ avdName: f.device.name, __mcpSessionId: connection })).toMatchObject({
        structuredContent: {
          runtime: { deviceId: "emulator-5556", session: { sessionUuid: HOLDER } },
        },
      });
      expect(f.sessions.getSession(HOLDER)?.assignedDevice).toBe("emulator-5556");
      expect(f.pool.getDevice(f.device.deviceId)).toMatchObject({ name: "AVD-B", sessionId: null });
      expect(f.pool.getDevice("emulator-5556")).toMatchObject({
        name: f.device.name,
        sessionId: HOLDER,
      });
      expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(false);
      expect(f.pool.resolveOwnedDeviceSessionForMcpSession(connection, "emulator-5556")).toBe(
        HOLDER,
      );
      expect(await f.persistence.getSession!(HOLDER)).toMatchObject({
        status: "active",
        device_id: "emulator-5556",
        release_reason: null,
      });
      expect(f.manager.getCallCount("startDevice")).toBe(1);
      expect(f.manager.getCallCount("killDevice")).toBe(0);
      expect(await f.manager.getBootedDevices("android")).toContainEqual(
        expect.objectContaining({ name: "AVD-B", deviceId: "emulator-5554" }),
      );
    });
  }

  type Fixture = Awaited<ReturnType<typeof fixture>>;

  test("autolock owner connection exact start resumes R and publishes its route", async () => {
    const f = await fixture({ autolock: true, connection: "owner-conn" });
    const readiness = f.sessions.setDeviceReadiness.bind(f.sessions);
    f.sessions.setDeviceReadiness = (id, level) => {
      expect(f.pool.captureAutolockSessionForMcpSession("owner-conn")).toBeUndefined();
      readiness(id, level);
    };
    await resumed(f, () => f.start({ avdName: f.device.name, __mcpSessionId: "owner-conn" }));
    expect(f.manager.getCallCount("startDevice")).toBe(1);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
    expect(f.pool.getDevice(f.device.deviceId)?.autolockSessionId).toBe(HOLDER);
    expect(
      f.pool.resolveAutolockSessionForMcpSession(
        "owner-conn",
        f.device.platform,
        undefined,
        f.device.deviceId,
      ),
    ).toBe(HOLDER);
    expect(f.pool.resolveOwnedDeviceSessionForMcpSession("owner-conn", f.device.deviceId)).toBe(
      HOLDER,
    );
    expect(f.sessions.getAllSessions().map((session) => session.sessionId)).toEqual([HOLDER]);
    expect(await f.persistence.getSession!(HOLDER)).toMatchObject({
      autolock_enabled: 1,
      mcp_session_id: "owner-conn",
    });
    expect(f.autolockWrites).toEqual([{ sessionId: HOLDER, mcpSessionId: "owner-conn" }]);
  });

  test("autolock adoption refusal after resume never leaves R bound to a rolled-back boot", async () => {
    const f = await fixture({ autolock: true, connection: "owner-conn" });
    const adopt = f.pool.adoptResumedAutolockSession.bind(f.pool);
    const adoption = spyOn(f.pool, "adoptResumedAutolockSession").mockImplementation(
      async (...args) => {
        expect(f.sessions.getSession(HOLDER)?.assignedDevice).toBe(f.device.deviceId);
        const leases = f.pool.testHooks.mcpSessionRecoveryDevices as Map<string, unknown>;
        leases.set("owner-conn", {
          device: { ...f.pool.getDevice(f.device.deviceId)!, deviceId: "other" },
          token: Symbol("adoption-refusal"),
        });
        try {
          return await adopt(...args);
        } finally {
          leases.clear();
          expect(leases.size).toBe(0);
        }
      },
    );
    cleanups.push(() => adoption.mockRestore());
    const error = await f
      .start({ avdName: f.device.name, __mcpSessionId: "owner-conn" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(McpSessionRecoveryInProgressError);
    expect((Reflect.get(f.persistence, "rows") as Map<string, unknown>).size).toBe(1);
    expect(f.autolockWrites).toEqual([]);
    expect(f.pool.captureAutolockSessionForMcpSession("owner-conn")).toBeUndefined();
    expect(f.sessions.getAllSessions().map((s) => s.sessionId)).toEqual([HOLDER]);
    expect(f.sessions.getSession(HOLDER)?.assignedDevice).toBe(f.device.deviceId);
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(false);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
    expect(await f.manager.getBootedDevices("android")).toEqual([
      expect.objectContaining({ deviceId: f.device.deviceId }),
    ]);
  });

  test("autolock resumed owner closed during boot is neither routed nor persisted", async () => {
    const f = await fixture({ autolock: true, connection: "owner-conn" });
    f.manager.beforeReady = async () => f.pool.releaseMcpSessionBindings("owner-conn");
    expect(await f.start({ avdName: f.device.name, __mcpSessionId: "owner-conn" })).toMatchObject({
      structuredContent: { runtime: { session: { sessionUuid: HOLDER } } },
    });
    expect(f.pool.getDevice(f.device.deviceId)?.autolockSessionId).toBe(HOLDER);
    expect(f.pool.captureAutolockSessionForMcpSession("owner-conn")).toBeUndefined();
    expect(
      f.pool.resolveOwnedDeviceSessionForMcpSession("owner-conn", f.device.deviceId),
    ).toBeUndefined();
    expect(f.autolockWrites).toEqual([]);
    expect(f.sessions.getAllSessions().map((session) => session.sessionId)).toEqual([HOLDER]);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
  });

  test("autolock routing owner with a different connection adopts and persists R", async () => {
    const f = await fixture({ autolock: true, connection: "owner-conn" });
    await resumed(f, () => f.start({ avdName: f.device.name, __mcpSessionId: "new-conn" }, HOLDER));
    expect(f.pool.resolveAutolockSessionForMcpSession("new-conn")).toBe(HOLDER);
    expect(f.pool.resolveOwnedDeviceSessionForMcpSession("new-conn", f.device.deviceId)).toBe(
      HOLDER,
    );
    expect(f.autolockWrites).toEqual([{ sessionId: HOLDER, mcpSessionId: "new-conn" }]);
    expect(f.manager.getCallCount("startDevice")).toBe(1);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
  });

  for (const identity of ["routing", "label", "selector", "ios"] as const) {
    test(`autolock ${identity} owner resumes R without a replacement session`, async () => {
      const f = await fixture({
        autolock: true,
        connection: "owner-conn",
        label: identity === "label",
        platform: identity === "ios" ? "ios" : "android",
      });
      await resumed(f, () =>
        identity === "selector"
          ? f.call("startDevice", { platform: "android", createIfMissing: false }, HOLDER)
          : f.start(undefined, HOLDER),
      );
      expect(f.manager.getCallCount("startDevice")).toBe(1);
      expect(f.manager.getCallCount("killDevice")).toBe(0);
      expect(f.pool.getDevice(f.device.deviceId)?.autolockSessionId).toBe(f.holder);
      expect(
        f.sessions
          .getAllSessions()
          .map((session) => session.sessionId)
          .sort(),
      ).toEqual(identity === "label" ? [HOLDER, f.holder].sort() : [HOLDER]);
    });
  }

  test("autolock rival exact start and direct acquisition preserve the restart hold", async () => {
    const f = await fixture({ autolock: true, running: true, connection: "owner-conn" });
    await refusal(f, () => f.start({ avdName: f.device.name, __mcpSessionId: "rival" }));
    const row = { ...(await f.persistence.getSession!(HOLDER))! };
    const hold = f.internals.rehydrationReservations.get(HOLDER);
    await expect(
      f.pool.autolockDevice(f.device.deviceId, "android", "rival"),
    ).rejects.toMatchObject({ code: "device_owned_by_other_session" });
    expect(f.sessions.getAllSessions()).toHaveLength(0);
    expect(f.pool.getDevice(f.device.deviceId)?.sessionId).toBeNull();
    expect(f.internals.rehydrationReservations.get(HOLDER)).toBe(hold);
    expect(await f.persistence.getSession!(HOLDER)).toEqual(row);
    expect(f.manager.getCallCount("startDevice")).toBe(0);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
  });

  for (const ending of ["terminal", "window"] as const) {
    test(`autolock admitted owner ${ending} during boot never mints a replacement`, async () => {
      const f = await fixture({ autolock: true, connection: "owner-conn" });
      const { child } = coldBoot(f);
      f.manager.beforeReady = async () => {
        if (ending === "terminal") {
          await f.sessions.releaseSession(HOLDER, "explicit-release");
        } else {
          f.timer.advanceTime(180_001);
          await drainMicrotasks(40);
        }
      };
      await expect(
        f.start({ avdName: f.device.name, bootTimeoutMs: 240_000, __mcpSessionId: "owner-conn" }),
      ).rejects.toBeInstanceOf(TerminalSessionError);
      expect(f.sessions.getAllSessions()).toHaveLength(0);
      expect(f.pool.resolveAutolockSessionForMcpSession("owner-conn")).toBeUndefined();
      expect(child.killed).toBe(true);
      f.timer.advanceTime(0);
      await drainMicrotasks(0);
    });
  }

  function coldBoot(f: Fixture) {
    const child = new FakeChildProcess(f.timer);
    const process = child;
    f.manager.setMockChildProcess(f.device.name, process);
    cleanups.push(() => {
      child.simulateExit();
      f.timer.advanceTime(0);
    });
    return { child, process };
  }

  function settle<T>(f: Fixture, promise: Promise<T>) {
    return settleWithFakeTime(f.timer, promise, {
      stepMs: 1_000,
      maxSteps: 20,
      description: "owner start and control recovery",
    });
  }

  async function assertLiveResume(f: Fixture, child: FakeChildProcess) {
    expect(await f.persistence.getSession!(HOLDER)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(f.sessions.getAllSessions().map((session) => session.sessionId)).toEqual([HOLDER]);
    expect(f.sessions.getSession(HOLDER)?.assignedDevice).toBe(f.device.deviceId);
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(false);
    expect(child.killed).toBe(false);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
    expect(f.pool.isReservedForReadiness(f.device.deviceId)).toBe(false);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
    expect(f.timer.getPendingSleepCount()).toBe(0);
  }

  test("undelivered owner resume after bind keeps the restored row live and boot running", async () => {
    const f = await fixture({ connection: CONNECTION });
    const { child } = coldBoot(f);
    const controller = new AbortController();
    const original = f.pool.bindOrReuseDeviceSession.bind(f.pool);
    f.pool.bindOrReuseDeviceSession = async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      controller.abort(new Error("client cancelled"));
      return result;
    };
    await expect(
      settleByFakeEvents(
        f.timer,
        runWithToolSelectionContext({ routingSessionUuid: HOLDER }, () =>
          ToolRegistry.getTool("getAndroid")!.handler(
            { avdName: f.device.name, __mcpSessionId: CONNECTION },
            undefined,
            controller.signal,
          ),
        ),
        { description: "cancelled owner resume" },
      ),
    ).rejects.toThrow("client cancelled");
    await assertLiveResume(f, child);
    expect(f.pool.resolveOwnedDeviceSessionForMcpSession(CONNECTION, f.device.deviceId)).toBe(
      HOLDER,
    );
    expect(await f.call("restartControl", { sessionUuid: HOLDER })).toEqual({
      deviceId: f.device.deviceId,
    });
  });

  test("cancelled owner resume before bind preserves the restart row hold and deadlines", async () => {
    const f = await fixture();
    const { child } = coldBoot(f);
    const row = { ...(await f.persistence.getSession!(HOLDER))! };
    const reservation = f.internals.rehydrationReservations.get(HOLDER);
    const deadline = reservation?.scheduledDeadlineMs;
    const controller = new AbortController();
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        controller.abort(new Error("client cancelled"));
      },
    });
    await expect(
      settleByFakeEvents(
        f.timer,
        runWithToolSelectionContext({ routingSessionUuid: HOLDER }, () =>
          ToolRegistry.getTool("getAndroid")!.handler(
            { avdName: f.device.name },
            undefined,
            controller.signal,
          ),
        ),
        { description: "cancelled owner resume" },
      ),
    ).rejects.toThrow("client cancelled");
    expect(await f.persistence.getSession!(HOLDER)).toEqual(row);
    expect(f.internals.rehydrationReservations.get(HOLDER)).toBe(reservation);
    expect(reservation?.scheduledDeadlineMs).toBe(deadline);
    expect(f.sessions.getSession(HOLDER)).toBeNull();
    expect(child.killed).toBe(true);
    f.timer.advanceTime(0);
    await drainMicrotasks(50);
    expect(f.timer.getPendingTimeoutCount()).toBe(1);
  });

  async function assertRace(
    f: Fixture,
    start: Promise<unknown>,
    control: Promise<unknown>,
    boot: ReturnType<typeof coldBoot>,
  ) {
    const [result, outcome] = await settle(
      f,
      Promise.all([
        start,
        control.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        ),
      ]),
    );
    expect(result).toMatchObject({
      structuredContent: { runtime: { session: { sessionUuid: HOLDER } } },
    });
    if ("error" in outcome) {
      expect(outcome.error).toMatchObject({
        details: { code: "session_recovery_pending", retryable: true },
      });
    } else {
      expect(outcome.value).toEqual({ deviceId: f.device.deviceId });
    }
    await assertLiveResume(f, boot.child);
    expect(f.pool.hasStartedDeviceProcess(f.device.deviceId, boot.process)).toBe(true);
    expect(f.pool.getDevice(f.device.deviceId)?.androidImage?.name).toBe(f.device.name);
    expect(f.sessions.getSession(HOLDER)?.cacheData.deviceReadiness).toBeDefined();
  }

  test("control waiting first joins the owner's boot without terminalizing the row", async () => {
    const f = await fixture();
    const boot = coldBoot(f);
    const control = f.call("restartControl", { sessionUuid: HOLDER });
    void control.catch(() => {});
    await drainMicrotasks(200);
    await assertRace(f, f.start(undefined, HOLDER), control, boot);
  });

  test("control arriving during owner runner setup resumes through only its readiness hold", async () => {
    const f = await fixture();
    const boot = coldBoot(f);
    const gate = Promise.withResolvers<void>();
    let preparing = false;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        preparing = true;
        await gate.promise;
      },
    });
    const start = f.start(undefined, HOLDER);
    void start.catch(() => {});
    await drainUntil(() => preparing, { description: "owner runner setup" });
    const control = f.call("restartControl", { sessionUuid: HOLDER });
    void control.catch(() => {});
    await drainMicrotasks(200);
    gate.resolve();
    await assertRace(f, start, control, boot);
  });

  test("owner bind adopts recovery that claimed the pooled device before readiness", async () => {
    const f = await fixture({ connection: CONNECTION });
    const boot = coldBoot(f);
    let control: Promise<unknown> | undefined;
    f.manager.beforeReady = async () => {
      await f.pool.initializeWithDevices([f.device]);
      control = f.call("restartControl", { sessionUuid: HOLDER });
      await control;
    };
    const start = f.start({ avdName: f.device.name, __mcpSessionId: CONNECTION }, HOLDER);
    void start.catch(() => {});
    await drainUntil(() => control !== undefined, { description: "recovery before readiness" });
    await assertRace(f, start, control!, boot);
    expect(f.pool.resolveOwnedDeviceSessionForMcpSession(CONNECTION, f.device.deviceId)).toBe(
      HOLDER,
    );
  });

  test("owner readiness refuses a rival bound after the restart hold expires", async () => {
    const f = await fixture({ running: true, connection: CONNECTION });
    const preparedDevices: string[] = [];
    let rivalRow: unknown;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async ({ device }) => {
        preparedDevices.push(device.deviceId);
      },
    });
    f.timer.advanceTime(179_000);
    f.manager.beforeReady = async () => {
      // Admission captured R while its hold was live; discovery crosses the fixed deadline.
      f.timer.advanceTime(2_000);
      await drainUntil(() => !f.internals.rehydrationReservations.has(HOLDER), {
        description: "restart hold expiry before readiness",
      });
      await f.sessions.getOrCreateSession("rival-session", f.pool, "android");
      rivalRow = { ...(await f.persistence.getSession!("rival-session"))! };
    };
    const error: unknown = await f
      .start({ avdName: f.device.name, __mcpSessionId: CONNECTION }, HOLDER)
      .catch((error: unknown) => error);
    expect(preparedDevices).toEqual([]);
    expect(error).toBeInstanceOf(InputDeviceOwnedError);
    expect(error).toMatchObject({
      code: "device_owned_by_other_session",
      deviceId: f.device.deviceId,
    });
    expect(f.manager.getCallCount("startDevice")).toBe(0);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
    expect(f.pool.getDevice(f.device.deviceId)?.sessionId).toBe("rival-session");
    expect(f.sessions.getAllSessions().map((session) => session.sessionId)).toEqual([
      "rival-session",
    ]);
    expect(f.sessions.getSession("rival-session")?.assignedDevice).toBe(f.device.deviceId);
    expect(await f.persistence.getSession!("rival-session")).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect<unknown>(await f.persistence.getSession!("rival-session")).toEqual(rivalRow);
    expect(f.sessions.getSession(HOLDER)).toBeNull();
    expect(await f.persistence.getSession!(HOLDER)).toMatchObject({
      status: "expired",
      release_reason: "restart-recovery-timeout",
    });
    expect(f.internals.rehydrationReservations.size).toBe(0);
    expect(f.internals.restartReadiness.size).toBe(0);
    expect(f.pool.isReservedForReadiness(f.device.deviceId)).toBe(false);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
    expect(f.timer.getPendingSleepCount()).toBe(0);
    expect(f.timer.getPendingIntervalCount()).toBe(0);

    // A later selector acquires a new UUID on the spare; it cannot revive the terminal holder.
    f.manager.beforeReady = undefined;
    const spare = { ...f.device, name: "spare-phone", deviceId: "emulator-5556" };
    f.manager.setBootedDevices("android", [f.device, spare]);
    f.manager.setDeviceImages("android", [f.image, { ...f.image, ...spare }]);
    expect(
      await f.call("startDevice", { platform: "android", createIfMissing: false }, HOLDER),
    ).toMatchObject({
      structuredContent: {
        runtime: { deviceId: spare.deviceId, session: { sessionUuid: "fake-1" } },
      },
    });
    expect(f.sessions.getSession(HOLDER)).toBeNull();
    expect(await f.persistence.getSession!(HOLDER)).toMatchObject({
      status: "expired",
      release_reason: "restart-recovery-timeout",
    });
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(false);
  });

  test("owner readiness on an unheld device still resumes R", async () => {
    const f = await fixture({ running: true, connection: CONNECTION });
    const preparedDevices: string[] = [];
    f.manager.beforeReady = async () => {
      expect(f.pool.getDevice(f.device.deviceId)?.sessionId).toBeNull();
      expect(f.sessions.getSession(HOLDER)).toBeNull();
    };
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async ({ device }) => {
        preparedDevices.push(device.deviceId);
      },
    });
    expect(
      await f.start({ avdName: f.device.name, __mcpSessionId: CONNECTION }, HOLDER),
    ).toMatchObject({
      structuredContent: { runtime: { session: { sessionUuid: HOLDER } } },
    });
    expect(preparedDevices).toEqual([f.device.deviceId]);
    expect(f.sessions.getAllSessions().map((session) => session.sessionId)).toEqual([HOLDER]);
    expect(f.sessions.getSession(HOLDER)?.assignedDevice).toBe(f.device.deviceId);
    expect(await f.persistence.getSession!(HOLDER)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(f.pool.resolveOwnedDeviceSessionForMcpSession(CONNECTION, f.device.deviceId)).toBe(
      HOLDER,
    );
    expect(f.manager.getCallCount("startDevice")).toBe(0);
    expect(f.manager.getCallCount("killDevice")).toBe(0);
    expect(f.internals.rehydrationReservations.size).toBe(0);
    expect(f.internals.restartReadiness.size).toBe(0);
    expect(f.pool.isReservedForReadiness(f.device.deviceId)).toBe(false);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
    expect(f.timer.getPendingSleepCount()).toBe(0);
    expect(f.timer.getPendingIntervalCount()).toBe(0);
  });

  test("owner bind refuses R already live on a different device without rebind or second session", async () => {
    const f = await fixture();
    const boot = coldBoot(f);
    const spare = { ...f.device, name: "spare-phone", deviceId: "emulator-5556" };
    f.manager.beforeReady = async () => {
      await f.pool.initializeWithDevices([f.device, spare]);
      f.manager.setBootedDevices("android", [f.device, spare]);
      await f.call("restartControl", { sessionUuid: HOLDER });
      await f.pool.bindOrReuseDeviceSession({
        sessionId: HOLDER,
        deviceId: spare.deviceId,
        platform: "android",
        expectedIdentity: spare,
        allowSessionRebind: true,
      });
    };
    await expect(f.start(undefined, HOLDER)).rejects.toThrow(
      "already assigned to a different device",
    );
    expect(f.sessions.getAllSessions().map((session) => session.sessionId)).toEqual([HOLDER]);
    expect(f.sessions.getSession(HOLDER)?.assignedDevice).toBe(spare.deviceId);
    expect(await f.persistence.getSession!(HOLDER)).toMatchObject({
      status: "active",
      release_reason: null,
    });
    expect(boot.child.killed).toBe(true);
  });

  test("rival start readiness keeps R pending without bypass or terminal identity loss", async () => {
    const f = await fixture();
    // This rival was admitted before R's hold existed; the bind must still respect the late hold.
    f.pool.releaseRehydrationReservation(HOLDER, true);
    const gate = Promise.withResolvers<void>();
    let preparing = false;
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        await f.pool.initializeWithDevices([f.device]);
        await f.pool.reserveDevicesForRehydration([
          {
            sessionId: HOLDER,
            target: {
              platform: "android",
              stableDeviceId: f.device.name,
              deviceId: f.device.deviceId,
              androidEmulator: true,
            },
          },
        ]);
        preparing = true;
        await gate.promise;
      },
    });
    const start = f.start({ avdName: f.device.name, __mcpSessionId: "rival" });
    void start.catch(() => {});
    await drainUntil(() => preparing, { description: "rival runner setup" });
    try {
      const control = f.call("restartControl", {
        sessionUuid: HOLDER,
        __mcpRequestDeadlineMs: f.timer.now() + 5_000,
      });
      await expect(settle(f, control)).rejects.toMatchObject({
        details: { code: "session_recovery_pending", retryable: true },
      });
      expect(f.sessions.getSession(HOLDER)).toBeNull();
      expect((await f.persistence.getSession!(HOLDER))?.release_reason).toBe(
        "device-restart:restart-phone",
      );
      expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(true);
      expect(f.pool.isReservedForReadiness(f.device.deviceId)).toBe(true);
    } finally {
      gate.resolve();
      await expect(settle(f, start)).rejects.toMatchObject({
        code: "device_owned_by_other_session",
      });
    }
  });

  for (const owner of [false, true]) {
    test(`fuzzy name equal to reserved id selects the unheld running sibling owner=${owner}`, async () => {
      const f = await fixture();
      const row = { ...(await f.persistence.getSession!(HOLDER))! };
      const hold = f.internals.rehydrationReservations.get(HOLDER);
      const spare = { ...f.device, name: "restart-phone-2", deviceId: "emulator-5556" };
      f.manager.setBootedDevices("android", [spare]);
      f.manager.setDeviceImages("android", [f.image, { ...f.image, ...spare }]);
      await f.pool.initializeWithDevices([spare]);
      const result = await f.call(
        "startDevice",
        {
          platform: "android",
          name: "restart-phone",
          createIfMissing: false,
        },
        owner ? HOLDER : undefined,
      );
      expect(result).toMatchObject({
        structuredContent: {
          runtime: {
            deviceId: spare.deviceId,
            session: { sessionUuid: "fake-1" },
          },
        },
      });
      expect(f.manager.getCallCount("startDevice")).toBe(0);
      expect(await f.persistence.getSession!(HOLDER)).toEqual(row);
      expect(f.internals.rehydrationReservations.get(HOLDER)).toBe(hold);
    });
  }

  test("owner fuzzy name with only its reserved image boots and resumes that row", async () => {
    const f = await fixture();
    await resumed(f, () =>
      f.call(
        "startDevice",
        {
          platform: "android",
          name: "restart-phone",
          createIfMissing: false,
        },
        HOLDER,
      ),
    );
    expect(f.manager.getCallCount("startDevice")).toBe(1);
  });

  test("rival startDevice exact avdName refuses before boot", async () => {
    const f = await fixture();
    await refusal(f, () => f.call("startDevice", { platform: "android", avdName: f.device.name }));
  });
  test("rival selector skips a stopped reserved image", async () => {
    const f = await fixture();
    const spare: DeviceInfo = { ...f.image, name: "spare-phone", deviceId: "emulator-5556" };
    f.manager.setDeviceImages("android", [f.image, spare]);
    f.manager.setMockChildProcess(spare.name, null);
    const result = await f.call("startDevice", { platform: "android", createIfMissing: false });
    expect(result).toMatchObject({ structuredContent: { runtime: { deviceId: spare.deviceId } } });
    expect(
      f.manager.getExecutedOperations().filter((op) => op.startsWith("startDevice:")),
    ).toHaveLength(1);
    expect(f.manager.getExecutedOperations().find((op) => op.startsWith("startDevice:"))).toContain(
      `startDevice:${spare.name}:`,
    );
  });
  test("selector with only the reserved image keeps the existing no-match outcome", async () => {
    const f = await fixture();
    await expect(
      f.call("startDevice", { platform: "android", createIfMissing: false }),
    ).rejects.toThrow("No android device matching criteria found");
    expect(f.manager.getCallCount("startDevice")).toBe(0);
  });
  test("running reserved device survives a rival exact start", async () => {
    const f = await fixture({ running: true });
    await refusal(f, () => f.start());
    expect(f.pool.getDevice(f.device.deviceId)).not.toBeNull();
    expect(f.internals.intentionalShutdowns.size).toBe(0);
    expect(await f.manager.getBootedDevices("android")).toEqual([f.device]);
  });
  async function resumed(f: Awaited<ReturnType<typeof fixture>>, start: () => Promise<unknown>) {
    const row = (await f.persistence.getSession!(f.holder))!;
    const generation = row.stable_identity_generation!;
    expect(await start()).toMatchObject({
      structuredContent: { runtime: { session: { sessionUuid: f.holder } } },
    });
    expect(f.sessions.getSession(f.holder)?.assignedDevice).toBe(f.device.deviceId);
    expect(await f.persistence.getSession!(f.holder)).toMatchObject({
      release_reason: null,
      status: "active",
      stable_identity_generation: generation + 2,
    });
    expect(f.internals.rehydrationReservations.has(f.holder)).toBe(false);
    expect(f.timer.getPendingTimeoutCount()).toBe(0);
    expect(await f.call("restartControl", { sessionUuid: f.holder })).toEqual({
      deviceId: f.device.deviceId,
    });
    expect(
      (
        await f.sessions.getOrCreateSession(f.holder, f.pool, f.device.platform, {
          requireIssuedSession: true,
        })
      ).assignedDevice,
    ).toBe(f.device.deviceId);
    await expect(
      f.start({
        ...(f.device.platform === "android"
          ? { avdName: f.device.name }
          : { udid: f.device.deviceId }),
        __mcpSessionId: "rival",
      }),
    ).rejects.toMatchObject({ code: "device_owned_by_other_session", retryable: false });
  }
  test("ambient owner start resumes the same persisted row", async () => {
    const f = await fixture();
    await resumed(f, () => f.start(undefined, HOLDER));
  });
  test("token-proved reconnect resumes HOLDER without routing and preserves hold deadlines until start", async () => {
    const f = await fixture({ connection: CONNECTION, ownerToken: "holder-token" });
    const target = f.internals.rehydrationReservations.get(HOLDER)!;
    const before = { ...target };
    const row = { ...(await f.persistence.getSession!(HOLDER))! };
    expect(
      await f.pool.restoreOwnedDeviceSessionsForMcpSession([HOLDER], "reconnected", "holder-token"),
    ).toEqual([]);
    expect(target.scheduledDeadlineMs).toBe(before.scheduledDeadlineMs);
    for (const key of ["idleDeadlineMs", "recoveryWindowEndMs"]) {
      expect(Reflect.get(target, key)).toBe(Reflect.get(before, key));
    }
    expect(await f.persistence.getSession!(HOLDER)).toEqual(row);
    expect(f.sessions.getSession(HOLDER)).toBeNull();
    expect(
      f.pool.isRestartReservationOwnedByOtherConnection(f.device.deviceId, {
        sessionUuid: HOLDER,
        mcpSessionId: "other",
      }),
    ).toBe(true);
    expect(
      f.pool.isRestartReservationOwnedByOtherConnection(f.device.deviceId, {
        sessionUuid: HOLDER,
        mcpSessionId: "reconnected",
      }),
    ).toBe(false);
    await resumed(f, () => f.start({ avdName: f.device.name, __mcpSessionId: "reconnected" }));
    expect(f.pool.resolveOwnedDeviceSessionForMcpSession("reconnected", f.device.deviceId)).toBe(
      HOLDER,
    );
  });

  for (const token of [undefined, "wrong-token"]) {
    test(`reconnect with ${token ?? "no token"} cannot start or name the holder to stop`, async () => {
      const f = await fixture({ connection: CONNECTION, ownerToken: "holder-token" });
      expect(
        await f.pool.restoreOwnedDeviceSessionsForMcpSession([HOLDER], "other", token),
      ).toEqual([]);
      expect(
        f.pool.isRestartReservationOwnedByOtherConnection(f.device.deviceId, {
          sessionUuid: HOLDER,
          mcpSessionId: "other",
        }),
      ).toBe(true);
      await refusal(f, () => f.start({ avdName: f.device.name, __mcpSessionId: "other" }));
    });
  }

  test("a hold without a captured liveness token does not accept a reconnect token", async () => {
    const f = await fixture({ connection: CONNECTION });
    expect(
      await f.pool.restoreOwnedDeviceSessionsForMcpSession([HOLDER], "other", "holder-token"),
    ).toEqual([]);
    await refusal(f, () => f.start({ avdName: f.device.name, __mcpSessionId: "other" }));
  });

  test("token restore waiting for assignment cannot record a connection that closed", async () => {
    const f = await fixture({ connection: CONNECTION, ownerToken: "holder-token" });
    const mutex = f.pool.testHooks.assignmentMutex;
    const gate = Promise.withResolvers<void>();
    const blocked = mutex.runExclusive(() => gate.promise);
    const restore = f.pool.restoreOwnedDeviceSessionsForMcpSession(
      [HOLDER],
      "closed",
      "holder-token",
    );
    f.pool.releaseMcpSessionBindings("closed");
    gate.resolve();
    await blocked;
    expect(await restore).toEqual([]);
    await refusal(f, () => f.start({ avdName: f.device.name, __mcpSessionId: "closed" }));
  });

  test("a derived handoff captures the ownership base's liveness token", async () => {
    const f = await fixture({ label: true, connection: CONNECTION, ownerToken: "base-token" });
    expect(
      await f.pool.restoreOwnedDeviceSessionsForMcpSession([f.holder], "reconnected", "base-token"),
    ).toEqual([]);
    await resumed(f, () => f.start({ avdName: f.device.name, __mcpSessionId: "reconnected" }));
    expect(f.pool.resolveOwnedDeviceSessionForMcpSession("reconnected", f.device.deviceId)).toBe(
      f.holder,
    );
  });

  test("a daemon-rehydration-only reservation does not gain a token-proved owner", async () => {
    const f = await fixture({ connection: CONNECTION, ownerToken: "holder-token" });
    f.timer.advanceTime(180_001);
    await drainMicrotasks(256);
    await f.pool.reserveDevicesForRehydration([
      {
        sessionId: HOLDER,
        target: {
          platform: f.device.platform,
          stableDeviceId: f.device.name,
          deviceId: f.device.deviceId,
          androidEmulator: true,
        },
      },
    ]);
    const target = f.internals.rehydrationReservations.get(HOLDER)!;
    expect(
      await f.pool.restoreOwnedDeviceSessionsForMcpSession([HOLDER], "other", "holder-token"),
    ).toEqual([]);
    expect(Reflect.get(target, "ownerMcpSessionIds")).toBeUndefined();
    expect(
      f.pool.restartReservationForStart(f.device.platform, [f.device.name], {
        mcpSessionId: "other",
      })?.owned,
    ).toBe(false);
  });

  test("late token restore after a hold ends records nothing and ordinary acquisition proceeds", async () => {
    const f = await fixture({ connection: CONNECTION, ownerToken: "holder-token" });
    const target = f.internals.rehydrationReservations.get(HOLDER)!;
    f.timer.advanceTime(180_001);
    await drainMicrotasks(256);
    expect(Reflect.get(target, "ownerLivenessToken")).toBeUndefined();
    expect(Reflect.get(target, "ownerMcpSessionIds")).toBeUndefined();
    expect(
      await f.pool.restoreOwnedDeviceSessionsForMcpSession([HOLDER], "late", "holder-token"),
    ).toEqual([]);
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(false);
    expect(
      f.pool.resolveOwnedDeviceSessionForMcpSession("late", f.device.deviceId),
    ).toBeUndefined();
    expect(await f.start({ avdName: f.device.name, __mcpSessionId: "late" })).toMatchObject({
      structuredContent: { runtime: { session: { sessionUuid: "fake-1" } } },
    });
  });

  test("owning MCP connection resumes without a routing session and owns the live session again", async () => {
    const f = await fixture({ connection: CONNECTION });
    await resumed(f, () => f.start({ avdName: f.device.name, __mcpSessionId: CONNECTION }));
    expect(f.pool.resolveOwnedDeviceSessionForMcpSession(CONNECTION, f.device.deviceId)).toBe(
      HOLDER,
    );
  });
  test("live base routing resumes its reserved label session", async () => {
    const f = await fixture({ label: true });
    await resumed(f, () => f.start(undefined, HOLDER));
  });
  for (const args of [
    { __mcpSessionId: "rival" },
    {},
    { __mcpSessionId: CONNECTION, __oneShotCli: true },
  ]) {
    test(`caller without owner identity ${JSON.stringify(args)} is refused`, async () => {
      const f = await fixture({ connection: CONNECTION });
      await refusal(f, () => f.start({ avdName: f.device.name, ...args }));
    });
  }
  test("anonymous acquisition does not grant anonymous restart ownership", async () => {
    const f = await fixture();
    await refusal(f, () => f.start());
  });
  test("owner selector resumes its reserved match", async () => {
    const f = await fixture();
    await resumed(f, () =>
      f.call("startDevice", { platform: "android", createIfMissing: false }, HOLDER),
    );
  });
  test("owner admitted then terminally released during boot never mints a replacement", async () => {
    const f = await fixture();
    const child = new FakeChildProcess(f.timer);
    f.manager.setMockChildProcess(f.device.name, child);
    f.manager.beforeReady = async () => {
      await f.sessions.releaseSession(HOLDER, "explicit-release");
    };
    await expect(f.start(undefined, HOLDER)).rejects.toBeInstanceOf(TerminalSessionError);
    expect(f.sessions.getAllSessions()).toHaveLength(0);
    expect(child.killed).toBe(true);
    f.timer.advanceTime(0);
    await drainMicrotasks(0);
  });
  test("provisionDevice exact existing AVD refuses before boot and carries the remaining retry window", async () => {
    const f = await fixture();
    f.timer.advanceTime(12_345);
    const result = await f.call("provisionDevice", {
      device: {
        platform: "android",
        name: f.device.name,
        spec: { runtime: "system-images;android-36;google_apis;x86_64", deviceType: "pixel_9" },
      },
      boot: true,
      readiness: "automation",
    });
    expect(result).toMatchObject({ isError: true });
    const wire = toolJson(result);
    expect(wire).toMatchObject({
      error: { code: "device_owned_by_other_session", retryable: true, retryAfterMs: 167_655 },
    });
    expect(f.manager.getCallCount("startDevice")).toBe(0);
  });
  test("ended reservation permits an ordinary rival acquisition", async () => {
    const f = await fixture();
    f.timer.advanceTime(180_001);
    await drainMicrotasks(0);
    const result = await f.start();
    expect(result).toMatchObject({
      structuredContent: { runtime: { deviceId: f.device.deviceId } },
    });
    expect(f.sessions.getSession(HOLDER)).toBeNull();
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(false);
  });
  test("daemon batch reservation also refuses before boot with the existing retry hint", async () => {
    const f = await fixture();
    f.pool.releaseRehydrationReservation(HOLDER, true);
    await f.pool.reserveDevicesForRehydration([
      {
        sessionId: HOLDER,
        target: {
          platform: "android",
          stableDeviceId: f.device.name,
          deviceId: f.device.deviceId,
          androidEmulator: true,
        },
      },
    ]);
    await expect(f.start()).rejects.toMatchObject({
      code: "device_owned_by_other_session",
      retryable: true,
      retryAfterMs: 2_000,
    });
    expect(f.manager.getCallCount("startDevice")).toBe(0);
  });
  test("derived routing session resolves through the live base to its reserved sibling", async () => {
    const f = await fixture({ label: true });
    await resumed(f, () => f.start(undefined, `${HOLDER}:tablet`));
  });
  test("label requester cannot resolve a base that was itself handed off", async () => {
    const f = await fixture();
    await refusal(f, () => f.start(undefined, `${HOLDER}:tablet`));
  });
  for (const args of [{ deviceId: "restart-phone" }, { deviceId: "emulator-5554" }]) {
    test(`owner resumes by ${JSON.stringify(args)}`, async () => {
      const f = await fixture();
      await resumed(f, () => f.start(args, HOLDER));
    });
  }
  test("owner startDevice exact avdName resumes", async () => {
    const f = await fixture();
    await resumed(f, () =>
      f.call("startDevice", { platform: "android", avdName: f.device.name }, HOLDER),
    );
  });
  test("owner control recovers an already-running idle reserved device without a start", async () => {
    const f = await fixture({ running: true });
    expect(await f.call("restartControl", { sessionUuid: HOLDER })).toEqual({
      deviceId: f.device.deviceId,
    });
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(false);
    expect(f.manager.getCallCount("startDevice")).toBe(0);
  });
  test("owner resume records its cold-boot process and source AVD", async () => {
    const f = await fixture();
    const child = new FakeChildProcess(f.timer);
    const process = child;
    f.manager.setMockChildProcess(f.device.name, process);
    await resumed(f, () => f.start(undefined, HOLDER));
    expect(f.pool.hasStartedDeviceProcess(f.device.deviceId, process)).toBe(true);
    expect(f.pool.getDevice(f.device.deviceId)?.androidImage?.name).toBe(f.device.name);
    child.simulateExit();
    f.timer.advanceTime(0);
    await drainMicrotasks(0);
  });
  test("retry hint uses the earlier idle deadline", async () => {
    const f = await fixture({ idleMs: 60_000 });
    f.timer.advanceTime(12_345);
    await expect(f.start()).rejects.toMatchObject({ retryable: true, retryAfterMs: 47_655 });
    expect(f.manager.getCallCount("startDevice")).toBe(0);
  });
  test("owner selector selecting a different running image mints an ordinary session", async () => {
    const f = await fixture();
    const spare = { ...f.device, name: "spare-phone", deviceId: "emulator-5556" };
    f.manager.setBootedDevices("android", [spare]);
    f.manager.setDeviceImages("android", [f.image, { ...f.image, ...spare }]);
    const result = await f.call(
      "startDevice",
      { platform: "android", createIfMissing: false },
      HOLDER,
    );
    expect(result).toMatchObject({
      structuredContent: {
        runtime: { deviceId: spare.deviceId, session: { sessionUuid: "fake-1" } },
      },
    });
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(true);
  });
  for (const selector of [false, true]) {
    test(`owner ${selector ? "selector" : "exact"} window expires during boot without a replacement mint`, async () => {
      const f = await fixture();
      const child = new FakeChildProcess(f.timer);
      f.manager.setMockChildProcess(f.device.name, child);
      f.manager.beforeReady = async () => {
        f.timer.advanceTime(180_001);
        await drainMicrotasks(40);
      };
      const call = () =>
        selector
          ? f.call(
              "startDevice",
              { platform: "android", timeoutMs: 240_000, createIfMissing: false },
              HOLDER,
            )
          : f.start({ avdName: f.device.name, bootTimeoutMs: 240_000 }, HOLDER);
      const error = await call().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TerminalSessionError);
      expect(error).toMatchObject({
        release: { releaseReason: "restart-recovery-timeout", terminal: true },
      });
      expect(f.sessions.getAllSessions()).toHaveLength(0);
      expect(child.killed).toBe(true);
      f.timer.advanceTime(0);
      await drainMicrotasks(0);
    });
  }
  test("a live peer claim during boot refuses owner resume without a replacement mint", async () => {
    const f = await fixture();
    f.sessions.attachLiveDaemonSessionIds(() => new Set(["restart-start-daemon", "peer-daemon"]));
    f.manager.beforeReady = async () => {
      const row = (await f.persistence.getSession!(HOLDER))!;
      await f.persistence.claimRecoverableSession(
        HOLDER,
        { rowGeneration: row.stable_identity_generation!, daemonSessionId: "restart-start-daemon" },
        "peer-daemon",
      );
    };
    await expect(f.start(undefined, HOLDER)).rejects.toMatchObject({
      code: "device_owned_by_other_daemon",
    });
    expect(f.sessions.getAllSessions()).toHaveLength(0);
    expect((await f.persistence.getSession!(HOLDER))?.daemon_session_id).toBe("peer-daemon");
  });
  test("a reservation created during preparation still wins at bind", async () => {
    const f = await fixture();
    f.pool.releaseRehydrationReservation(HOLDER, true);
    setDeviceToolsDependencies({
      ensureCtrlProxyReady: async () => {
        await f.pool.reserveDevicesForRehydration([
          {
            sessionId: HOLDER,
            target: {
              platform: "android",
              stableDeviceId: f.device.name,
              deviceId: f.device.deviceId,
              androidEmulator: true,
            },
          },
        ]);
      },
    });
    await expect(f.start()).rejects.toMatchObject({ code: "device_owned_by_other_session" });
    expect(f.manager.getCallCount("startDevice")).toBe(1);
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(true);
  });
  test("rival targeting a returned device's new serial is refused with the recorded runtime id", async () => {
    const f = await fixture();
    const returned = { ...f.device, deviceId: "emulator-5556" };
    f.manager.setBootedDevices("android", [returned]);
    await f.pool.initializeWithDevices([returned]);
    await refusal(f, () => f.start({ deviceId: returned.deviceId }));
  });
  test("reused runtime serial does not reserve a different stable image", async () => {
    const f = await fixture();
    const spare = { ...f.device, name: "spare-phone" };
    f.manager.setBootedDevices("android", [spare]);
    await f.pool.initializeWithDevices([spare]);
    const result = await f.start({ deviceId: spare.deviceId });
    expect(result).toMatchObject({
      structuredContent: {
        runtime: { deviceId: spare.deviceId, session: { sessionUuid: "fake-1" } },
      },
    });
    expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(true);
  });

  for (const owner of [false, true]) {
    for (const byName of [false, true]) {
      test(`unpooled reused serial owner=${owner} byName=${byName} preserves the spare and R`, async () => {
        const f = await fixture();
        const row = { ...(await f.persistence.getSession!(HOLDER))! };
        const hold = f.internals.rehydrationReservations.get(HOLDER);
        const spare = { ...f.device, name: "spare-phone" };
        const returned = { ...f.device, deviceId: "emulator-5556" };
        f.manager.setBootedDevices("android", [spare]);
        f.manager.setDeviceImages("android", [
          { ...f.image, ...returned },
          { ...f.image, ...spare, isRunning: true },
        ]);
        expect(f.pool.getDevice(spare.deviceId)).toBeNull();
        const args = byName ? { avdName: f.device.name } : { deviceId: spare.deviceId };
        if (owner && byName) {
          expect(await f.start(args, HOLDER)).toMatchObject({
            structuredContent: {
              runtime: { deviceId: returned.deviceId, session: { sessionUuid: HOLDER } },
            },
          });
          expect(f.sessions.getSession(HOLDER)?.assignedDevice).toBe(returned.deviceId);
          expect(f.internals.rehydrationReservations.has(HOLDER)).toBe(false);
          expect(f.manager.getCallCount("startDevice")).toBe(1);
        } else {
          const error: unknown = await f
            .start(args, owner ? HOLDER : undefined)
            .catch((error: unknown) => error);
          expect(await f.persistence.getSession!(HOLDER)).toEqual(row);
          expect(f.internals.rehydrationReservations.get(HOLDER)).toBe(hold);
          expect(f.sessions.getSession(HOLDER)).toBeNull();
          expect(f.manager.getCallCount("startDevice")).toBe(0);
          expect(f.manager.getCallCount("killDevice")).toBe(0);
          expect(await f.manager.getBootedDevices("android")).toContainEqual(spare);
          if (owner) {
            expect(error).toMatchObject({
              message: `Cannot safely recover session ${HOLDER}: prepared device does not match its recovery target.`,
            });
          } else {
            expect(error).toMatchObject({ code: "device_owned_by_other_session", retryable: true });
          }
        }
        expect(f.manager.getCallCount("killDevice")).toBe(0);
        expect(await f.manager.getBootedDevices("android")).toContainEqual(spare);
        expect(f.pool.getDevice(spare.deviceId)?.sessionId).not.toBe(HOLDER);
        expect(f.internals.intentionalShutdowns.size).toBe(0);
      });
    }
  }
  test("iOS exact UDID reservation refuses before boot", async () => {
    const f = await fixture({ platform: "ios" });
    await refusal(f, () => f.start());
  });
  test("iOS owner start resumes the same session", async () => {
    const f = await fixture({ platform: "ios" });
    await resumed(f, () => f.start(undefined, HOLDER));
  });
});

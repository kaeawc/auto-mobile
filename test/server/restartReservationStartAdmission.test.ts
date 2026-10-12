import { describe, expect } from "bun:test";
import { z } from "zod";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { InputDeviceOwnedError } from "../../src/daemon/inputDeviceOwnership";
import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
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
import { FakeDeviceSessionManager } from "../fakes/FakeDeviceSessionManager";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import type { HostChildProcess } from "../../src/utils/HostCommandExecutor";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  drainMicrotasks,
  drainUntil,
  settleWithFakeTime,
  settleByFakeEvents,
} from "../helpers/fakeTimerStepping";
import { warmedTests } from "../helpers/warmedTests";

const HOLDER = "restart-holder";
const CONNECTION = "holder-connection";
interface Internals {
  releaseDisconnectedRecoverySessionWithRetry(
    id: string,
    deviceId: string,
    reason: SessionReleaseReason,
  ): Promise<void>;
  rehydrationReservations: Map<string, { restartHandoff?: boolean; scheduledDeadlineMs?: number }>;
  intentionalShutdowns: Map<string, number>;
}

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
    } = {},
  ) {
    const platform = options.platform ?? "android";
    const env = { AUTOMOBILE_DEVICE_POOL_AUTOLOCK: "0" };
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
    const sessions = new SessionManager(
      timer,
      persistence,
      () => new FakeDbWriteBarrier(),
      () => ({ restore: async () => {} }),
    );
    sessions.attachDaemonSessionId("restart-start-daemon");
    sessions.stopCleanupTimer();
    const pool = new DevicePool(
      createDevicePoolDependencies(sessions, "restart-start-daemon", {
        env,
        timer,
        deviceManager: manager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        recoveryPolicy: { onLoss: false, maxAttempts: 1 },
      }),
    );
    const restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      env,
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    const previousSessionManager: unknown = Reflect.get(ToolRegistry, "deviceSessionManager");
    const previousToolCalls: unknown = Reflect.get(ToolRegistry, "toolCallRepository");
    const deviceSessions = new FakeDeviceSessionManager();
    deviceSessions.setConnectedDevices([device]);
    Reflect.set(ToolRegistry, "deviceSessionManager", deviceSessions);
    Reflect.set(ToolRegistry, "toolCallRepository", { recordToolCall: async () => {} });
    cleanups.push(() => {
      pool.releaseDeviceClaimsForShutdown();
      sessions.stopCleanupTimer();
      timer.reset();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      restorePipeline();
      Reflect.set(ToolRegistry, "deviceSessionManager", previousSessionManager);
      Reflect.set(ToolRegistry, "toolCallRepository", previousToolCalls);
      expect(Reflect.get(ToolRegistry, "deviceSessionManager")).toBe(previousSessionManager);
      expect(Reflect.get(ToolRegistry, "toolCallRepository")).toBe(previousToolCalls);
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
    const holder = options.label ? `${HOLDER}:phone` : HOLDER;
    await pool.bindOrReuseDeviceSession(
      holder,
      device.deviceId,
      platform,
      undefined,
      undefined,
      device,
      false,
      undefined,
      undefined,
      undefined,
      options.connection,
    );
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
    const internals = pool as unknown as Internals;
    await internals.releaseDisconnectedRecoverySessionWithRetry(
      holder,
      device.deviceId,
      `device-restart:${platform === "android" ? device.name : device.deviceId}`,
    );
    await pool.releaseDevice(device.deviceId, holder);
    if (!options.running) {
      manager.setBootedDevices(platform, []);
      await pool.removeDevice(device.deviceId, true, pool.getDevice(device.deviceId));
    }
    await drainMicrotasks();
    registerDeviceTools();
    ToolRegistry.registerDeviceAware(
      "restartControl",
      "Exercise recovered control admission",
      z.object({ sessionUuid: z.string() }),
      async (target) => ({ deviceId: target.deviceId }),
      { deviceReadiness: "booted" },
    );
    manager.clearHistory();
    const call = (name: string, args: Record<string, unknown>, routingSessionUuid?: string) =>
      runWithToolSelectionContext({ routingSessionUuid }, () =>
        ToolRegistry.getTool(name)!.handler(args),
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
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  function coldBoot(f: Fixture) {
    const child = new FakeChildProcess(f.timer);
    const process = child as unknown as HostChildProcess;
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

  test("owner bind refuses R already live on a different device without rebind or second session", async () => {
    const f = await fixture();
    const boot = coldBoot(f);
    const spare = { ...f.device, name: "spare-phone", deviceId: "emulator-5556" };
    f.manager.beforeReady = async () => {
      await f.pool.initializeWithDevices([f.device, spare]);
      f.manager.setBootedDevices("android", [f.device, spare]);
      await f.call("restartControl", { sessionUuid: HOLDER });
      await f.pool.bindOrReuseDeviceSession(
        HOLDER,
        spare.deviceId,
        "android",
        undefined,
        undefined,
        spare,
        true,
      );
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
      (await f.sessions.getOrCreateSession(f.holder, f.pool, f.device.platform, undefined, true))
        .assignedDevice,
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
    f.manager.setMockChildProcess(f.device.name, child as unknown as HostChildProcess);
    f.manager.beforeReady = async () => {
      await f.sessions.releaseSession(HOLDER, "explicit-release");
    };
    await expect(f.start(undefined, HOLDER)).rejects.toBeInstanceOf(TerminalSessionError);
    expect(f.sessions.getAllSessions()).toHaveLength(0);
    expect(child.killed).toBe(true);
    f.timer.advanceTime(0);
    await drainMicrotasks();
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
    const wire = JSON.parse(result.content[0].text);
    expect(wire).toMatchObject({
      error: { code: "device_owned_by_other_session", retryable: true, retryAfterMs: 167_655 },
    });
    expect(f.manager.getCallCount("startDevice")).toBe(0);
  });
  test("ended reservation permits an ordinary rival acquisition", async () => {
    const f = await fixture();
    f.timer.advanceTime(180_001);
    await drainMicrotasks();
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
    const process = child as unknown as HostChildProcess;
    f.manager.setMockChildProcess(f.device.name, process);
    await resumed(f, () => f.start(undefined, HOLDER));
    expect(f.pool.hasStartedDeviceProcess(f.device.deviceId, process)).toBe(true);
    expect(f.pool.getDevice(f.device.deviceId)?.androidImage?.name).toBe(f.device.name);
    child.simulateExit();
    f.timer.advanceTime(0);
    await drainMicrotasks();
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
      f.manager.setMockChildProcess(f.device.name, child as unknown as HostChildProcess);
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
      await expect(call()).rejects.toThrow(`Cannot safely recover session ${HOLDER}`);
      expect(f.sessions.getAllSessions()).toHaveLength(0);
      expect(child.killed).toBe(true);
      f.timer.advanceTime(0);
      await drainMicrotasks();
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
  test("iOS exact UDID reservation refuses before boot", async () => {
    const f = await fixture({ platform: "ios" });
    await refusal(f, () => f.start());
  });
  test("iOS owner start resumes the same session", async () => {
    const f = await fixture({ platform: "ios" });
    await resumed(f, () => f.start(undefined, HOLDER));
  });
});

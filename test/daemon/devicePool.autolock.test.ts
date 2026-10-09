import { drainUntil } from "../helpers/fakeTimerStepping";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { SessionManager, type KeepScreenAwakeRestorer } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { ActionableError } from "../../src/models";

const AUTOLOCK_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
  "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
] as const;
const TIMEOUT_ENV_KEYS = [
  "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
  "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
] as const;

function clearAutolockEnv(): void {
  for (const key of [...AUTOLOCK_ENV_KEYS, ...TIMEOUT_ENV_KEYS]) {
    delete process.env[key];
  }
}

describe("DevicePool autolock", () => {
  let pool: DevicePool;
  let sessionManager: SessionManager;
  let timer: FakeTimer;
  let fakeDeviceUtils: FakeDeviceUtils;
  const androidDevice = {
    name: "Pixel 7",
    platform: "android" as const,
    deviceId: "emulator-5554",
  };

  const initializeLiveAndroidDevice = async (): Promise<void> => {
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await pool.initializeWithDevices([androidDevice]);
  };

  beforeEach(() => {
    clearAutolockEnv();
    timer = new FakeTimer();
    sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    fakeDeviceUtils = new FakeDeviceUtils();

    pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "daemon-session-1", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
  });

  afterEach(() => {
    clearAutolockEnv();
  });

  it("autolockDevice returns undefined when autolock is disabled", async () => {
    // Autolock env not set -> disabled
    await pool.initializeWithDevices([
      { name: "Pixel 7", platform: "android", deviceId: "emulator-5554" },
    ]);

    const sessionId = await pool.autolockDevice("emulator-5554", "android");
    expect(sessionId).toBeUndefined();
  });

  it("assigns device to session when pool has the device", async () => {
    // We can test the session creation path directly through assignDeviceToSession
    await initializeLiveAndroidDevice();

    const deviceId = await pool.assignDeviceToSession("test-session-uuid", "android");
    expect(deviceId).toBe("emulator-5554");

    const session = sessionManager.getSession("test-session-uuid");
    expect(session).not.toBeNull();
    expect(session!.assignedDevice).toBe("emulator-5554");
  });

  it("restores persisted autolock identity before a recovered session is published", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const recoveringManager = new SessionManager(timer, persistence);
    const recoveringPool = new DevicePool(
      createDevicePoolDependencies(recoveringManager, "daemon-session-2", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await recoveringPool.initializeWithDevices([androidDevice]);
    await persistence.upsertActiveSession({
      sessionUuid: "recovered-autolock",
      deviceId: "emulator-5554",
      stableDeviceId: "Pixel 7",
      platform: "android",
      source: "autolock",
      autolockEnabled: true,
      mcpSessionId: "previous-mcp-session",
      daemonSessionId: "previous-daemon-session",
      createdAtMs: 1,
      lastUsedAtMs: 20,
      expiresAtMs: 60_020,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 15_000,
      hasReceivedHeartbeat: true,
    });
    await persistence.markReleased("recovered-autolock", "released", 30, "daemon-restart");

    try {
      await recoveringManager.rehydratePersistedSessions(recoveringPool);

      expect(recoveringPool.getDevice("emulator-5554")).toMatchObject({
        sessionId: "recovered-autolock",
        autolockSessionId: "recovered-autolock",
      });
      expect(await persistence.getSession?.("recovered-autolock")).toMatchObject({
        source: "autolock",
        autolock_enabled: 1,
        mcp_session_id: "previous-mcp-session",
        daemon_session_id: "previous-daemon-session",
      });
      await expect(
        recoveringPool.attachAutolockSessionToMcpSession("recovered-autolock", "reconnected-mcp"),
      ).resolves.toBeUndefined();
    } finally {
      recoveringManager.stopCleanupTimer();
    }
  });

  it("releases a matching pooled device when an ordinary session expires", async () => {
    await initializeLiveAndroidDevice();
    await pool.assignDeviceToSession("test-session", "android");
    expect(sessionManager.getSession("test-session")).not.toBeNull();

    // Trigger ordinary lazy expiry. Unlike an autolock session, this assignment
    // has no autolockSessionId, but must still return its matching device to the pool.
    timer.advanceTime(31 * 60 * 1000);
    expect(sessionManager.getSession("test-session")).toBeNull();
    await sessionManager.waitForSessionRelease("test-session");
    expect(pool.getDevice("emulator-5554")).toMatchObject({
      sessionId: null,
      status: "idle",
    });

    await expect(pool.assignDeviceToSession("replacement-session", "android")).resolves.toBe(
      "emulator-5554",
    );
    expect(pool.getDevice("emulator-5554")?.sessionId).toBe("replacement-session");
  });

  it("releases a matching pooled device during ordinary session cleanup", async () => {
    await initializeLiveAndroidDevice();
    await pool.assignDeviceToSession("test-session", "android");

    // Advance past the 30-minute timeout and the five-minute cleanup interval
    // without reading the session, so the periodic callback owns the expiry.
    timer.advanceTime(36 * 60 * 1000);
    await sessionManager.waitForSessionRelease("test-session");

    expect(pool.getDevice("emulator-5554")).toMatchObject({
      sessionId: null,
      status: "idle",
    });
    await expect(pool.assignDeviceToSession("replacement-session", "android")).resolves.toBe(
      "emulator-5554",
    );
  });

  it("restores expired session state before returning its device to the pool", async () => {
    let finishRestore!: () => void;
    const restoreFinished = new Promise<void>((resolve) => {
      finishRestore = resolve;
    });
    let restoreCalls = 0;
    const restorer: KeepScreenAwakeRestorer = {
      async restore(): Promise<void> {
        restoreCalls++;
        await restoreFinished;
      },
    };
    const restoringManager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
      () => restorer,
    );
    const restoringPool = new DevicePool(
      createDevicePoolDependencies(restoringManager, "daemon-session-1", {
        timer: timer,
        deviceManager: fakeDeviceUtils,
      }),
    );
    fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
    await restoringPool.initializeWithDevices([androidDevice]);
    await restoringPool.assignDeviceToSession("test-session", "android");
    restoringManager.setKeepScreenAwake("test-session", {
      applied: true,
      method: "svc",
      svcWasEnabled: false,
    });

    timer.advanceTime(31 * 60 * 1000);
    expect(restoringManager.getSession("test-session")).toBeNull();
    await Promise.resolve();
    expect(restoreCalls).toBe(1);
    expect(restoringPool.getDevice("emulator-5554")).toMatchObject({
      sessionId: "test-session",
      status: "busy",
    });

    finishRestore();
    await restoringManager.waitForSessionRelease("test-session");
    expect(restoringPool.getDevice("emulator-5554")).toMatchObject({
      sessionId: null,
      status: "idle",
    });
    restoringManager.stopCleanupTimer();
  });

  it("leaves explicit session release to its caller's ordered pool cleanup", async () => {
    await initializeLiveAndroidDevice();
    await pool.assignDeviceToSession("test-session", "android");

    await sessionManager.releaseSession("test-session");

    // Explicit callers perform other release cleanup before calling releaseDevice.
    expect(pool.getDevice("emulator-5554")).toMatchObject({
      sessionId: "test-session",
      status: "busy",
    });
    await pool.releaseDevice("emulator-5554", "test-session");
    expect(pool.getDevice("emulator-5554")).toMatchObject({
      sessionId: null,
      status: "idle",
    });
  });

  it("does not auto-start a device image after that pool device disconnects", async () => {
    const androidImage = {
      name: "Medium_Phone_API_35",
      platform: "android" as const,
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local" as const,
    };

    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeDeviceUtils.setBootedDevices("android", []);
    await pool.initializeWithDevices([
      { name: "Medium_Phone_API_35", platform: "android", deviceId: "emulator-5554" },
    ]);

    await pool.removeDisconnectedDevice("emulator-5554");

    await expect(pool.assignMultipleDevices(["next-session"], 1000, "android")).rejects.toThrow(
      ActionableError,
    );
    expect(fakeDeviceUtils.getCallCount("startDevice")).toBe(0);
  });

  it("does not suppress auto-start when disconnected removal is blocked by assignment", async () => {
    const androidImage = {
      name: "Medium_Phone_API_35",
      platform: "android" as const,
      deviceId: "emulator-5554",
      isRunning: false,
      source: "local" as const,
    };

    const bootedDevice = {
      name: "Medium_Phone_API_35",
      platform: "android" as const,
      deviceId: "emulator-5554",
    };
    fakeDeviceUtils.setDeviceImages("android", [androidImage]);
    fakeDeviceUtils.setBootedDevices("android", [bootedDevice]);
    await pool.initializeWithDevices([bootedDevice]);

    await pool.assignDeviceToSession("active-session", "android");
    fakeDeviceUtils.setBootedDevices("android", []);
    fakeDeviceUtils.markDeviceAsStopped("Medium_Phone_API_35");
    fakeDeviceUtils.markDeviceAsStopped("emulator-5554");
    await pool.removeDisconnectedDevice("emulator-5554");
    await pool.releaseDevice("emulator-5554", "active-session");
    await pool.removeDevice("emulator-5554");

    const assignments = await pool.assignMultipleDevices(["next-session"], 1000, "android");

    expect(assignments.get("next-session")).toBe("emulator-5554");
    expect(fakeDeviceUtils.getCallCount("startDevice")).toBe(1);
  });

  it("createSession accepts custom timeout", async () => {
    const session = await sessionManager.createSession(
      "autolock-session",
      "emulator-5554",
      "android",
      5000, // 5 second timeout
    );

    expect(session.expiresAt).toBe(timer.now() + 5000);
  });

  it("session with custom timeout expires at correct time", async () => {
    await sessionManager.createSession("autolock-session", "emulator-5554", "android", 5000);

    // Not expired yet
    timer.advanceTime(4000);
    expect(sessionManager.getSession("autolock-session")).not.toBeNull();

    // Now expired
    timer.advanceTime(2000);
    expect(sessionManager.getSession("autolock-session")).toBeNull();
  });

  it("heartbeat extends session expiry", async () => {
    await sessionManager.createSession("autolock-session", "emulator-5554", "android", 5000);

    // Advance to just before expiry
    timer.advanceTime(4000);
    sessionManager.recordHeartbeat("autolock-session");

    // Would have expired without heartbeat
    timer.advanceTime(2000);
    expect(sessionManager.getSession("autolock-session")).not.toBeNull();
  });

  describe("when autolock is enabled", () => {
    beforeEach(() => {
      process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
      // 60 second idle timeout
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "60";
    });

    it("locks the device to a generated session UUID", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");

      expect(sessionId).toBeDefined();
      const device = pool.getDevice("emulator-5554")!;
      expect(device.status).toBe("busy");
      expect(device.sessionId).toBe(sessionId!);
      expect(device.autolockSessionId).toBe(sessionId!);

      // Session created with the configured idle timeout
      const session = sessionManager.getSession(sessionId!);
      expect(session).not.toBeNull();
      expect(session!.assignedDevice).toBe("emulator-5554");
      expect(session!.expiresAt).toBe(timer.now() + 60_000);
    });

    it("mints the autolock session id from the injected IdGenerator", async () => {
      const deterministicPool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "daemon-session-1", {
          timer: timer,
          deviceManager: fakeDeviceUtils,
          idGenerator: new CountingIdGenerator("autolock"),
        }),
      );
      fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
      await deterministicPool.initializeWithDevices([androidDevice]);

      const sessionId = await deterministicPool.autolockDevice("emulator-5554", "android");

      expect(sessionId).toBe("autolock-1");
      expect(deterministicPool.getDevice("emulator-5554")?.autolockSessionId).toBe("autolock-1");
    });

    it("rejects autolock for a stale idle iOS simulator", async () => {
      await pool.initializeWithDevices([
        { name: "iPhone 15", platform: "ios", deviceId: "sim-stale" },
      ]);
      fakeDeviceUtils.setBootedDevices("ios", []);

      await expect(pool.autolockDevice("sim-stale", "ios")).rejects.toThrow(
        /not available for autolock/,
      );
      expect(pool.getDevice("sim-stale")?.status).toBe("idle");
    });

    it("maps an MCP session to its generated autolock session", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");

      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBe(sessionId);
      expect(() => pool.resolveAutolockSessionForMcpSession("mcp-session-1", "ios")).toThrow(
        "Candidate sessions:",
      );
      expect(
        pool.resolveAutolockSessionForMcpSession("other-mcp-session", "android"),
      ).toBeUndefined();
    });

    it("clears socket-scoped routes when an MCP connection closes", async () => {
      await initializeLiveAndroidDevice();
      await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBeDefined();

      pool.releaseMcpSessionBindings("mcp-session-1");

      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBeUndefined();
    });

    it("keeps a recovering owned session in the ambiguity candidate set", async () => {
      // Two Android devices autolocked by the same MCP connection. When one is
      // detached by a process-wide ADB reset, its session is still owned by the
      // connection - it is merely recovering. An implicit `platform: "android"`
      // selector must report ambiguity rather than silently routing every call
      // to the one device that happens to still be attached.
      const first = {
        name: "Pixel_8_API_35",
        platform: "android" as const,
        deviceId: "emulator-5554",
      };
      const second = {
        name: "Pixel_9_API_36",
        platform: "android" as const,
        deviceId: "emulator-5556",
      };
      const firstImage = {
        name: first.name,
        platform: "android" as const,
        isRunning: true,
        source: "local" as const,
      };
      const secondImage = { ...firstImage, name: second.name };
      fakeDeviceUtils.setBootedDevices("android", [first, second]);
      await pool.addDevice(first, firstImage);
      await pool.addDevice(second, secondImage);
      const firstSession = await pool.autolockDevice(
        first.deviceId,
        "android",
        "mcp-session-1",
        firstImage,
      );
      const secondSession = await pool.autolockDevice(
        second.deviceId,
        "android",
        "mcp-session-1",
        secondImage,
      );

      const detached = await pool.detachAdbServerResetCohort([pool.getDevice(first.deviceId)!]);
      try {
        expect(pool.isSessionRecoveryInFlight(firstSession!)).toBe(true);
        expect(() => pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toThrow(
          new RegExp(`Candidate sessions:.*${firstSession}.*${secondSession}`, "s"),
        );
      } finally {
        await pool.releaseAdbServerResetCohortReservations(detached.devices);
      }
    });

    it("does not let a queued restoration overwrite a default set after its snapshot", async () => {
      // `setActiveDevice` can land between the moment restoration reads "this
      // connection has no default" and the moment it actually attaches. The
      // conditional default must therefore be evaluated at attach time, under
      // the assignment mutex, not from the stale pre-loop snapshot.
      const first = {
        name: "Pixel_8_API_35",
        platform: "android" as const,
        deviceId: "emulator-5554",
      };
      const second = {
        name: "Pixel_9_API_36",
        platform: "android" as const,
        deviceId: "emulator-5556",
      };
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let gatedSessionId: string | undefined;
      const repository = {
        markAutolockSession: async (sessionId: string): Promise<void> => {
          if (gatedSessionId === sessionId) {
            gatedSessionId = undefined;
            entered.resolve();
            await gate.promise;
          }
        },
      };
      const gatedPool = new DevicePool(
        createDevicePoolDependencies(sessionManager, "daemon-session-1", {
          timer: timer,
          deviceManager: fakeDeviceUtils,
          deviceSessionRepository: repository,
        }),
      );
      fakeDeviceUtils.setBootedDevices("android", [first, second]);
      await gatedPool.initializeWithDevices([first, second]);
      const firstSession = await gatedPool.autolockDevice(first.deviceId, "android");
      const secondSession = await gatedPool.autolockDevice(second.deviceId, "android");

      gatedSessionId = firstSession;
      const explicit = gatedPool.attachAutolockSessionToMcpSession(firstSession!, "mcp-session-1");
      await entered.promise;
      const restore = gatedPool.restoreAutolockSessionsForMcpSession(
        [secondSession!],
        "mcp-session-1",
      );
      gate.resolve();
      await explicit;
      await restore;

      expect(gatedPool.resolveAutolockSessionForMcpSession("mcp-session-1")).toBe(firstSession);
    });

    it("records achieved readiness before publishing the MCP session route (#6227 round 9)", async () => {
      await initializeLiveAndroidDevice();

      // A concurrent tool call from the same MCP client reaches the new session
      // through `resolveAutolockSessionForMcpSession`. Readiness must be recorded
      // before that route is publishable, or the concurrent call could observe an
      // unrecorded readiness and redundantly re-run (or wrongly skip) setup.
      const originalSetter = sessionManager.setDeviceReadiness.bind(sessionManager);
      let routeResolvableAtRecordTime: string | undefined = "setter-not-called";
      sessionManager.setDeviceReadiness = (sessionId, level) => {
        routeResolvableAtRecordTime = pool.resolveAutolockSessionForMcpSession(
          "mcp-session-1",
          "android",
        );
        originalSetter(sessionId, level);
      };

      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");

      expect(routeResolvableAtRecordTime).toBeUndefined();
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBe(sessionId);
      expect(sessionManager.getDeviceReadiness(sessionId!)).toBe("automationReady");
    });

    it("honors the achieved readiness level passed to autolockDevice (#6227 round 9)", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice(
        "emulator-5554",
        "android",
        "mcp-session-1",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "booted",
      );

      expect(sessionManager.getDeviceReadiness(sessionId!)).toBe("booted");
    });

    it("clears MCP session mapping when the autolock session expires", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBe(sessionId);

      timer.advanceTime(61 * 1000);
      expect(sessionManager.getSession(sessionId!)).toBeNull();
      await sessionManager.waitForSessionRelease(sessionId!);

      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBeUndefined();
    });

    it("keeps routing an expired autolock to its session while older work holds the veto (#10956)", async () => {
      await initializeLiveAndroidDevice();
      sessionManager.setActiveSessionExecutionChecker(() => true);

      const sessionId = await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      timer.advanceTime(61 * 1000);

      // A routing lookup carries no execution: it must not release the session under the
      // older call, which is still driving the device.
      expect(pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android")).toBe(sessionId);
      expect(sessionManager.getSession(sessionId!)).not.toBeNull();
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");
    });

    it("keeps autolock enforcement until deferred expiry release publishes the device idle", async () => {
      process.env.AUTOMOBILE_DEVICE_POOL_TIMEOUT = "1";
      let finishRestore!: () => void;
      const restoration = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      let restoreStarted!: () => void;
      const restorationStarted = new Promise<void>((resolve) => {
        restoreStarted = resolve;
      });
      const restoringManager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({
          restore: async (): Promise<void> => {
            restoreStarted();
            await restoration;
          },
        }),
      );
      const restoringPool = new DevicePool(
        createDevicePoolDependencies(restoringManager, "daemon-session-1", {
          timer: timer,
          deviceManager: fakeDeviceUtils,
        }),
      );
      try {
        fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
        await restoringPool.initializeWithDevices([androidDevice]);
        const sessionId = await restoringPool.autolockDevice("emulator-5554", "android");
        restoringManager.setKeepScreenAwake(sessionId!, {
          applied: true,
          method: "svc",
          svcWasEnabled: false,
        });
        timer.advanceTime(1_001);
        expect(restoringManager.getSession(sessionId!)).toBeNull();
        await restorationStarted;

        timer.advanceTime(1_000);
        await restoringManager.waitForSessionRelease(sessionId!);
        expect(restoringPool.getDevice("emulator-5554")).toMatchObject({
          sessionId,
          status: "busy",
          autolockSessionId: sessionId,
        });
        expect(() => restoringPool.assertAutolockAccess("emulator-5554", "other-session")).toThrow(
          ActionableError,
        );

        finishRestore();
        await drainUntil(() => restoringPool.getDevice("emulator-5554")?.status === "idle", {
          description: "deferred expiry publishes idle device",
        });
        expect(restoringPool.getDevice("emulator-5554")).toMatchObject({
          sessionId: null,
          status: "idle",
          autolockSessionId: undefined,
        });
      } finally {
        restoringManager.stopCleanupTimer();
      }
    });

    it("quarantines same-UUID reacquisition until deferred teardown settles", async () => {
      let finishRestore!: () => void;
      const restoration = new Promise<void>((resolve) => {
        finishRestore = resolve;
      });
      let restoreStarted!: () => void;
      const restorationStarted = new Promise<void>((resolve) => {
        restoreStarted = resolve;
      });
      const restoringManager = new SessionManager(
        timer,
        new FakeDeviceSessionPersistence(),
        () => new FakeDbWriteBarrier(),
        () => ({
          restore: async (): Promise<void> => {
            restoreStarted();
            await restoration;
          },
        }),
      );
      const restoringPool = new DevicePool(
        createDevicePoolDependencies(restoringManager, "daemon-session-1", {
          timer: timer,
          deviceManager: fakeDeviceUtils,
        }),
      );
      try {
        fakeDeviceUtils.setBootedDevices("android", [androidDevice]);
        await restoringPool.initializeWithDevices([androidDevice]);
        await restoringPool.assignDeviceToSession("reused-session", "android");
        restoringManager.setKeepScreenAwake("reused-session", {
          applied: true,
          method: "svc",
          svcWasEnabled: false,
        });

        const release = restoringManager.releaseSession("reused-session", "allocation-rollback");
        await restorationStarted;
        timer.advanceTime(1_000);
        await restoringManager.waitForSessionRelease("reused-session");
        await release;
        await restoringPool.releaseDevice("emulator-5554", "reused-session");
        await expect(
          restoringPool.bindOrReuseDeviceSession("reused-session", "emulator-5554", "android"),
        ).rejects.toThrow("cleanup");
        const cleanup = restoringManager.getPendingDeviceCleanup("emulator-5554");
        finishRestore();
        await cleanup;
        await restoringPool.bindOrReuseDeviceSession("reused-session", "emulator-5554", "android");

        expect(restoringPool.getDevice("emulator-5554")).toMatchObject({
          sessionId: "reused-session",
          status: "busy",
        });
        expect(restoringManager.getSession("reused-session")?.assignedDevice).toBe("emulator-5554");
      } finally {
        restoringManager.stopCleanupTimer();
      }
    });

    it("rejects a late MCP request while earlier work still owns the expired autolock", async () => {
      await initializeLiveAndroidDevice();
      sessionManager.setActiveSessionExecutionChecker(
        (_sessionId, query) => query?.excludeExecutionId === "late",
      );

      await pool.autolockDevice("emulator-5554", "android", "mcp-session-1");
      timer.advanceTime(61 * 1000);

      expect(() =>
        pool.resolveAutolockSessionForMcpSession("mcp-session-1", "android", {
          executionId: "late",
          startTime: timer.now(),
        }),
      ).toThrow("earlier work is still active");
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");
    });

    it("uses the default owner lease for liveness and the autolock window only for idle release (#10729)", async () => {
      // The owner's proxy binds and heartbeats the session getAndroid/startDevice minted, so a
      // dead owner must be judged on the ~10 s owner lease like any bound session. The 60 s
      // autolock window bounds only the idle release.
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      const session = sessionManager.getSession(sessionId!)!;

      expect(session.heartbeatTimeoutMs).toBe(SessionManager.DEFAULT_HEARTBEAT_TIMEOUT_MS);
      expect(session.heartbeatTimeoutSource).toBe("default");
      expect(session.sessionTimeoutMs).toBe(60_000);
      expect(session.expiresAt).toBe(session.lastUsedAt + 60_000);
    });

    it("auto-releases the device after the idle timeout (periodic cleanup)", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      // Advance past both the idle timeout (60s) and the cleanup interval (5 min),
      // so the periodic cleanup fires and releases the expired session's device.
      timer.advanceTime(6 * 60 * 1000);
      await sessionManager.waitForSessionRelease(sessionId!);

      const device = pool.getDevice("emulator-5554")!;
      expect(device.status).toBe("idle");
      expect(device.sessionId).toBeNull();
      expect(device.autolockSessionId).toBeUndefined();
      expect(sessionManager.getSession(sessionId!)).toBeNull();
    });

    it("auto-releases the device on lazy session expiry", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");

      // Past the 60s timeout but before the 5-min cleanup interval.
      timer.advanceTime(61 * 1000);

      // Touching the expired session lazily expires it and fires the release callback.
      expect(sessionManager.getSession(sessionId!)).toBeNull();
      await sessionManager.waitForSessionRelease(sessionId!);

      const device = pool.getDevice("emulator-5554")!;
      expect(device.status).toBe("idle");
      expect(device.autolockSessionId).toBeUndefined();
    });

    it("a stale lock released by the idle timeout lets a new session acquire the device", async () => {
      // Symmetric to the auto-release cases above: an expired session's lock must
      // not permanently strand the device. Prove a real before/after transition on
      // the acquire itself — the new session is refused while the stale lock holds
      // the device, then succeeds once the idle timeout frees it.
      await initializeLiveAndroidDevice();

      await pool.autolockDevice("emulator-5554", "android");
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");

      // BEFORE advancing time: the stale lock still holds the only device busy, so
      // a new session cannot acquire it with a zero wait budget.
      await expect(pool.assignMultipleDevices(["new-session"], 0, "android")).rejects.toThrow(
        ActionableError,
      );
      expect(pool.getDevice("emulator-5554")!.sessionId).not.toBe("new-session");

      // Advance past the idle timeout (60s) and the cleanup interval (5 min) so the
      // periodic sweep releases the expired autolock session's device.
      timer.advanceTime(6 * 60 * 1000);

      // AFTER advancing time: the freed device is acquirable by the new session.
      const assignments = await pool.assignMultipleDevices(["new-session"], 1000, "android");
      expect(assignments.get("new-session")).toBe("emulator-5554");
      expect(pool.getDevice("emulator-5554")!.sessionId).toBe("new-session");
    });

    it("tool activity before the idle timeout keeps the device locked", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");

      // Just before timeout, a tool call resolves the session.
      timer.advanceTime(59 * 1000);
      await sessionManager.getOrCreateSession(sessionId!);

      // Another window passes; without the tool call this would have expired.
      timer.advanceTime(30 * 1000);

      expect(sessionManager.getSession(sessionId!)).not.toBeNull();
      expect(pool.getDevice("emulator-5554")!.status).toBe("busy");
    });

    it("a liveness heartbeat alone does not keep an idle autolocked device (#10656, #10658)", async () => {
      await initializeLiveAndroidDevice();

      const sessionId = await pool.autolockDevice("emulator-5554", "android");

      // A live owner keeps heartbeating, but makes no tool call.
      timer.advanceTime(59 * 1000);
      sessionManager.recordHeartbeat(sessionId!);

      // Past the idle timeout and the suspect grace a heartbeating session earns.
      timer.advanceTime(30 * 1000);

      expect(sessionManager.getSession(sessionId!)).toBeNull();
      await drainUntil(() => pool.getDevice("emulator-5554")!.status === "idle", {
        description: "idle autolocked device released",
      });
    });

    it("does not release a device re-locked by a different session", async () => {
      await initializeLiveAndroidDevice();

      const firstSession = await pool.autolockDevice("emulator-5554", "android");
      // Simulate the device being re-locked under a new session before the old
      // session's release callback fires.
      const device = pool.getDevice("emulator-5554")!;
      device.autolockSessionId = "new-session";
      device.sessionId = "new-session";
      device.status = "busy";

      // Expire the original session.
      timer.advanceTime(61 * 1000);
      expect(sessionManager.getSession(firstSession!)).toBeNull();

      // The stale release for the first session must not free the re-locked device.
      const after = pool.getDevice("emulator-5554")!;
      expect(after.status).toBe("busy");
      expect(after.sessionId).toBe("new-session");
      expect(after.autolockSessionId).toBe("new-session");
    });

    describe("assertAutolockAccess", () => {
      beforeEach(async () => {
        await initializeLiveAndroidDevice();
      });

      it("allows the owning session", async () => {
        const sessionId = await pool.autolockDevice("emulator-5554", "android");
        expect(() => pool.assertAutolockAccess("emulator-5554", sessionId)).not.toThrow();
      });

      it("rejects a different session", async () => {
        await pool.autolockDevice("emulator-5554", "android");
        expect(() => pool.assertAutolockAccess("emulator-5554", "other-session")).toThrow(
          ActionableError,
        );
      });

      it("rejects an absent session", async () => {
        await pool.autolockDevice("emulator-5554", "android");
        expect(() => pool.assertAutolockAccess("emulator-5554", undefined)).toThrow(
          ActionableError,
        );
      });

      it("no-ops when the device is not locked", () => {
        expect(() => pool.assertAutolockAccess("emulator-5554", "any-session")).not.toThrow();
      });

      it("no-ops for an unknown device", () => {
        expect(() => pool.assertAutolockAccess("does-not-exist", undefined)).not.toThrow();
      });
    });
  });

  it("assertAutolockAccess no-ops when autolock is disabled even if a device is locked", async () => {
    // Lock a device while enabled...
    process.env.AUTOMOBILE_DEVICE_POOL_AUTOLOCK = "1";
    await initializeLiveAndroidDevice();
    await pool.autolockDevice("emulator-5554", "android");

    // ...then disable autolock: enforcement is bypassed.
    clearAutolockEnv();
    expect(() => pool.assertAutolockAccess("emulator-5554", "mismatched")).not.toThrow();
  });
});

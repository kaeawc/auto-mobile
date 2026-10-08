import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  SessionScopedStreamAuthenticator,
  STREAM_SOCKET_AUTH_ENV,
} from "../../src/daemon/streamSocketAuth";
import {
  isDeviceControlTargetOwnerValid,
  isDeviceControlRoutingSessionValid,
} from "../../src/daemon/deviceControlSessionValidity";
import { DevicePool } from "../../src/daemon/devicePool";
import { PLAN_AUTO_RELEASE_REASON, TerminalSessionError } from "../../src/daemon/sessionManager";
import {
  MissingDeviceLiveness,
  type MissingDeviceLivenessPoolPort,
} from "../../src/daemon/missingDeviceLiveness";
import { runDaemonCommand } from "../../src/daemon/manager";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { ActionableError } from "../../src/models";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import {
  releasingSessionHarness,
  releasingSessionId as sessionId,
  releasingDeviceId as deviceId,
} from "../helpers/releasingSessionHarness";

const notFound = {
  success: false,
  error: `Session not found: ${sessionId}`,
  code: DAEMON_SESSION_NOT_FOUND_CODE,
};

describe("remaining paths during session release", () => {
  let h: ReturnType<typeof releasingSessionHarness>;
  beforeEach(() => {
    h = releasingSessionHarness();
  });
  afterEach(() => {
    h.dispose();
  });

  for (const requireOwnership of [false, true]) {
    test(`stream auth rejects releasing session (requireOwnership=${requireOwnership}) and release still drains`, async () => {
      await h.create();
      const auth = new SessionScopedStreamAuthenticator(() => h.manager, "test op", {});
      const input = { sessionUuid: sessionId, deviceId, requireOwnership };
      expect(() => auth.authorize(input)).not.toThrow();
      const finish = await h.beginRelease();
      expect(() => auth.authorize(input)).toThrow(ActionableError);
      expect(() => auth.authorize(input)).toThrow(
        `test op rejected: session ${sessionId} is not an active daemon session (being released).`,
      );
      await finish();
      expect(() => auth.authorize(input)).toThrow(
        `test op rejected: session ${sessionId} is not an active daemon session (unknown or expired).`,
      );
    });
  }

  test("sessionInfo does not flag an unregistered non-releasing object", async () => {
    await h.createUnregisteredSession();
    const response = await h.request("daemon/sessionInfo");
    expect(response.success).toBe(true);
    expect(response.result).not.toHaveProperty("releasing");
  });

  for (const kind of ["unregistered", "terminal-fenced"] as const) {
    test(`activeSessions does not count ${kind} sessions as releasing`, async () => {
      if (kind === "unregistered") {
        await h.createUnregisteredSession();
      } else {
        const session = await h.create();
        h.holdTerminalFence(session);
        expect(h.manager.getSession(sessionId)).toBeNull();
        expect(h.manager.getAllSessions()).toEqual([session]);
      }
      expect(await h.request("daemon/activeSessions")).toEqual({
        success: true,
        result: { activeSessions: 1, activeExecutions: 0 },
      });
    });
  }

  test("daemon heartbeat accepts an unregistered non-releasing object", async () => {
    await h.createUnregisteredSession();
    const heartbeat = spyOn(h.manager, "recordHeartbeat");
    try {
      expect((await h.request("daemon/heartbeat")).success).toBe(true);
      expect(heartbeat).toHaveBeenCalledWith(sessionId);
      // SessionManager's pre-existing admission guard still suppresses persistence.
      expect(h.persistence.activityWrites).toBe(0);
    } finally {
      heartbeat.mockRestore();
    }
  });

  test("device-control target owner accepts an unregistered non-releasing object", async () => {
    const session = await h.createUnregisteredSession();
    expect(
      isDeviceControlTargetOwnerValid(h.manager, {
        sessionUuid: sessionId,
        sessionIncarnation: session,
        deviceId,
      }),
    ).toBe(true);
  });

  test("device-control routing accepts an unregistered non-releasing object", async () => {
    const session = await h.createUnregisteredSession();
    expect(
      isDeviceControlRoutingSessionValid(h.manager, {
        sessionUuid: "other",
        routingSessionUuid: sessionId,
        routingSessionIncarnation: session,
      }),
    ).toBe(true);
  });

  test("CLI heartbeat accepts an unregistered non-releasing object", async () => {
    await h.createUnregisteredSession();
    const heartbeat = spyOn(h.manager, "recordHeartbeat");
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const exit = spyOn(process, "exit").mockImplementation((): never => {
      throw new Error("CLI exit");
    });
    try {
      await runDaemonCommand("heartbeat", [sessionId], {
        stateProvider: () => ({
          isInitialized: () => true,
          getSessionManager: () => h.manager,
          getDevicePool: (): never => {
            throw new Error("Unused pool");
          },
          getDeviceSessionRegistry: (): never => {
            throw new Error("Unused registry");
          },
        }),
      });
      expect(log).toHaveBeenCalledWith(`Session ${sessionId} heartbeat recorded`);
      expect(heartbeat).toHaveBeenCalledWith(sessionId);
      expect(h.persistence.activityWrites).toBe(0);
      expect(error).not.toHaveBeenCalled();
    } finally {
      heartbeat.mockRestore();
      log.mockRestore();
      error.mockRestore();
      exit.mockRestore();
    }
  });

  test("auth-disabled mode stays admitted during release", async () => {
    await h.create();
    const finish = await h.beginRelease();
    const auth = new SessionScopedStreamAuthenticator(() => h.manager, "test op", {
      [STREAM_SOCKET_AUTH_ENV]: "0",
    });
    expect(() => auth.authorize({ sessionUuid: sessionId, deviceId })).not.toThrow();
    await finish();
    expect(() => auth.authorize({ sessionUuid: sessionId, deviceId })).not.toThrow();
  });

  test("sessionInfo flags release and preserves the healthy response bytes", async () => {
    const session = await h.create();
    const healthy = {
      success: true,
      result: {
        sessionId,
        assignedDevice: deviceId,
        platform: "android",
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        expiresAt: session.expiresAt,
        cacheSize: JSON.stringify(session.cacheData).length,
        // Hold diagnostics (#10671): no owner heartbeat yet, no holder named, nothing in flight.
        lastToolActivityAt: session.lastUsedAt,
        lastOwnerHeartbeatAt: null,
        idleReleaseAt: session.expiresAt,
        holderKind: "unknown",
        activeExecutions: 0,
        // Additive liveness state (#10051); a fresh session is live with its full lease.
        liveness: { state: "live", remainingMs: session.heartbeatTimeoutMs },
      },
    };
    expect(JSON.stringify(await h.request("daemon/sessionInfo"))).toBe(JSON.stringify(healthy));
    const finish = await h.beginRelease();
    expect(await h.request("daemon/sessionInfo")).toEqual({
      ...healthy,
      result: {
        ...healthy.result,
        cacheSize: JSON.stringify(session.cacheData).length,
        releasing: true,
      },
    });
    await finish();
    expect(await h.request("daemon/sessionInfo")).toEqual(notFound);
  });

  test("activeSessions keeps teardown busy and adds only a positive releasing count", async () => {
    await h.create();
    const healthy = { success: true, result: { activeSessions: 1, activeExecutions: 0 } };
    expect(JSON.stringify(await h.request("daemon/activeSessions"))).toBe(JSON.stringify(healthy));
    const finish = await h.beginRelease();
    expect(await h.request("daemon/activeSessions")).toEqual({
      success: true,
      result: { ...healthy.result, releasingSessions: 1 },
    });
    await finish();
    expect(await h.request("daemon/activeSessions")).toEqual({
      success: true,
      result: { activeSessions: 0, activeExecutions: 0 },
    });
  });

  test("explicit terminal fence hides stream and sessionInfo during persistence while teardown stays busy", async () => {
    await h.create();
    const finish = await h.beginRelease("B");
    expect(h.manager.getTerminalReleaseSnapshot(sessionId)).toMatchObject({
      releaseReason: "explicit-release",
      terminal: true,
    });
    const auth = new SessionScopedStreamAuthenticator(() => h.manager, "test op", {});
    for (const requireOwnership of [false, true]) {
      expect(() => auth.authorize({ sessionUuid: sessionId, deviceId, requireOwnership })).toThrow(
        `test op rejected: session ${sessionId} is not an active daemon session (unknown or expired).`,
      );
    }
    expect(await h.request("daemon/sessionInfo")).toEqual(notFound);
    expect(await h.request("daemon/activeSessions")).toEqual({
      success: true,
      result: { activeSessions: 1, activeExecutions: 0, releasingSessions: 1 },
    });
    await finish();
    expect(await h.request("daemon/activeSessions")).toEqual({
      success: true,
      result: { activeSessions: 0, activeExecutions: 0 },
    });
  });

  for (const [name, valid, identityFor] of [
    [
      "target owner",
      isDeviceControlTargetOwnerValid,
      (session: object) => ({ sessionUuid: sessionId, sessionIncarnation: session, deviceId }),
    ],
    [
      "routing session",
      isDeviceControlRoutingSessionValid,
      (session: object) => ({
        sessionUuid: "another-owner",
        routingSessionUuid: sessionId,
        routingSessionIncarnation: session,
      }),
    ],
  ] as const) {
    test(`device-control ${name} refuses recovery and same-UUID replacement after explicit release`, async () => {
      const session = await h.create();
      const identity = identityFor(session);
      expect(valid(h.manager, identity)).toBe(true);
      const finish = await h.beginRelease();
      expect(valid(h.manager, identity)).toBe(false);
      await finish();
      expect(valid(h.manager, identity)).toBe(false);
      await expect(h.create()).rejects.toThrow(TerminalSessionError);
      await expect(h.create()).rejects.toThrow(
        `Session ${sessionId} was released and cannot be reused. Acquire a new device with getAndroid or getApple.`,
      );
      expect(valid(h.manager, identity)).toBe(false);
      expect(h.manager.getSession(sessionId)).toBeNull();
      expect(h.manager.getSessionForDevice(deviceId)).toBeNull();
    });

    test(`device-control ${name} accepts only the replacement incarnation after internal plan release`, async () => {
      const session = await h.create();
      const identity = identityFor(session);
      expect(valid(h.manager, identity)).toBe(true);
      const finishSetup = Promise.withResolvers<void>();
      const setup = h.manager.trackSessionSetup(session, () => finishSetup.promise);
      // Do not join daemon/releaseSession: that explicit client request upgrades
      // an in-flight internal release to terminal.
      const release = h.manager.releaseSession(sessionId, PLAN_AUTO_RELEASE_REASON);
      try {
        expect(h.manager.getReleasingSession(sessionId)).toBe(session);
        expect(valid(h.manager, identity)).toBe(false);
      } finally {
        finishSetup.resolve();
        h.persistence.finishRelease.resolve();
        await setup;
        expect(await release).toBe(deviceId);
      }
      expect(valid(h.manager, identity)).toBe(false);
      expect(h.manager.getSession(sessionId)).toBeNull();
      expect(h.manager.getSessionForDevice(deviceId)).toBeNull();
      expect(h.manager.getTerminalReleaseSnapshot(sessionId)).toBeUndefined();
      expect(await h.persistence.getSession?.(sessionId)).toMatchObject({
        status: "released",
        release_reason: PLAN_AUTO_RELEASE_REASON,
      });
      const replacement = await h.create();
      expect(replacement).not.toBe(session);
      expect(valid(h.manager, identity)).toBe(false);
      expect(valid(h.manager, identityFor(replacement))).toBe(true);
    });
  }

  test("device-control scopes without a separate session keep their existing semantics", () => {
    expect(isDeviceControlTargetOwnerValid(h.manager, {})).toBe(true);
    expect(isDeviceControlRoutingSessionValid(h.manager, {})).toBe(true);
    expect(
      isDeviceControlRoutingSessionValid(h.manager, {
        sessionUuid: sessionId,
        routingSessionUuid: sessionId,
      }),
    ).toBe(true);
    h.observers.register(sessionId, "desktop");
    expect(isDeviceControlRoutingSessionValid(h.manager, { routingSessionUuid: sessionId })).toBe(
      false,
    );
  });

  async function poolHarness() {
    let port: MissingDeviceLivenessPoolPort | undefined;
    const booted = { deviceId, platform: "android" as const, name: "Pixel_8_API_35" };
    const pool = new DevicePool(
      createDevicePoolDependencies(h.manager, "daemon", {
        timer: h.timer,
        deviceManager: new FakeDeviceManager([], [booted]),
        installedAppsRepository: new FakeInstalledAppsRepository(),
        deviceSessionContinuityEnabled: true,
        missingDeviceLivenessFactory: (value) => {
          port = value;
          return new MissingDeviceLiveness(value);
        },
      }),
    );
    await pool.initializeWithDevices([booted]);
    await h.create();
    const device = pool.getDevice(deviceId);
    if (!device || !port) {
      throw new Error("Expected pooled device and liveness port");
    }
    device.sessionId = sessionId;
    device.status = "assigned";
    return { pool, device, port };
  }

  test("pool recovery target accepts an unregistered non-releasing object", async () => {
    const { pool, device } = await poolHarness();
    const session = { ...h.manager.getSession(sessionId)! };
    h.manager.getSession = (id) => (id === sessionId ? session : null);
    expect(h.manager.isAdmittedForAutomation(session)).toBe(false);
    expect(h.manager.getReleasingSession(sessionId)).toBeNull();
    const preparation = pool.prepareSessionPreservingRecovery(deviceId, device);
    pool.finishSessionPreservingRecoveryPreparation(preparation);
    expect(preparation?.sessionId).toBe(sessionId);
  });

  test("pool missing-device preservation accepts an unregistered non-releasing object", async () => {
    const { pool, device, port } = await poolHarness();
    const session = { ...h.manager.getSession(sessionId)! };
    h.manager.getSession = (id) => (id === sessionId ? session : null);
    expect(h.manager.isAdmittedForAutomation(session)).toBe(false);
    expect(h.manager.getReleasingSession(sessionId)).toBeNull();
    const recovery = spyOn(pool, "recoverSessionBoundDeviceAfterLoss").mockResolvedValue(
      "deferred",
    );
    try {
      expect(await port.tryPreserveSessionForMissingDevice(device, true, undefined)).toBe(true);
      expect(recovery).toHaveBeenCalledTimes(1);
    } finally {
      recovery.mockRestore();
    }
  });

  test("pool recovery target is unavailable during release while ordinary and awaiting-owner sessions qualify", async () => {
    const { pool, device } = await poolHarness();
    const preparation = pool.prepareSessionPreservingRecovery(deviceId, device);
    expect(preparation?.sessionId).toBe(sessionId);
    pool.finishSessionPreservingRecoveryPreparation(preparation);
    const session = h.manager.getSession(sessionId)!;
    session.ownership = "awaiting-owner";
    const awaiting = pool.prepareSessionPreservingRecovery(deviceId, device);
    expect(awaiting?.sessionId).toBe(sessionId);
    pool.finishSessionPreservingRecoveryPreparation(awaiting);
    const finish = await h.beginRelease();
    const during = pool.prepareSessionPreservingRecovery(deviceId, device);
    pool.finishSessionPreservingRecoveryPreparation(during);
    await finish();
    expect(during).toBeUndefined();
    expect(pool.prepareSessionPreservingRecovery(deviceId, device)).toBeUndefined();
  });

  test("pool missing-device preservation skips release and normal eviction joins it", async () => {
    const { pool, device, port } = await poolHarness();
    const recovery = spyOn(pool, "recoverSessionBoundDeviceAfterLoss").mockResolvedValue(
      "deferred",
    );
    try {
      expect(await port.tryPreserveSessionForMissingDevice(device, true, undefined)).toBe(true);
      expect(recovery).toHaveBeenCalledTimes(1);
      h.manager.getSession(sessionId)!.ownership = "awaiting-owner";
      expect(await port.tryPreserveSessionForMissingDevice(device, true, undefined)).toBe(true);
      recovery.mockClear();
      const finish = await h.beginRelease();
      const preserved = await port.tryPreserveSessionForMissingDevice(device, true, undefined);
      const calls = recovery.mock.calls.length;
      let evicted = false;
      const eviction = port.releaseSessionForEvictedDevice(device, undefined).then((result) => {
        evicted = true;
        return result;
      });
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }
      expect(evicted).toBe(false);
      await finish();
      expect(await eviction).toBe(true);
      expect(preserved).toBe(false);
      expect(calls).toBe(0);
      expect(await port.tryPreserveSessionForMissingDevice(device, true, undefined)).toBe(false);
    } finally {
      recovery.mockRestore();
    }
  });

  for (const phase of ["A", "B"] as const) {
    test(`CLI heartbeat rejects Phase ${phase} and never reports a recorded heartbeat`, async () => {
      await h.create();
      const log = spyOn(console, "log").mockImplementation(() => {});
      const error = spyOn(console, "error").mockImplementation(() => {});
      const exit = spyOn(process, "exit").mockImplementation((): never => {
        throw new Error("CLI exit");
      });
      const options = {
        stateProvider: () => ({
          isInitialized: () => true,
          getSessionManager: () => h.manager,
          getDevicePool: (): never => {
            throw new Error("Unused pool");
          },
          getDeviceSessionRegistry: (): never => {
            throw new Error("Unused registry");
          },
        }),
      };
      try {
        await runDaemonCommand("heartbeat", [sessionId], options);
        expect(log).toHaveBeenCalledWith(`Session ${sessionId} heartbeat recorded`);
        log.mockClear();
        const finish = await h.beginRelease(phase);
        const writes = h.persistence.activityWrites;
        await expect(runDaemonCommand("heartbeat", [sessionId], options)).rejects.toThrow(
          "CLI exit",
        );
        expect(error).toHaveBeenCalledWith(`Error: Session not found: ${sessionId}`);
        expect(log).not.toHaveBeenCalled();
        expect(h.persistence.activityWrites).toBe(writes);
        await finish();
        await expect(runDaemonCommand("heartbeat", [sessionId], options)).rejects.toThrow(
          "CLI exit",
        );
        expect(error).toHaveBeenCalledTimes(2);
        expect(error).toHaveBeenLastCalledWith(`Error: Session not found: ${sessionId}`);
        expect(log).not.toHaveBeenCalled();
        expect(h.persistence.activityWrites).toBe(writes);
      } finally {
        log.mockRestore();
        error.mockRestore();
        exit.mockRestore();
      }
    });
  }

  test("rebind remains admitted by stream, transport, and informational paths", async () => {
    const session = await h.create();
    h.persistence.deferUpsert = true;
    const rebind = h.manager.rebindSession(sessionId, "emulator-5556", "android");
    await h.persistence.upsertStarted.promise;
    expect(
      isDeviceControlRoutingSessionValid(h.manager, {
        routingSessionUuid: sessionId,
        routingSessionIncarnation: session,
      }),
    ).toBe(true);
    expect(() =>
      new SessionScopedStreamAuthenticator(() => h.manager, "test op", {}).authorize({
        sessionUuid: sessionId,
      }),
    ).not.toThrow();
    expect(await h.request("daemon/activeSessions")).toEqual({
      success: true,
      result: { activeSessions: 1, activeExecutions: 0 },
    });
    expect((await h.request("daemon/sessionInfo")).result).not.toHaveProperty("releasing");
    h.persistence.finishUpsert.resolve();
    await rebind;
  });

  test("pool preservation and CLI heartbeat stay admitted during rebind", async () => {
    const { pool, device, port } = await poolHarness();
    h.persistence.deferUpsert = true;
    const rebind = h.manager.rebindSession(sessionId, deviceId, "android", { force: true });
    await h.persistence.upsertStarted.promise;
    const recovery = spyOn(pool, "recoverSessionBoundDeviceAfterLoss").mockResolvedValue(
      "deferred",
    );
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const preparation = pool.prepareSessionPreservingRecovery(deviceId, device);
      expect(preparation?.sessionId).toBe(sessionId);
      pool.finishSessionPreservingRecoveryPreparation(preparation);
      expect(await port.tryPreserveSessionForMissingDevice(device, true, undefined)).toBe(true);
      await runDaemonCommand("heartbeat", [sessionId], {
        stateProvider: () => ({
          isInitialized: () => true,
          getSessionManager: () => h.manager,
          getDevicePool: () => pool,
          getDeviceSessionRegistry: (): never => {
            throw new Error("Unused registry");
          },
        }),
      });
      expect(log).toHaveBeenCalledWith(`Session ${sessionId} heartbeat recorded`);
      h.persistence.finishUpsert.resolve();
      await rebind;
    } finally {
      recovery.mockRestore();
      log.mockRestore();
    }
  });

  test("observer registrations do not enter informational device-session counts", async () => {
    h.observers.register(sessionId, "desktop");
    expect(await h.request("daemon/activeSessions")).toEqual({
      success: true,
      result: { activeSessions: 0, activeExecutions: 0 },
    });
    expect(await h.request("daemon/sessionInfo")).toEqual(notFound);
  });
});

import type { SessionReleaseReason } from "../../src/daemon/releaseReasons";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";
import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../src/models/ActionableError";
import {
  SessionManager,
  TerminalSessionError,
  PLAN_AUTO_RELEASE_REASON,
  SessionNoLongerOwnsDeviceError,
  SessionRebindingError,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { DevicePool } from "../../src/daemon/devicePool";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import {
  DeferredDeviceSessionPersistence,
  DeferredReleaseDeviceSessionPersistence,
  installSessionManagerCleanup,
  installSessionManagerFixture,
  makeSessionManager,
  persistedRecoverySession,
} from "../helpers/sessionManagerSuite";

installSessionManagerCleanup();

describe("SessionManager", () => {
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;

  installSessionManagerFixture((fixture) => {
    sessionManager = fixture.manager;
    fakeTimer = fixture.timer;
  });

  test("terminal device-loss UUID cannot silently allocate another device", async () => {
    await sessionManager.createSession("lost-session", "emulator-5554", "android");
    const released = Promise.withResolvers<void>();
    let releaseSnapshot: unknown;
    sessionManager.onSessionRelease((_sessionId, _deviceId, _reason, { snapshot }) => {
      releaseSnapshot = snapshot;
      released.resolve();
    });
    await sessionManager.releaseSession(
      "lost-session",
      "device-disconnected:emulator-5554;incident=emulator-loss-1",
    );
    await released.promise;
    let assignmentCount = 0;
    const assigner: SessionDeviceAssigner = {
      async assignDeviceToSession() {
        assignmentCount += 1;
        return "emulator-5560";
      },
    };

    await expect(
      sessionManager.getOrCreateSession("lost-session", assigner, "android"),
    ).rejects.toThrow("terminal");
    expect(assignmentCount).toBe(0);
    expect(releaseSnapshot).toMatchObject({
      sessionId: "lost-session",
      deviceId: "emulator-5554",
      releaseReason: "device-disconnected:emulator-5554;incident=emulator-loss-1",
      terminal: true,
    });
  });

  test("device-killed UUID cannot silently allocate another device", async () => {
    const session = await sessionManager.createSession(
      "killed-session",
      "emulator-5554",
      "android",
    );
    const setup = Promise.withResolvers<void>();
    void sessionManager.trackSessionSetup(session, () => setup.promise);
    const ordinaryRelease = sessionManager.releaseSession("killed-session", "explicit-release");
    const killedRelease = sessionManager.releaseSession("killed-session", "device-killed");
    setup.resolve();
    await Promise.all([ordinaryRelease, killedRelease]);
    let assignmentCount = 0;
    const assigner: SessionDeviceAssigner = {
      async assignDeviceToSession() {
        assignmentCount += 1;
        return "emulator-5560";
      },
    };

    await expect(
      sessionManager.getOrCreateSession("killed-session", assigner, "android"),
    ).rejects.toThrow("terminal after device-killed");
    expect(assignmentCount).toBe(0);
    expect(sessionManager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
      sessionId: "killed-session",
      deviceId: "emulator-5554",
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("device-killed upgrade during release persistence remains terminal", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    await manager.createSession("killed-session", "emulator-5554", "android");
    let callbackSnapshot: unknown;
    manager.onSessionRelease((_sessionId, _deviceId, _reason, { snapshot }) => {
      callbackSnapshot = snapshot;
    });
    const ordinaryRelease = manager.releaseSession("killed-session", "explicit-release");
    await persistence.releaseStarted.promise;
    const killedRelease = manager.releaseSession("killed-session", "device-killed");
    persistence.finishRelease.resolve();
    await Promise.all([ordinaryRelease, killedRelease]);
    let assignmentCount = 0;
    const assigner: SessionDeviceAssigner = {
      async assignDeviceToSession() {
        assignmentCount += 1;
        return "emulator-5560";
      },
    };

    await expect(manager.getOrCreateSession("killed-session", assigner, "android")).rejects.toThrow(
      "terminal after device-killed",
    );
    expect(assignmentCount).toBe(0);
    expect(persistence.reasons).toEqual(["explicit-release", "device-killed"]);
    expect(callbackSnapshot).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("device-killed supersedes a terminal release during persistence", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const session = await manager.createSession("killed-session", "emulator-5554", "android");
    const callbacks: string[] = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => callbacks.push(reason));

    const timeoutRelease = manager.releaseSession("killed-session", "heartbeat-timeout");
    await persistence.releaseStarted.promise;
    const killedRelease = manager.releaseSession("killed-session", "device-killed", {
      expectedOwner: { session: session, deviceId: "emulator-5554" },
    });
    persistence.finishRelease.resolve();
    await Promise.all([timeoutRelease, killedRelease]);

    expect(persistence.reasons).toEqual(["heartbeat-timeout", "device-killed"]);
    expect(callbacks).toEqual(["device-killed"]);
    expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("device-killed supersedes a finalized terminal release", async () => {
    const reasons: string[] = [];
    const persistence = new FakeDeviceSessionPersistence();
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, { reason }) => {
      reasons.push(reason);
    };
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const session = await manager.createSession("killed-session", "emulator-5554", "android");
    const callbacks: string[] = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => callbacks.push(reason));

    await manager.releaseSession("killed-session", "heartbeat-timeout");
    await manager.releaseSession("killed-session", "device-killed", {
      expectedOwner: { session: session, deviceId: "emulator-5554" },
    });

    expect(reasons).toEqual(["heartbeat-timeout", "device-killed"]);
    expect(callbacks).toEqual(["heartbeat-timeout", "device-killed"]);
    expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("device-killed remains terminal when persistence retries through ordinary release", async () => {
    const reasons: string[] = [];
    let failRelease = true;
    const persistence = new FakeDeviceSessionPersistence();
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, { reason }) => {
      reasons.push(reason);
      if (failRelease) {
        failRelease = false;
        throw new Error("terminal write failed");
      }
    };
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    await manager.createSession("killed-session", "emulator-5554", "android");
    const callbacks: string[] = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => callbacks.push(reason));

    await expect(manager.releaseSession("killed-session", "device-killed")).rejects.toThrow(
      "Failed to persist terminal release",
    );
    await manager.releaseSession("killed-session", "explicit-release");

    expect(reasons).toEqual(["device-killed", "device-killed"]);
    expect(callbacks).toEqual(["device-killed"]);
    expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
    await expect(
      manager.getOrCreateSession("killed-session", {
        async assignDeviceToSession() {
          return "emulator-5560";
        },
      }),
    ).rejects.toThrow("terminal after device-killed");
  });

  test("retries a failed device-killed upgrade during release persistence", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    let failTerminalRelease = true;
    const markReleased = persistence.markReleased.bind(persistence);
    persistence.markReleased = async (sessionUuid, status, releasedAtMs, { reason }) => {
      await markReleased(sessionUuid, status, releasedAtMs, { reason });
      if (reason === "device-killed" && failTerminalRelease) {
        failTerminalRelease = false;
        throw new Error("terminal write failed");
      }
    };
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const session = await manager.createSession("killed-session", "emulator-5554", "android");
    const callbacks: string[] = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => callbacks.push(reason));
    const ordinaryRelease = manager.releaseSession("killed-session", PLAN_AUTO_RELEASE_REASON);
    await persistence.releaseStarted.promise;
    const killedRelease = manager.releaseSession("killed-session", "device-killed", {
      expectedOwner: { session: session, deviceId: "emulator-5554" },
    });
    persistence.finishRelease.resolve();

    await expect(Promise.all([ordinaryRelease, killedRelease])).rejects.toThrow(
      "Failed to persist terminal release",
    );
    await expect(manager.releaseSession("killed-session", "device-killed")).resolves.toBe(
      "emulator-5554",
    );
    await expect(manager.releaseSession("killed-session", "device-killed")).resolves.toBe(
      "emulator-5554",
    );
    await expect(
      manager.releaseSession("killed-session", "device-killed", {
        expectedOwner: { session: session, deviceId: "emulator-5554" },
      }),
    ).resolves.toBe("emulator-5554");

    expect(persistence.reasons).toEqual([
      PLAN_AUTO_RELEASE_REASON,
      "device-killed",
      "device-killed",
    ]);
    expect(callbacks).toEqual([PLAN_AUTO_RELEASE_REASON, "device-killed"]);
    expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("device-killed upgrade after release finalization remains terminal", async () => {
    const reasons: string[] = [];
    const terminalPersistenceStarted = Promise.withResolvers<void>();
    const finishTerminalPersistence = Promise.withResolvers<void>();
    const persistence = new FakeDeviceSessionPersistence();
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, { reason }) => {
      reasons.push(reason);
      if (reason === "device-killed") {
        terminalPersistenceStarted.resolve();
        await finishTerminalPersistence.promise;
      }
    };
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    await manager.createSession("killed-session", "emulator-5554", "android");
    let killedRelease: Promise<string | null> | undefined;
    const callbacks: string[] = [];
    manager.onSessionRelease((_sessionId, _deviceId, reason) => {
      callbacks.push(reason);
      if (reason === "explicit-release") {
        // Let the ordinary persistence continuation finalize its snapshot,
        // then escalate before releaseSession's outer finally removes the
        // operation. This discriminates the late-finalized branch from the
        // earlier mutable-reason upgrade path.
        void Promise.resolve()
          .then(() => undefined)
          .then(() => undefined)
          .then(() => {
            killedRelease = manager.releaseSession("killed-session", "device-killed");
          });
      }
    });

    const ordinaryRelease = manager.releaseSession("killed-session", "explicit-release");
    await terminalPersistenceStarted.promise;
    const ordinaryOutcome = await Promise.race([
      ordinaryRelease.then(() => "released" as const),
      new Promise<"blocked">((resolve) => setImmediate(() => resolve("blocked"))),
    ]);
    finishTerminalPersistence.resolve();
    await killedRelease;

    expect(ordinaryOutcome).toBe("released");
    expect(reasons).toEqual(["explicit-release", "device-killed"]);
    expect(callbacks).toEqual(["explicit-release", "device-killed"]);
    expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("owned device-loss upgrade after release finalization remains terminal", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const session = await manager.createSession("disconnected-session", "emulator-5554", "android");
    let disconnectedRelease: Promise<string | null> | undefined;
    manager.onSessionRelease((_sessionId, _deviceId, reason) => {
      if (reason === PLAN_AUTO_RELEASE_REASON) {
        disconnectedRelease = manager.releaseSession(
          "disconnected-session",
          "device-disconnected:emulator-5554",
          { expectedOwner: { session: session, deviceId: "emulator-5554" } },
        );
      }
    });

    await manager.releaseSession("disconnected-session", PLAN_AUTO_RELEASE_REASON);
    await disconnectedRelease;

    expect(manager.getTerminalReleaseSnapshot("disconnected-session")).toMatchObject({
      releaseReason: "device-disconnected:emulator-5554",
      terminal: true,
    });
  });

  test("owned device-loss upgrade after an ordinary release remains terminal", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const session = await manager.createSession("disconnected-session", "emulator-5554", "android");

    await manager.releaseSession("disconnected-session", PLAN_AUTO_RELEASE_REASON);
    await manager.releaseSession("disconnected-session", "device-disconnected:emulator-5554", {
      expectedOwner: { session: session, deviceId: "emulator-5554" },
    });

    expect(manager.getTerminalReleaseSnapshot("disconnected-session")).toMatchObject({
      releaseReason: "device-disconnected:emulator-5554",
      terminal: true,
    });
  });

  test("retries a failed owned terminal upgrade after an ordinary release", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const reasons: string[] = [];
    let failTerminalRelease = true;
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, { reason }) => {
      reasons.push(reason);
      if (reason === "device-killed" && failTerminalRelease) {
        failTerminalRelease = false;
        throw new Error("terminal write failed");
      }
    };
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const session = await manager.createSession("killed-session", "emulator-5554", "android");
    await manager.releaseSession("killed-session", "explicit-release");

    await expect(
      manager.releaseSession("killed-session", "device-killed", {
        expectedOwner: { session: session, deviceId: "emulator-5554" },
      }),
    ).rejects.toThrow("Failed to persist terminal release");
    await expect(
      manager.releaseSession("killed-session", "device-killed", {
        expectedOwner: { session: session, deviceId: "emulator-5554" },
      }),
    ).resolves.toBe("emulator-5554");

    expect(reasons).toEqual(["explicit-release", "device-killed", "device-killed"]);
    expect(manager.getTerminalReleaseSnapshot("killed-session")).toMatchObject({
      releaseReason: "device-killed",
      terminal: true,
    });
  });

  test("stale owned retry cannot replace a newer incarnation terminal release", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const reasons: string[] = [];
    persistence.markReleased = async (_sessionUuid, _status, _releasedAtMs, { reason }) => {
      reasons.push(reason);
    };
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const oldSession = await manager.createSession("reused-session", "old-device", "android");
    await manager.releaseSession("reused-session", PLAN_AUTO_RELEASE_REASON);
    await manager.createSession("reused-session", "new-device", "android");
    await manager.releaseSession(
      "reused-session",
      "device-disconnected:new-device;incident=new-loss",
    );

    await expect(
      manager.releaseSession("reused-session", "device-killed", {
        expectedOwner: { session: oldSession, deviceId: "old-device" },
      }),
    ).resolves.toBeNull();

    expect(reasons).toEqual([
      PLAN_AUTO_RELEASE_REASON,
      "device-disconnected:new-device;incident=new-loss",
    ]);
    expect(manager.getTerminalReleaseSnapshot("reused-session")).toMatchObject({
      deviceId: "new-device",
      releaseReason: "device-disconnected:new-device;incident=new-loss",
    });
  });

  test("stale owned retry cannot bypass a newer incarnation release in flight", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const newerReleaseStarted = Promise.withResolvers<void>();
    const finishNewerRelease = Promise.withResolvers<void>();
    let releaseCount = 0;
    persistence.markReleased = async () => {
      releaseCount += 1;
      if (releaseCount === 2) {
        newerReleaseStarted.resolve();
        await finishNewerRelease.promise;
      }
    };
    const manager = makeSessionManager({ timer: fakeTimer, persistence });
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      await manager.releaseSession("reused-session", PLAN_AUTO_RELEASE_REASON);
      await manager.createSession("reused-session", "new-device", "android");
      const newerRelease = manager.releaseSession("reused-session", PLAN_AUTO_RELEASE_REASON);
      await newerReleaseStarted.promise;

      await expect(
        manager.releaseSession("reused-session", "device-killed", {
          expectedOwner: { session: oldSession, deviceId: "old-device" },
        }),
      ).resolves.toBeNull();
      finishNewerRelease.resolve();
      await newerRelease;

      expect(releaseCount).toBe(2);
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toBeUndefined();
    } finally {
      finishNewerRelease.resolve();
      manager.stopCleanupTimer();
    }
  });

  test("stale owned retry cannot replace a newer finalized ordinary release", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      const oldRelease = manager.releaseSession("reused-session", PLAN_AUTO_RELEASE_REASON);
      await persistence.releaseStarted.promise;
      const newerCreation = manager.createSession("reused-session", "new-device", "android");
      persistence.finishRelease.resolve();
      await oldRelease;
      await expect(newerCreation).resolves.toMatchObject({ assignedDevice: "new-device" });
      await manager.releaseSession("reused-session", PLAN_AUTO_RELEASE_REASON);

      await expect(
        manager.releaseSession("reused-session", "device-killed", {
          expectedOwner: { session: oldSession, deviceId: "old-device" },
        }),
      ).resolves.toBeNull();

      expect(persistence.reasons).toEqual([PLAN_AUTO_RELEASE_REASON, PLAN_AUTO_RELEASE_REASON]);
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toBeUndefined();
    } finally {
      persistence.finishRelease.resolve();
      manager.stopCleanupTimer();
    }
  });

  test("terminal upgrade blocks replacement publication until its fence is durable", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });
    try {
      await manager.createSession("reused-session", "old-device", "android");
      const ordinaryRelease = manager.releaseSession("reused-session", PLAN_AUTO_RELEASE_REASON);
      await persistence.releaseStarted.promise;
      const terminalRelease = manager.releaseSession("reused-session", "device-killed");
      const newerCreation = manager.createSession("reused-session", "new-device", "android");
      persistence.finishRelease.resolve();

      await Promise.all([ordinaryRelease, terminalRelease]);
      await expect(newerCreation).rejects.toThrow("terminal after device-killed");

      expect(persistence.reasons).toEqual([PLAN_AUTO_RELEASE_REASON, "device-killed"]);
      expect(manager.getSession("reused-session")).toBeNull();
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toMatchObject({
        deviceId: "old-device",
        releaseReason: "device-killed",
      });
    } finally {
      persistence.finishRelease.resolve();
      manager.stopCleanupTimer();
    }
  });

  test("stale owned retry cannot fence a newer incarnation pending creation", async () => {
    const persistence = new DeferredDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      await manager.releaseSession("reused-session", PLAN_AUTO_RELEASE_REASON);
      persistence.deferNextUpsert();
      const newerCreation = manager.createSession("reused-session", "new-device", "android");
      await persistence.waitForUpsert();

      await expect(
        manager.releaseSession("reused-session", "device-killed", {
          expectedOwner: { session: oldSession, deviceId: "old-device" },
        }),
      ).resolves.toBeNull();
      persistence.finishUpsert();
      await expect(newerCreation).resolves.toMatchObject({ assignedDevice: "new-device" });

      expect(manager.getSession("reused-session")).toMatchObject({ assignedDevice: "new-device" });
      expect(manager.getTerminalReleaseSnapshot("reused-session")).toBeUndefined();
    } finally {
      persistence.finishUpsert();
      manager.stopCleanupTimer();
    }
  });

  test("stale owned retry cannot fence a newer incarnation pending assignment", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });
    const assignmentStarted = Promise.withResolvers<void>();
    const finishAssignment = Promise.withResolvers<void>();
    try {
      const oldSession = await manager.createSession("reused-session", "old-device", "android");
      await manager.releaseSession("reused-session", PLAN_AUTO_RELEASE_REASON);
      const assigner: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId, platform) {
          assignmentStarted.resolve();
          await finishAssignment.promise;
          await manager.createSession(sessionId, "new-device", platform ?? "android");
          return "new-device";
        },
      };
      const newerAssignment = manager.getOrCreateSession("reused-session", assigner, "android");
      await assignmentStarted.promise;

      await expect(
        manager.releaseSession("reused-session", "device-killed", {
          expectedOwner: { session: oldSession, deviceId: "old-device" },
        }),
      ).resolves.toBeNull();
      finishAssignment.resolve();
      await expect(newerAssignment).resolves.toMatchObject({ assignedDevice: "new-device" });

      expect(manager.getTerminalReleaseSnapshot("reused-session")).toBeUndefined();
    } finally {
      finishAssignment.resolve();
      manager.stopCleanupTimer();
    }
  });

  test("terminal release reservation blocks UUID reuse until shutdown settles", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const session = await manager.createSession("reserved-session", "emulator-5554", "android");
    const releaseReservation = manager.reserveSessionForTerminalRelease(session, "emulator-5554");
    await expect(
      manager.rebindSession("reserved-session", "emulator-5560", "android"),
    ).rejects.toThrow("being terminally released");
    await manager.releaseSession("reserved-session", PLAN_AUTO_RELEASE_REASON);

    await expect(
      manager.createSession("reserved-session", "emulator-5560", "android"),
    ).rejects.toThrow("being terminally released");

    releaseReservation();
    await expect(
      manager.createSession("reserved-session", "emulator-5560", "android"),
    ).resolves.toMatchObject({ assignedDevice: "emulator-5560" });
  });

  test("terminal release reservation rejects while an ordinary rebind is in flight", async () => {
    const persistence = new DeferredDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    const session = await manager.createSession("reserved-session", "emulator-5554", "android");

    persistence.deferNextUpsert();
    const rebind = manager.rebindSession("reserved-session", "emulator-5560", "android");
    await persistence.waitForUpsert();
    let refusal: unknown;
    try {
      manager.reserveSessionForTerminalRelease(session, "emulator-5554");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SessionRebindingError);
    expect(refusal).toBeInstanceOf(ActionableError);
    expect(refusal).toMatchObject({
      code: SESSION_REBINDING_CODE,
      sessionUuid: "reserved-session",
    });
    expect((refusal as Error).message).toContain("rebinding devices");
    persistence.finishUpsert();

    await expect(rebind).resolves.toBe(session);
    expect(session.assignedDevice).toBe("emulator-5560");
    expect(persistence.upsertedDeviceIds).toEqual(["emulator-5554", "emulator-5560"]);
  });

  test("terminal release reservation for a device the session left is a typed refusal", async () => {
    const manager = makeSessionManager({ timer: fakeTimer });

    const session = await manager.createSession("moved-session", "emulator-5554", "android");
    let refusal: unknown;
    try {
      manager.reserveSessionForTerminalRelease(session, "emulator-5560");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SessionNoLongerOwnsDeviceError);
    expect(refusal).toBeInstanceOf(ActionableError);
    expect(refusal).toMatchObject({
      code: SESSION_NO_LONGER_OWNS_DEVICE_CODE,
      sessionUuid: "moved-session",
      deviceId: "emulator-5560",
    });
  });

  test("terminal release fails closed when durable fencing cannot be persisted", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = makeSessionManager({ timer: fakeTimer, persistence });

    await manager.createSession("lost-session", "emulator-5554", "android");
    persistence.failure = "release";

    await expect(
      manager.releaseSession(
        "lost-session",
        "device-disconnected:emulator-5554;incident=emulator-loss-1",
      ),
    ).rejects.toThrow("Failed to persist terminal release");
    expect(manager.getSession("lost-session")).toBeNull();
    expect(manager.getSessionForDevice("emulator-5554")).toBe("lost-session");
    expect(manager.getTerminalReleaseSnapshot("lost-session")).toMatchObject({
      deviceId: "emulator-5554",
      releaseReason: "device-disconnected:emulator-5554;incident=emulator-loss-1",
      terminal: true,
    });
    await expect(manager.getOrCreateSession("lost-session")).rejects.toThrow(
      "device-disconnected:emulator-5554",
    );

    persistence.failure = null;
    await expect(
      manager.releaseSession(
        "lost-session",
        "device-disconnected:emulator-5554;incident=emulator-loss-1",
      ),
    ).resolves.toBe("emulator-5554");
    expect(manager.getSession("lost-session")).toBeNull();
  });
});

describe("explicit-release regression", () => {
  test("refuses reuse before assignment and allows a fresh UUID on the idle device", async () => {
    const timer = new FakeTimer();
    const manager = makeSessionManager({ timer });
    const device = { name: "handset", deviceId: "handset", platform: "android" as const };
    const deviceManager = new FakeDeviceManager();
    deviceManager.bootedDevices = [device];
    const pool = new DevicePool(
      createDevicePoolDependencies(manager, "test-daemon", {
        timer,
        deviceManager,
        installedAppsRepository: new FakeInstalledAppsRepository(),
      }),
    );
    let assignments = 0;
    const assigner: SessionDeviceAssigner = {
      async assignDeviceToSession(sessionId, platform, target) {
        assignments++;
        return pool.assignDeviceToSession(sessionId, platform, target);
      },
    };

    await pool.initializeWithDevices([device]);
    await pool.assignDeviceToSession("released-uuid", "android");
    await manager.releaseSession("released-uuid");
    await pool.releaseDevice("handset", "released-uuid");
    const message =
      "Session released-uuid was released and cannot be reused. " +
      "Acquire a new device with getAndroid or getApple.";
    await expect(manager.admitIssuedSessionForAutomation("released-uuid")).rejects.toThrow(message);
    await expect(
      manager.getOrCreateSession("released-uuid", assigner, "android", {
        requireIssuedSession: true,
      }),
    ).rejects.toThrow(TerminalSessionError);
    await expect(manager.createSession("released-uuid", "handset", "android")).rejects.toThrow(
      message,
    );
    expect(manager.getTerminalReleaseSnapshot("released-uuid")).toMatchObject({
      releaseReason: "explicit-release",
      terminal: true,
    });
    expect(assignments).toBe(0);
    expect(pool.getDevice("handset")).toMatchObject({ status: "idle", sessionId: null });
    await expect(pool.assignDeviceToSession("fresh-uuid", "android")).resolves.toBe("handset");
    expect(manager.getSession("fresh-uuid")).toMatchObject({ assignedDevice: "handset" });
  });

  test("persists the tombstone across manager restart and skips startup rehydration", async () => {
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    const manager = makeSessionManager({ timer, persistence });
    const restarted = makeSessionManager({ timer, persistence });
    let assignments = 0;
    const assigner: SessionDeviceAssigner = {
      async assignDeviceToSession() {
        assignments++;
        return "handset";
      },
    };
    try {
      await manager.createSession("released-uuid", "handset", "android");
      await manager.releaseSession("released-uuid");
      expect(await persistence.getSession("released-uuid")).toMatchObject({
        status: "released",
        release_reason: "explicit-release",
        released_at_ms: timer.now(),
      });
      await expect(restarted.admitIssuedSessionForAutomation("released-uuid")).rejects.toThrow(
        TerminalSessionError,
      );
      expect(restarted.getTerminalReleaseSnapshot("released-uuid")).toMatchObject({
        releaseReason: "explicit-release",
        terminal: true,
      });
      // Even a broad persistence listing must not rehydrate this row.
      const row = await persistence.getSession("released-uuid");
      if (!row) {
        throw new Error("Expected persisted release");
      }
      persistence.listRecoverableSessions = async () => [row];
      await expect(restarted.rehydratePersistedSessions(assigner)).resolves.toEqual({
        rehydrated: [],
        terminalized: [],
        skipped: [{ sessionUuid: "released-uuid", reason: "not-recoverable" }],
        timedOut: false,
      });
      await expect(restarted.admitIssuedSessionForAutomation("released-uuid")).rejects.toThrow(
        TerminalSessionError,
      );
      await expect(
        restarted.getOrCreateSession("released-uuid", assigner, "android", {
          requireIssuedSession: true,
        }),
      ).rejects.toThrow("was released");
      expect(assignments).toBe(0);
    } finally {
      manager.stopCleanupTimer();
      restarted.stopCleanupTimer();
    }
  });

  test("exports a distinct reusable plan auto-release reason", async () => {
    const reason = PLAN_AUTO_RELEASE_REASON;
    expect(reason).toBe("plan-auto-release");
    const persistence = new FakeDeviceSessionPersistence();
    const timer = new FakeTimer();
    const manager = makeSessionManager({ timer, persistence });
    const restarted = makeSessionManager({ timer, persistence });
    try {
      await manager.createSession("plan-uuid", "handset", "android");
      await manager.releaseSession("plan-uuid", reason);
      expect(manager.getTerminalReleaseSnapshot("plan-uuid")).toBeUndefined();
      expect(restarted.getTerminalReleaseSnapshot("plan-uuid")).toBeUndefined();
      const assigner: SessionDeviceAssigner = {
        async assignDeviceToSession(sessionId, platform) {
          await restarted.createSession(sessionId, "handset", platform ?? "android");
          return "handset";
        },
      };
      await restarted.admitIssuedSessionForAutomation("plan-uuid");
      await expect(
        restarted.getOrCreateSession("plan-uuid", assigner, "android", {
          requireIssuedSession: true,
        }),
      ).resolves.toMatchObject({ assignedDevice: "handset" });
      await expect(manager.createSession("plan-uuid", "handset", "android")).resolves.toMatchObject(
        { assignedDevice: "handset" },
      );
      const terminalReasons: SessionReleaseReason[] = [
        "heartbeat-timeout",
        "cli-idle-timeout",
        "device-killed",
      ];
      for (const releaseReason of terminalReasons) {
        const sessionUuid = `terminal-${releaseReason}`;
        await manager.createSession(sessionUuid, "other-handset", "android");
        await manager.releaseSession(sessionUuid, releaseReason);
        await expect(manager.admitIssuedSessionForAutomation(sessionUuid)).rejects.toThrow(
          `Session ${sessionUuid} is terminal after ${releaseReason} and cannot be reused. ` +
            "Acquire a new device with getAndroid or getApple.",
        );
      }
      const recoverableReasons: SessionReleaseReason[] = [
        "daemon-shutdown",
        "daemon-restart",
        "device-restart:handset",
      ];
      for (const releaseReason of recoverableReasons) {
        const sessionUuid = `recoverable-${releaseReason}`;
        await manager.createSession(sessionUuid, "other-handset", "android");
        await manager.releaseSession(sessionUuid, releaseReason);
        expect(manager.getTerminalReleaseSnapshot(sessionUuid)).toBeUndefined();
        await expect(
          manager.createSession(sessionUuid, "other-handset", "android"),
        ).resolves.toMatchObject({ assignedDevice: "other-handset" });
        await manager.releaseSession(sessionUuid, PLAN_AUTO_RELEASE_REASON);
      }
    } finally {
      manager.stopCleanupTimer();
      restarted.stopCleanupTimer();
    }
  });

  test("keeps an in-flight explicit release terminal when shutdown joins it", async () => {
    const persistence = new DeferredReleaseDeviceSessionPersistence();
    const manager = makeSessionManager({ persistence });
    try {
      await manager.createSession("released-uuid", "handset", "android");
      const release = manager.releaseSession("released-uuid");
      await persistence.releaseStarted.promise;
      const shutdown = manager.releaseSession("released-uuid", "daemon-shutdown");
      persistence.finishRelease.resolve();
      await Promise.all([release, shutdown]);
      expect(persistence.reasons).toEqual(["explicit-release"]);
      expect(manager.getTerminalReleaseSnapshot("released-uuid")).toMatchObject({
        releaseReason: "explicit-release",
        terminal: true,
      });
    } finally {
      persistence.finishRelease.resolve();
      manager.stopCleanupTimer();
    }
  });
});

describe("terminal release of persisted restart recovery", () => {
  test.each([
    "explicit-release",
    "superseded",
    "heartbeat-timeout",
    "device-killed",
    "missing-first-heartbeat",
    "cli-idle-timeout",
    "rehydration-owner-timeout",
    "session-creation-cancelled",
    "identity-recovery-unavailable",
    "device-disconnected:Pixel",
  ])("%s revokes recovery across manager restart", async (reason) => {
    const timer = new FakeTimer();
    const persistence = new FakeDeviceSessionPersistence();
    persistence.seed(persistedRecoverySession({ release_reason: "device-restart:Pixel" }));
    const manager = makeSessionManager({ timer, persistence });
    const restarted = makeSessionManager({ timer, persistence });
    manager.stopCleanupTimer();
    restarted.stopCleanupTimer();
    expect(await manager.isReleasedSessionInRestartRecoveryWindow("persisted-session")).toBe(true);
    const releaseReason = reason === "superseded" ? "identity-recovery-superseded" : reason;
    expect(await manager.releaseSession("persisted-session", reason)).toBe("emulator-5554");
    expect(await persistence.getSession("persisted-session")).toMatchObject({
      release_reason: releaseReason,
    });
    expect(await manager.isReleasedSessionInRestartRecoveryWindow("persisted-session")).toBe(false);
    expect(await restarted.isReleasedSessionInRestartRecoveryWindow("persisted-session")).toBe(
      false,
    );
    for (const owner of [manager, restarted]) {
      await expect(owner.admitIssuedSessionForAutomation("persisted-session")).rejects.toThrow(
        TerminalSessionError,
      );
      await expect(
        owner.getOrCreateSession("persisted-session", undefined, undefined, {
          requireIssuedSession: true,
        }),
      ).rejects.toThrow(TerminalSessionError);
    }
  });

  // #11461: an explicit release is terminal and never rehydrated, so it ends a restart handoff
  // this daemon has not recovered yet; no other reason reaches a row the daemon does not hold.
  test("an explicit release terminalizes an unrecovered daemon-restart row", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    persistence.seed(persistedRecoverySession({ release_reason: "daemon-restart" }));
    const manager = makeSessionManager({ persistence });
    manager.stopCleanupTimer();

    expect(await manager.releaseSession("persisted-session", "explicit-release")).toBe(
      "emulator-5554",
    );

    expect(await persistence.getSession("persisted-session")).toMatchObject({
      release_reason: "explicit-release",
    });
    await expect(
      manager.getOrCreateSession("persisted-session", undefined, undefined, {
        requireIssuedSession: true,
      }),
    ).rejects.toThrow(TerminalSessionError);
  });

  test("a heartbeat-timeout release leaves an unrecovered daemon-restart row unchanged", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    persistence.seed(persistedRecoverySession({ release_reason: "daemon-restart" }));
    const manager = makeSessionManager({ persistence });
    manager.stopCleanupTimer();
    const before = { ...(await persistence.getSession("persisted-session")) };

    expect(await manager.releaseSession("persisted-session", "heartbeat-timeout")).toBeNull();

    expect({ ...(await persistence.getSession("persisted-session")) }).toEqual(before);
    expect(manager.getTerminalReleaseSnapshot("persisted-session")).toBeUndefined();
  });

  test.each(["missing", "expired-window"])(
    "terminal release leaves %s outside restart recovery unchanged",
    async (state) => {
      const timer = new FakeTimer();
      const persistence = new FakeDeviceSessionPersistence();
      if (state !== "missing") {
        persistence.seed(
          persistedRecoverySession({
            release_reason: "device-restart:Pixel",
          }),
        );
      }
      const manager = makeSessionManager({ timer, persistence });
      manager.stopCleanupTimer();
      if (state === "expired-window") {
        timer.advanceTime(180_000);
      }
      const before = { ...(await persistence.getSession("persisted-session")) };
      expect(await manager.releaseSession("persisted-session", "explicit-release")).toBeNull();
      expect({ ...(await persistence.getSession("persisted-session")) }).toEqual(before);
      expect(manager.getTerminalReleaseSnapshot("persisted-session")).toBeUndefined();
    },
  );

  test("failed terminal persistence fences recovery until its retry commits", async () => {
    const persistence = new FakeDeviceSessionPersistence();
    persistence.seed(persistedRecoverySession({ release_reason: "device-restart:Pixel" }));
    const manager = makeSessionManager({ persistence });
    manager.stopCleanupTimer();
    persistence.failure = "release";
    await expect(manager.releaseSession("persisted-session", "explicit-release")).rejects.toThrow(
      "Failed to persist terminal release",
    );
    expect(await manager.isReleasedSessionInRestartRecoveryWindow("persisted-session")).toBe(false);
    await expect(manager.admitIssuedSessionForAutomation("persisted-session")).rejects.toThrow(
      TerminalSessionError,
    );
    persistence.failure = null;
    await manager.releaseSession("persisted-session", "explicit-release");
    expect(await persistence.getSession("persisted-session")).toMatchObject({
      release_reason: "explicit-release",
    });
  });
});

test.each(["explicit-release", "heartbeat-timeout", "device-killed"])(
  "owned finalized restart release already supports terminal %s",
  async (reason) => {
    const persistence = new FakeDeviceSessionPersistence();
    const manager = makeSessionManager({ persistence });
    manager.stopCleanupTimer();
    const session = await manager.createSession("owned", "emulator-5554", "android", {
      stableDeviceId: "Pixel",
    });
    await manager.releaseSession("owned", "device-restart:Pixel");
    expect(
      await manager.releaseSession("owned", reason, {
        expectedOwner: { session: session, deviceId: "emulator-5554" },
      }),
    ).toBe("emulator-5554");
    expect(await manager.isReleasedSessionInRestartRecoveryWindow("owned")).toBe(false);
    expect(await persistence.getSession("owned")).toMatchObject({ release_reason: reason });
    await expect(manager.admitIssuedSessionForAutomation("owned")).rejects.toThrow(
      TerminalSessionError,
    );
  },
);

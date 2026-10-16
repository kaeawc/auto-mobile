import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DAEMON_REGISTER_SESSION_METHOD } from "../../src/daemon/constants";
import {
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import {
  SessionManager,
  TerminalSessionError,
  UnissuedSessionError,
  type SessionDeviceAssigner,
} from "../../src/daemon/sessionManager";
import { DAEMON_SESSION_NOT_FOUND_CODE, type DaemonRequest } from "../../src/daemon/types";
import { SESSION_OWNERSHIP_LOST_CODE } from "../../src/daemon/sessionReleasedDuringCall";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// #12043: the latest incarnation was released before handout, so its stored deadline is not idle.
const SESSION = "00000000-0000-4000-8000-0000000000b2";
const DEVICE = "emulator-5554";
const CREATED_AT = 1_000;
const IDLE_MS = 120_000;
const DEADLINE = CREATED_AT + IDLE_MS;
const REASONS = [
  "allocation-rollback",
  "session-creation-timeout",
  `device-disconnected-during-session-create:${DEVICE}`,
] as const;

describe("rows released before their latest incarnation was handed out", () => {
  let timer: FakeTimer;
  let repo: FakeDeviceSessionPersistence;
  let registry: ObserverSessionRegistry;
  let manager: SessionManager;
  let state: DaemonStateAccess;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(CREATED_AT);
    // The fake uses the repository's expiry helper and mirrors its conditional row writes.
    repo = new FakeDeviceSessionPersistence();
    registry = new ObserverSessionRegistry(timer, 10_000);
    manager = new SessionManager(timer, repo, { barrier: () => new FakeDbWriteBarrier() });
    manager.stopCleanupTimer();
    manager.attachDaemonSessionId("daemon-a");
    manager.attachLiveDaemonSessionIds(() => new Set(["daemon-a"]));
    manager.setObserverSessionRegistry(registry);
    state = {
      isInitialized: () => true,
      getSessionManager: () => manager,
      getObserverSessionRegistry: () => registry,
      getDeviceSessionRegistry: () => ({ list: () => [] }),
      getDevicePool: () => {
        throw new Error("These requests must not consult the pool");
      },
    };
  });

  afterEach(() => {
    registry.dispose();
    timer.reset();
  });

  async function seedRow(reason: string): Promise<void> {
    await repo.upsertActiveSession({
      sessionUuid: SESSION,
      deviceId: DEVICE,
      stableDeviceId: "Pixel_8_API_35",
      platform: "android",
      daemonSessionId: "daemon-a",
      createdAtMs: CREATED_AT,
      lastUsedAtMs: CREATED_AT,
      expiresAtMs: DEADLINE,
      sessionTimeoutMs: IDLE_MS,
      heartbeatTimeoutMs: 4_000,
      hasReceivedHeartbeat: false,
    });
    await repo.markReleased(SESSION, "released", CREATED_AT + 500, reason);
  }

  const wire = (method: string) =>
    handleDaemonRequest(
      {
        id: "test",
        type: "daemon_request",
        method,
        params: { sessionId: SESSION, clientName: "desktop" },
      } satisfies DaemonRequest,
      state,
    );

  async function expectNamedNotFound(reason: string): Promise<void> {
    for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
      expect(await wire(method)).toEqual({
        success: false,
        code: DAEMON_SESSION_NOT_FOUND_CODE,
        error: `Session not found: ${SESSION}`,
        releaseReason: reason,
      });
    }
  }

  const controlError = () =>
    manager.admitIssuedSessionForAutomation(SESSION).then(
      () => {
        throw new Error("A released incarnation must not be admitted");
      },
      (error: unknown) => error,
    );

  const pool: SessionDeviceAssigner = {
    assignDeviceToSession: async () => {
      throw new Error("A released row must not allocate a device");
    },
  };

  for (const reason of REASONS) {
    test(`${reason}: heartbeat and session-info keep the reason on both sides of the deadline`, async () => {
      await seedRow(reason);
      timer.setCurrentTime(DEADLINE - 1);
      await expectNamedNotFound(reason);
      timer.setCurrentTime(DEADLINE + 1);
      await expectNamedNotFound(reason);
    });

    test(`${reason}: control keeps the untyped not-found and never rewrites the row`, async () => {
      await seedRow(reason);
      timer.setCurrentTime(DEADLINE - 1);
      const inside = await controlError();
      expect(inside).toBeInstanceOf(UnissuedSessionError);
      expect(inside).not.toHaveProperty("release");
      timer.setCurrentTime(DEADLINE + 1);
      const after = await controlError();
      expect(after).toBeInstanceOf(UnissuedSessionError);
      expect(after).toEqual(inside);
      expect(after).not.toHaveProperty("release");
      expect(after).not.toHaveProperty("idle");
      expect(await repo.getSession!(SESSION)).toMatchObject({
        status: "released",
        release_reason: reason,
      });
    });

    test(`${reason}: registration still accepts an observer past the deadline`, async () => {
      await seedRow(reason);
      timer.setCurrentTime(DEADLINE + 1);
      expect(await wire(DAEMON_REGISTER_SESSION_METHOD)).toMatchObject({
        success: true,
        result: { accepted: true },
      });
      expect(await repo.getSession!(SESSION)).toMatchObject({
        status: "released",
        release_reason: reason,
      });
      await manager.createSession(SESSION, DEVICE, "android", IDLE_MS);
      expect(await wire("daemon/sessionInfo")).toMatchObject({
        success: true,
        result: { sessionId: SESSION, assignedDevice: DEVICE },
      });
      expect(await repo.getSession!(SESSION)).toMatchObject({
        status: "active",
        release_reason: null,
      });
    });

    test(`${reason}: bound-session-loss reads no expired snapshot`, async () => {
      await seedRow(reason);
      timer.setCurrentTime(DEADLINE + 1);
      expect(await manager.getExpiredReleaseSnapshot(SESSION)).toBeUndefined();
    });

    test(`${reason}: device-tool admission leaves the released row untouched past its deadline`, async () => {
      await seedRow(reason);
      timer.setCurrentTime(DEADLINE + 1);
      await expect(
        manager.getOrCreateSession(SESSION, pool, "android", undefined, true),
      ).rejects.toBeInstanceOf(UnissuedSessionError);
      expect(await repo.getSession!(SESSION)).toMatchObject({
        status: "released",
        release_reason: reason,
      });
    });
  }

  test("a recovered handoff rolled back before handout keeps allocation-rollback", async () => {
    await seedRow("daemon-shutdown");
    await repo.markReleased(SESSION, "released", CREATED_AT + 750, "allocation-rollback");
    timer.setCurrentTime(DEADLINE + 1);
    await expectNamedNotFound("allocation-rollback");
    expect(await wire(DAEMON_REGISTER_SESSION_METHOD)).toMatchObject({
      success: true,
      result: { accepted: true },
    });
  });

  for (const reason of ["daemon-shutdown", "superseded"]) {
    test(`${reason}: existing persisted idle end and registration refusal are unchanged`, async () => {
      await seedRow(reason);
      timer.setCurrentTime(DEADLINE + 1);
      for (const method of ["daemon/heartbeat", "daemon/sessionInfo"]) {
        expect(await wire(method)).toEqual({
          success: false,
          code: DAEMON_SESSION_NOT_FOUND_CODE,
          error: `Session not found: ${SESSION}`,
          releaseReason: "expired",
          idle: true,
        });
      }
      expect(await wire(DAEMON_REGISTER_SESSION_METHOD)).toMatchObject({
        success: false,
        code: SESSION_OWNERSHIP_LOST_CODE,
        releaseReason: "expired",
        idle: true,
        details: { sessionUuid: SESSION, reason: "expired", idle: true },
      });
      expect(await controlError()).toBeInstanceOf(TerminalSessionError);
      // Pool-less admission only reads; the device-tool path also terminalizes the lapsed row.
      expect(await repo.getSession!(SESSION)).toMatchObject({
        status: "released",
        release_reason: reason,
      });
      await expect(
        manager.getOrCreateSession(SESSION, pool, "android", undefined, true),
      ).rejects.toBeInstanceOf(TerminalSessionError);
      expect(await repo.getSession!(SESSION)).toMatchObject({
        status: "expired",
        release_reason: "expired",
      });
    });
  }
});

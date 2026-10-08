import { describe, expect, test } from "bun:test";
import {
  SessionManager,
  type SessionDeviceAssigner,
  getDefaultSessionHeartbeatTimeoutMs,
} from "../../src/daemon/sessionManager";
import {
  DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
} from "../../src/daemon/sessionLivenessWindows";
import type { DeviceSessionRecord } from "../../src/db/deviceSessionRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

// A session persisted by a daemon from before the 2026-10-08 owner decision carries the old
// defaults (30 min idle, 10 s lease, 10 min CLI idle). Rehydrated by the upgraded daemon, the
// defaulted values follow the new windows; explicitly requested values are kept.

const LEGACY_IDLE_MS = 30 * 60_000;
const LEGACY_LEASE_MS = 10_000;
const LEGACY_CLI_IDLE_MS = 10 * 60_000;

async function rehydrate(
  row: Partial<DeviceSessionRecord>,
): Promise<{ manager: SessionManager; sessionId: string }> {
  const timer = new FakeTimer();
  timer.setCurrentTime(1_000);
  const persistence = new FakeDeviceSessionPersistence();
  const sessionId = "persisted-before-upgrade";
  await persistence.upsertActiveSession({
    sessionUuid: sessionId,
    deviceId: "emulator-5554",
    stableDeviceId: "Pixel_8_API_35",
    platform: "android",
    createdAtMs: 0,
    lastUsedAtMs: 500,
    expiresAtMs: 500 + LEGACY_IDLE_MS,
    sessionTimeoutMs: LEGACY_IDLE_MS,
    heartbeatTimeoutMs: LEGACY_LEASE_MS,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: true,
    ...row,
  });
  await persistence.markReleased(sessionId, "expired", 900, "daemon-restart");
  const manager = new SessionManager(timer, persistence);
  const devicePool: SessionDeviceAssigner = {
    async assignDeviceToSession(id, _platform, target): Promise<string> {
      const session = await manager.createSession(
        id,
        "emulator-5554",
        "android",
        target?.liveness?.sessionTimeoutMs,
        target?.liveness?.heartbeatTimeoutMs,
        target?.stableDeviceId,
        target?.liveness,
        target?.initialOwnership,
      );
      return session.assignedDevice;
    },
  };
  await manager.rehydratePersistedSessions(devicePool);
  return { manager, sessionId };
}

describe("rehydrating a session persisted with the pre-upgrade liveness defaults", () => {
  test("defaulted idle window and lease adopt the current defaults", async () => {
    const { manager, sessionId } = await rehydrate({});
    try {
      expect(manager.getSession(sessionId)).toMatchObject({
        sessionTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS,
        expiresAt: 1_000 + DEFAULT_SESSION_IDLE_TIMEOUT_MS,
        heartbeatTimeoutMs: DEFAULT_SESSION_HEARTBEAT_TIMEOUT_MS,
        heartbeatTimeoutSource: "default",
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("explicitly requested windows are kept", async () => {
    const { manager, sessionId } = await rehydrate({
      sessionTimeoutMs: 45 * 60_000,
      heartbeatTimeoutMs: 15_000,
      heartbeatTimeoutSource: "custom",
    });
    try {
      expect(manager.getSession(sessionId)).toMatchObject({
        sessionTimeoutMs: 45 * 60_000,
        heartbeatTimeoutMs: 15_000,
        heartbeatTimeoutSource: "custom",
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });

  test("a CLI session on the old 10 min idle default adopts the current CLI idle window", async () => {
    const { manager, sessionId } = await rehydrate({
      livenessPolicy: "cli-idle",
      heartbeatTimeoutMs: LEGACY_CLI_IDLE_MS,
      preCliHeartbeatTimeoutMs: LEGACY_LEASE_MS,
      preCliHeartbeatTimeoutSource: "default",
      preCliSessionTimeoutMs: LEGACY_IDLE_MS,
    });
    try {
      expect(manager.getSession(sessionId)).toMatchObject({
        livenessPolicy: "cli-idle",
        heartbeatTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS,
        sessionTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS,
        preCliLiveness: {
          heartbeatTimeoutMs: getDefaultSessionHeartbeatTimeoutMs(),
          heartbeatTimeoutSource: "default",
          sessionTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS,
        },
      });
    } finally {
      manager.stopCleanupTimer();
    }
  });
});

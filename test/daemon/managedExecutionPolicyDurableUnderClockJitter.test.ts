import { afterEach, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { SessionManager, type SessionDeviceAssigner } from "../../src/daemon/sessionManager";
import { onSessionClock } from "../../src/daemon/sessionClockPersistence";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

const SESSION = "managed-jitter-session";
const DEVICE = "emulator-fake";

/** The rounded wall clock has not ticked, but the monotonic sample has advanced. */
class JitterTimer extends FakeTimer {
  jitterMs = 0;
  override monotonicNow(): number {
    return super.monotonicNow() + this.jitterMs;
  }
}

let db: Kysely<Database> | undefined;
const managers: SessionManager[] = [];
afterEach(async () => {
  managers.splice(0).forEach((manager) => manager.stopCleanupTimer());
  await db?.destroy();
  db = undefined;
});

test("managed policy survives a lower second conversion and daemon rehydration", async () => {
  const timer = new JitterTimer();
  timer.setCurrentTime(1_700_000_000_000);
  db = await createTestDatabase();
  const repository = new DeviceSessionRepository({ db, timer });
  const writer = new SessionManager(timer, repository);
  managers.push(writer);
  const session = await writer.createSession(SESSION, DEVICE, "android", {
    stableDeviceId: "Pixel_fake",
  });
  await writer.claimLivenessOwnership(SESSION, "proxy-token");
  const original = await repository.getSession(SESSION);
  timer.jitterMs = 1;
  expect(writer.sessionClockToWall(session.lastUsedAt)).toBe(original!.last_used_at_ms - 1);

  await writer.adoptManagedExecutionLivenessPolicy(SESSION);

  expect(await repository.getSession(SESSION)).toMatchObject({
    last_used_at_ms: original!.last_used_at_ms,
    liveness_policy: "managed-execution",
  });
  writer.stopCleanupTimer();
  // Startup tags the dead daemon's active rows for recovery before rehydrating them.
  await repository.markReleased(SESSION, "expired", timer.now(), { reason: "daemon-restart" });
  const reader = new SessionManager(timer, repository);
  managers.push(reader);
  const assigner: SessionDeviceAssigner = {
    async assignDeviceToSession(id, _platform, target) {
      return (
        await reader.createSession(id, DEVICE, "android", {
          timeoutMs: target?.liveness?.sessionTimeoutMs,
          heartbeatTimeoutMs: target?.liveness?.heartbeatTimeoutMs,
          stableDeviceId: target?.stableDeviceId,
          recoveredLiveness: target?.liveness,
          initialOwnership: target?.initialOwnership,
        })
      ).assignedDevice;
    },
  };
  expect(await reader.rehydratePersistedSessions(assigner)).toMatchObject({
    rehydrated: [SESSION],
    skipped: [],
    terminalized: [],
    timedOut: false,
  });
  expect(reader.isLiveManagedExecutionSession(SESSION)).toBe(true);
});

test("unchanged instants reuse their wall stamps; newer and stale instants still cross the frame", async () => {
  const timer = new FakeTimer();
  db = await createTestDatabase();
  const repository = new DeviceSessionRepository({ db, timer });
  let offset = 1_000;
  const converted: number[] = [];
  const persistence = onSessionClock(repository, {
    toWall: (instant) => {
      converted.push(instant);
      return instant + offset;
    },
    toSessionClock: (wall) => wall - offset,
  });
  await persistence.upsertActiveSession({
    sessionUuid: SESSION,
    deviceId: DEVICE,
    platform: "android",
    createdAtMs: 10,
    lastUsedAtMs: 10,
    expiresAtMs: 100,
    sessionTimeoutMs: 90,
    heartbeatTimeoutMs: 10_000,
    hasReceivedHeartbeat: false,
  });
  offset--;
  const activity = {
    lastUsedAtMs: 10,
    expiresAtMs: 100,
    sessionTimeoutMs: 90,
    heartbeatTimeoutMs: 10_000,
    hasReceivedHeartbeat: false,
    livenessPolicy: "managed-execution" as const,
  };
  converted.length = 0;
  await persistence.recordActivity(SESSION, activity);
  expect(await repository.getSession(SESSION)).toMatchObject({
    last_used_at_ms: 1_010,
    expires_at_ms: 1_100,
    liveness_policy: "managed-execution",
  });
  expect(converted).toEqual([]);

  await persistence.recordActivity(SESSION, { ...activity, lastUsedAtMs: 20, expiresAtMs: 110 });
  expect(converted).toEqual([20, 110]);
  expect(await repository.getSession(SESSION)).toMatchObject({
    last_used_at_ms: 1_019,
    expires_at_ms: 1_109,
  });
  await persistence.recordActivity(SESSION, {
    ...activity,
    lastUsedAtMs: 5,
    expiresAtMs: 95,
    livenessPolicy: "heartbeat",
  });
  expect(converted).toEqual([20, 110, 5, 95]);
  expect(await repository.getSession(SESSION)).toMatchObject({
    last_used_at_ms: 1_019,
    expires_at_ms: 1_109,
    liveness_policy: "managed-execution",
  });
});

test("stale activity preserves the newer stamp for a managed policy write under jitter", async () => {
  const timer = new FakeTimer();
  db = await createTestDatabase();
  const repository = new DeviceSessionRepository({ db, timer });
  let offset = 1_000;
  const converted: number[] = [];
  const persistence = onSessionClock(repository, {
    toWall: (instant) => {
      converted.push(instant);
      return instant + offset;
    },
    toSessionClock: (wall) => wall - offset,
  });
  await persistence.upsertActiveSession({
    sessionUuid: SESSION,
    deviceId: DEVICE,
    platform: "android",
    createdAtMs: 10,
    lastUsedAtMs: 20,
    expiresAtMs: 110,
    sessionTimeoutMs: 90,
    heartbeatTimeoutMs: 10_000,
    hasReceivedHeartbeat: false,
  });
  const activity = {
    lastUsedAtMs: 20,
    expiresAtMs: 110,
    sessionTimeoutMs: 90,
    heartbeatTimeoutMs: 10_000,
    hasReceivedHeartbeat: false,
  };
  const original = await repository.getSession(SESSION);
  converted.length = 0;
  await persistence.recordActivity(SESSION, {
    ...activity,
    lastUsedAtMs: 5,
    expiresAtMs: 95,
    livenessPolicy: "heartbeat",
  });
  expect(converted).toEqual([5, 95]);
  expect(await repository.getSession(SESSION)).toMatchObject({
    last_used_at_ms: original!.last_used_at_ms,
    expires_at_ms: original!.expires_at_ms,
    session_timeout_ms: original!.session_timeout_ms,
    heartbeat_timeout_ms: original!.heartbeat_timeout_ms,
    liveness_policy: null,
  });
  offset--;
  await persistence.recordActivity(SESSION, { ...activity, livenessPolicy: "managed-execution" });
  expect(await repository.getSession(SESSION)).toMatchObject({
    last_used_at_ms: 1_020,
    liveness_policy: "managed-execution",
  });
  expect((await persistence.getSession!(SESSION))!.last_used_at_ms).toBe(20);
});

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import {
  DeviceSessionRepository,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import { onSessionClock, type SessionClockFrame } from "../../src/daemon/sessionClockPersistence";
import type { Database } from "../../src/db/types";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

const SESSION = "activity-sequence";
const WINDOW = 60_000;
function record(lastUsedAtMs = 10_000, activitySeq = lastUsedAtMs): DeviceSessionRecord {
  return {
    sessionUuid: SESSION,
    deviceId: "emulator-5554",
    platform: "android",
    createdAtMs: 10_000,
    lastUsedAtMs,
    activitySeq,
    expiresAtMs: lastUsedAtMs + WINDOW,
    sessionTimeoutMs: WINDOW,
    heartbeatTimeoutMs: WINDOW,
    hasReceivedHeartbeat: true,
  };
}

class SteppingFrame implements SessionClockFrame {
  offset = 0;
  toWall(ms: number): number {
    return ms + this.offset;
  }
  toSessionClock(ms: number): number {
    return ms - this.offset;
  }
}

class RejectingUpsertRepository extends DeviceSessionRepository {
  rejectUpserts = false;
  override upsertActiveSession(
    ...args: Parameters<DeviceSessionRepository["upsertActiveSession"]>
  ): Promise<number> {
    return this.rejectUpserts
      ? Promise.reject(new Error("SQLITE_BUSY: database is locked"))
      : super.upsertActiveSession(...args);
  }
}

describe("activity sequence orders writes independently of the wall clock", () => {
  let db: Kysely<Database>;
  let timer: FakeTimer;
  let repo: RejectingUpsertRepository;

  beforeAll(async () => {
    // Warm the pre-upgrade snapshot outside each test's 15 ms budget.
    await (
      await createTestDatabase({
        throughMigration: "2026_10_13_000_video_recording_recorder_daemon",
      })
    ).destroy();
  });
  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
    timer.setCurrentTime(10_000);
    repo = new RejectingUpsertRepository(db, timer);
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("later activity after a backward wall step writes its full lease and display stamp", async () => {
    await repo.upsertActiveSession(record());
    await repo.recordActivity(SESSION, record(6_000, 11_000));
    expect(await repo.getSession(SESSION)).toMatchObject({
      activity_seq: 11_000,
      last_used_at_ms: 6_000,
      expires_at_ms: 66_000,
    });
  });

  test("a delayed BUSY retry with a lower sequence matches but cannot replace newer activity", async () => {
    await repo.upsertActiveSession(record(6_000, 11_000));
    const before = await repo.getSession(SESSION);
    await expect(
      repo.recordActivity(SESSION, {
        ...record(10_000, 10_000),
        sessionTimeoutMs: 1,
        heartbeatTimeoutMs: 2,
        hasReceivedHeartbeat: false,
        livenessPolicy: "cli-idle",
      }),
    ).resolves.toBeUndefined();
    expect(await repo.getSession(SESSION)).toMatchObject({
      activity_seq: 11_000,
      last_used_at_ms: 6_000,
      expires_at_ms: before!.expires_at_ms,
      session_timeout_ms: WINDOW,
      heartbeat_timeout_ms: WINDOW,
      has_received_heartbeat: 1,
      liveness_policy: null,
    });
  });

  test("equal sequences still apply policy changes", async () => {
    await repo.upsertActiveSession(record());
    await repo.recordActivity(SESSION, { ...record(6_000, 10_000), sessionTimeoutMs: 7_000 });
    expect(await repo.getSession(SESSION)).toMatchObject({
      last_used_at_ms: 6_000,
      session_timeout_ms: 7_000,
    });
  });

  test("autolock accepts later activity with a lower wall stamp and ignores an older retry", async () => {
    await repo.upsertActiveSession(record());
    await repo.markAutolockSession(SESSION, record(6_000, 11_000));
    await repo.markAutolockSession(SESSION, record(10_000, 10_000));
    expect(await repo.getSession(SESSION)).toMatchObject({
      source: "autolock",
      autolock_enabled: 1,
      activity_seq: 11_000,
      last_used_at_ms: 6_000,
      expires_at_ms: 66_000,
    });
  });

  test.each([-5_000, 3_600_000])(
    "wrapper preserves exactly one idle window after wall step %i",
    async (step) => {
      const frame = new SteppingFrame();
      const persistence = onSessionClock(repo, frame);
      // Omit the explicit seq so the wrapper must use the raw session-clock stamp.
      const initial = { ...record(), activitySeq: undefined };
      await persistence.upsertActiveSession(initial);
      await persistence.recordActivity(SESSION, {
        ...initial,
        lastUsedAtMs: 10_500,
        expiresAtMs: 70_500,
      });
      timer.advanceTime(1_000);
      timer.stepWallClock(step);
      frame.offset = step;
      await persistence.recordActivity(SESSION, {
        ...initial,
        lastUsedAtMs: 11_000,
        expiresAtMs: 71_000,
      });
      const wall = await repo.getSession(SESSION);
      expect(wall).toMatchObject({
        activity_seq: 11_000,
        last_used_at_ms: timer.now(),
        expires_at_ms: timer.now() + WINDOW,
      });
      const local = await persistence.getSession?.(SESSION);
      expect(local).toMatchObject({ last_used_at_ms: 11_000, expires_at_ms: 71_000 });
      expect(local!.expires_at_ms - 11_000).toBe(WINDOW);
    },
  );

  test.each(["evicted memo", "rejected upsert"])(
    "later activity survives %s across a backward step",
    async (scenario) => {
      const frame = new SteppingFrame();
      const persistence = onSessionClock(repo, frame);
      const initial = { ...record(), activitySeq: undefined };
      await persistence.upsertActiveSession(initial);
      repo.rejectUpserts = true;
      if (scenario === "evicted memo") {
        // Rejected inserts fill the bounded memo without creating 512 database rows.
        for (let index = 0; index < 512; index++) {
          await persistence
            .upsertActiveSession({ ...initial, sessionUuid: `rejected-${index}` })
            .catch(() => undefined);
        }
      } else {
        await expect(
          persistence.upsertActiveSession({
            ...initial,
            lastUsedAtMs: 12_000,
            expiresAtMs: 72_000,
          }),
        ).rejects.toThrow("SQLITE_BUSY");
      }
      frame.offset = -5_000;
      await persistence.recordActivity(SESSION, {
        ...initial,
        lastUsedAtMs: 11_000,
        expiresAtMs: 71_000,
      });
      expect(await repo.getSession(SESSION)).toMatchObject({
        activity_seq: 11_000,
        last_used_at_ms: 6_000,
        expires_at_ms: 66_000,
      });
    },
  );

  test("explicit wrapper sequence overrides the session-clock default on insert and conflict", async () => {
    const frame = new SteppingFrame();
    frame.offset = -5_000;
    const persistence = onSessionClock(repo, frame);
    await persistence.upsertActiveSession(record(10_000, 100));
    await persistence.upsertActiveSession(record(11_000, 200));
    await persistence.recordActivity(SESSION, record(12_000, 300));
    expect(await repo.getSession(SESSION)).toMatchObject({
      activity_seq: 300,
      last_used_at_ms: 7_000,
    });
    await persistence.recordActivity(SESSION, record(13_000, 250));
    expect(await repo.getSession(SESSION)).toMatchObject({
      activity_seq: 300,
      last_used_at_ms: 7_000,
    });
  });

  test("migration upgrades an existing row idempotently and seq zero accepts first activity", async () => {
    const legacy = await createTestDatabase({
      throughMigration: "2026_10_13_000_video_recording_recorder_daemon",
    });
    try {
      await sql`INSERT INTO device_sessions (session_uuid, device_id, platform, status, created_at_ms, last_used_at_ms, expires_at_ms, session_timeout_ms, heartbeat_timeout_ms, has_received_heartbeat) VALUES (${SESSION}, 'emulator-5554', 'android', 'active', 10000, 10000, 70000, 60000, 60000, 1)`.execute(
        legacy,
      );
      const { up } =
        await import("../../src/db/migrations/2026_10_15_000_device_session_activity_seq");
      await up(legacy);
      await up(legacy);
      const columns = await sql<{
        name: string;
        notnull: number;
        dflt_value: string;
      }>`SELECT name, "notnull", dflt_value FROM pragma_table_info('device_sessions') WHERE name = 'activity_seq'`.execute(
        legacy,
      );
      expect(columns.rows).toEqual([{ name: "activity_seq", notnull: 1, dflt_value: "0" }]);
      const upgraded = new DeviceSessionRepository(legacy, timer);
      expect(await upgraded.getSession(SESSION)).toMatchObject({
        activity_seq: 0,
        last_used_at_ms: 10_000,
      });
      await upgraded.recordActivity(SESSION, record(6_000, 1));
      expect(await upgraded.getSession(SESSION)).toMatchObject({
        activity_seq: 1,
        last_used_at_ms: 6_000,
        expires_at_ms: 66_000,
      });
    } finally {
      await legacy.destroy();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import {
  DeviceSessionRepository,
  type DeviceSessionRecord,
} from "../../src/db/deviceSessionRepository";
import type { Database } from "../../src/db/types";
import { up, down } from "../../src/db/migrations/2026_10_05_003_device_session_liveness_release";
import { createTestDatabase } from "./testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";

const record: DeviceSessionRecord = {
  sessionUuid: "release",
  deviceId: "emulator-5554",
  platform: "android",
  createdAtMs: 0,
  lastUsedAtMs: 0,
  expiresAtMs: 60_000,
  sessionTimeoutMs: 60_000,
  heartbeatTimeoutMs: 10_000,
  hasReceivedHeartbeat: true,
};
const release = { releasedBy: "owner", lastOwnerHeartbeat: 123, graceMs: 10_000 };

describe("durable explicit liveness release", () => {
  let db: Kysely<Database>;
  let repo: DeviceSessionRepository;
  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new DeviceSessionRepository(db, new FakeTimer());
    await repo.upsertActiveSession(record);
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("up is idempotent and down removes only release metadata", async () => {
    const migrationDb = db as Kysely<unknown>;
    await up(migrationDb);
    await up(migrationDb);
    await down(migrationDb);
    const columns = await sql<{
      name: string;
    }>`SELECT name FROM pragma_table_info('device_sessions')`.execute(db);
    expect(columns.rows.map((column) => column.name)).not.toContain("liveness_released_by");
    expect(columns.rows.map((column) => column.name)).toContain("liveness_owner_token");
    await up(migrationDb);
    await repo.recordLivenessOwnership("release", null, release);
    expect((await repo.getSession("release"))?.liveness_released_by).toBe("owner");
  });

  test("release survives shutdown, activity and reactivation; a claim clears it", async () => {
    await repo.recordLivenessOwnership("release", "owner");
    await repo.recordLivenessOwnership("release", null, release);
    await repo.recordActivity("release", record);
    await repo.markReleased("release", "expired", 456, "daemon-restart");
    await repo.upsertActiveSession(record);
    expect(await repo.getSession("release")).toMatchObject({
      liveness_owner_token: null,
      liveness_released_by: "owner",
      liveness_released_heartbeat_ms: 123,
      liveness_released_grace_ms: 10_000,
    });
    await repo.recordLivenessOwnership("release", "next");
    expect(await repo.getSession("release")).toMatchObject({
      liveness_owner_token: "next",
      liveness_released_by: null,
      liveness_released_heartbeat_ms: null,
      liveness_released_grace_ms: null,
    });
  });

  test("older ownership writers invalidate release evidence", async () => {
    await repo.recordLivenessOwnership("release", null, release);
    await db
      .updateTable("device_sessions")
      .set({ liveness_owner_token: "old-writer" })
      .where("session_uuid", "=", "release")
      .execute();
    expect((await repo.getSession("release"))?.liveness_released_by).toBeNull();
  });

  test("terminal release clears ownership proof and deadlines", async () => {
    await repo.recordLivenessOwnership("release", null, release);
    await repo.markReleased("release", "expired", 456, "heartbeat-timeout");
    expect(await repo.getSession("release")).toMatchObject({
      liveness_owner_token: null,
      liveness_released_by: null,
      liveness_released_heartbeat_ms: null,
      liveness_released_grace_ms: null,
    });
  });
});

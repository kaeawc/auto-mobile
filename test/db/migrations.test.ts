import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { runMigrations } from "../../src/db/migrator";
import * as telemetryMigration from "../../src/db/migrations/2026_03_15_000_telemetry_events";
import * as navigationEventsMigration from "../../src/db/migrations/2026_03_18_000_navigation_events";
import * as storageEventsMigration from "../../src/db/migrations/2026_03_19_000_storage_events";
import * as layoutEventsMigration from "../../src/db/migrations/2026_03_19_001_layout_events";
import * as storageEventsPreviousValueMigration from "../../src/db/migrations/2026_03_19_002_storage_events_previous_value";
import * as layoutEventsScreenNameMigration from "../../src/db/migrations/2026_03_19_003_layout_events_screen_name";
import * as networkEventDetailsMigration from "../../src/db/migrations/2026_03_20_000_network_event_details";
import * as dropCustomEventsMigration from "../../src/db/migrations/2026_04_01_000_drop_custom_events";

function createDb(): Kysely<unknown> {
  return new Kysely<unknown>({
    dialect: new BunSqliteDialect({
      database: new BunDatabase(":memory:"),
    }),
  });
}

async function tableExists(db: Kysely<unknown>, name: string): Promise<boolean> {
  const result = await db
    .selectFrom("sqlite_master" as any)
    .select("name")
    .where("type", "=", "table")
    .where("name", "=", name)
    .executeTakeFirst();
  return result !== undefined;
}

async function columnExists(db: Kysely<unknown>, table: string, column: string): Promise<boolean> {
  const result = await sql<{ name: string }>`
    SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}
  `.execute(db);
  return result.rows.length > 0;
}

describe("full migration chain", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createDb();
    await runMigrations(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("creates device_configs table", async () => {
    expect(await tableExists(db, "device_configs")).toBe(true);
  });

  test("creates device_sessions table for persisted device session diagnostics", async () => {
    expect(await tableExists(db, "device_sessions")).toBe(true);
    for (const col of [
      "session_uuid",
      "device_id",
      "platform",
      "status",
      "autolock_enabled",
      "mcp_session_id",
      "daemon_session_id",
      "created_at_ms",
      "last_used_at_ms",
      "expires_at_ms",
      "released_at_ms",
      "release_reason",
    ]) {
      expect(await columnExists(db, "device_sessions", col)).toBe(true);
    }
  });

  test("creates network_events table with detail columns", async () => {
    expect(await tableExists(db, "network_events")).toBe(true);
    expect(await columnExists(db, "network_events", "url")).toBe(true);
    expect(await columnExists(db, "network_events", "request_headers_json")).toBe(true);
    expect(await columnExists(db, "network_events", "response_headers_json")).toBe(true);
    expect(await columnExists(db, "network_events", "request_body")).toBe(true);
    expect(await columnExists(db, "network_events", "response_body")).toBe(true);
    expect(await columnExists(db, "network_events", "content_type")).toBe(true);
  });

  test("creates log_events table", async () => {
    expect(await tableExists(db, "log_events")).toBe(true);
    expect(await columnExists(db, "log_events", "level")).toBe(true);
    expect(await columnExists(db, "log_events", "tag")).toBe(true);
    expect(await columnExists(db, "log_events", "message")).toBe(true);
  });

  test("does not have custom_events table (dropped by later migration)", async () => {
    expect(await tableExists(db, "custom_events")).toBe(false);
  });

  test("creates os_events table", async () => {
    expect(await tableExists(db, "os_events")).toBe(true);
    expect(await columnExists(db, "os_events", "category")).toBe(true);
    expect(await columnExists(db, "os_events", "kind")).toBe(true);
  });

  test("creates navigation_events table", async () => {
    expect(await tableExists(db, "navigation_events")).toBe(true);
    expect(await columnExists(db, "navigation_events", "destination")).toBe(true);
    expect(await columnExists(db, "navigation_events", "source")).toBe(true);
  });

  test("creates storage_events table with previous_value column", async () => {
    expect(await tableExists(db, "storage_events")).toBe(true);
    expect(await columnExists(db, "storage_events", "file_name")).toBe(true);
    expect(await columnExists(db, "storage_events", "change_type")).toBe(true);
    expect(await columnExists(db, "storage_events", "previous_value")).toBe(true);
  });

  test("creates layout_events table with screen_name column", async () => {
    expect(await tableExists(db, "layout_events")).toBe(true);
    expect(await columnExists(db, "layout_events", "sub_type")).toBe(true);
    expect(await columnExists(db, "layout_events", "screen_name")).toBe(true);
  });

  test("can insert and select from network_events", async () => {
    await sql`INSERT INTO network_events (timestamp, url, method, status_code, duration_ms) VALUES (1000, 'https://example.com', 'GET', 200, 42)`.execute(
      db,
    );
    const rows = await sql<{ url: string }>`SELECT url FROM network_events`.execute(db);
    expect(rows.rows[0]?.url).toBe("https://example.com");
  });

  test("can insert and select from log_events", async () => {
    await sql`INSERT INTO log_events (timestamp, level, tag, message, filter_name) VALUES (1000, 3, 'MyTag', 'hello', 'default')`.execute(
      db,
    );
    const rows = await sql<{ tag: string }>`SELECT tag FROM log_events`.execute(db);
    expect(rows.rows[0]?.tag).toBe("MyTag");
  });

  test("can insert and select from navigation_events", async () => {
    await sql`INSERT INTO navigation_events (timestamp, destination) VALUES (2000, 'HomeScreen')`.execute(
      db,
    );
    const rows = await sql<{
      destination: string;
    }>`SELECT destination FROM navigation_events`.execute(db);
    expect(rows.rows[0]?.destination).toBe("HomeScreen");
  });

  test("can insert and select from storage_events", async () => {
    await sql`INSERT INTO storage_events (timestamp, file_name, change_type) VALUES (3000, 'prefs.xml', 'put')`.execute(
      db,
    );
    const rows = await sql<{ file_name: string }>`SELECT file_name FROM storage_events`.execute(db);
    expect(rows.rows[0]?.file_name).toBe("prefs.xml");
  });
});

describe("2026_03_15_000_telemetry_events migration", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up creates network_events, log_events, custom_events, os_events", async () => {
    await telemetryMigration.up(db);

    expect(await tableExists(db, "network_events")).toBe(true);
    expect(await tableExists(db, "log_events")).toBe(true);
    expect(await tableExists(db, "custom_events")).toBe(true);
    expect(await tableExists(db, "os_events")).toBe(true);
  });

  test("up is idempotent: a second up() preserves existing rows (not a destructive drop+create)", async () => {
    await telemetryMigration.up(db);
    await sql`INSERT INTO log_events (timestamp, level, tag, message, filter_name) VALUES (1000, 3, 'TAG', 'hello', 'flt')`.execute(
      db,
    );

    await expect(telemetryMigration.up(db)).resolves.toBeUndefined();

    // A drop+create "idempotent" rewrite would not throw but would wipe the row.
    const count = await sql<{ c: number }>`SELECT count(*) AS c FROM log_events`.execute(db);
    expect(Number(count.rows[0].c)).toBe(1);
  });

  test("down drops all four tables", async () => {
    await telemetryMigration.up(db);
    await telemetryMigration.down(db);

    expect(await tableExists(db, "network_events")).toBe(false);
    expect(await tableExists(db, "log_events")).toBe(false);
    expect(await tableExists(db, "custom_events")).toBe(false);
    expect(await tableExists(db, "os_events")).toBe(false);
  });

  test("network_events has required columns", async () => {
    await telemetryMigration.up(db);

    for (const col of [
      "id",
      "device_id",
      "timestamp",
      "url",
      "method",
      "status_code",
      "duration_ms",
      "host",
      "path",
    ]) {
      expect(await columnExists(db, "network_events", col)).toBe(true);
    }
  });

  test("log_events has required columns", async () => {
    await telemetryMigration.up(db);

    for (const col of ["id", "device_id", "timestamp", "level", "tag", "message", "filter_name"]) {
      expect(await columnExists(db, "log_events", col)).toBe(true);
    }
  });

  test("os_events has required columns", async () => {
    await telemetryMigration.up(db);

    for (const col of ["id", "device_id", "timestamp", "category", "kind", "details_json"]) {
      expect(await columnExists(db, "os_events", col)).toBe(true);
    }
  });
});

describe("2026_03_18_000_navigation_events migration", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up creates navigation_events table", async () => {
    await navigationEventsMigration.up(db);
    expect(await tableExists(db, "navigation_events")).toBe(true);
  });

  test("navigation_events has required columns", async () => {
    await navigationEventsMigration.up(db);

    for (const col of [
      "id",
      "device_id",
      "timestamp",
      "application_id",
      "session_id",
      "destination",
      "source",
      "arguments_json",
      "metadata_json",
      "created_at",
    ]) {
      expect(await columnExists(db, "navigation_events", col)).toBe(true);
    }
  });

  test("down drops navigation_events table", async () => {
    await navigationEventsMigration.up(db);
    await navigationEventsMigration.down(db);
    expect(await tableExists(db, "navigation_events")).toBe(false);
  });

  test("destination is required (not null)", async () => {
    await navigationEventsMigration.up(db);
    await expect(
      sql`INSERT INTO navigation_events (timestamp) VALUES (1000)`.execute(db),
    ).rejects.toThrow();
  });
});

describe("2026_03_19_000_storage_events migration", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up creates storage_events table", async () => {
    await storageEventsMigration.up(db);
    expect(await tableExists(db, "storage_events")).toBe(true);
  });

  test("storage_events has required columns", async () => {
    await storageEventsMigration.up(db);

    for (const col of [
      "id",
      "device_id",
      "timestamp",
      "file_name",
      "key",
      "value",
      "value_type",
      "change_type",
      "created_at",
    ]) {
      expect(await columnExists(db, "storage_events", col)).toBe(true);
    }
  });

  test("down drops storage_events table", async () => {
    await storageEventsMigration.up(db);
    await storageEventsMigration.down(db);
    expect(await tableExists(db, "storage_events")).toBe(false);
  });

  test("file_name and change_type are required (not null)", async () => {
    await storageEventsMigration.up(db);
    await expect(
      sql`INSERT INTO storage_events (timestamp, change_type) VALUES (1000, 'put')`.execute(db),
    ).rejects.toThrow();
  });
});

describe("2026_03_19_001_layout_events migration", () => {
  let db: Kysely<unknown>;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up creates layout_events table", async () => {
    await layoutEventsMigration.up(db);
    expect(await tableExists(db, "layout_events")).toBe(true);
  });

  test("layout_events has required columns", async () => {
    await layoutEventsMigration.up(db);

    for (const col of [
      "id",
      "device_id",
      "timestamp",
      "sub_type",
      "composable_name",
      "composable_id",
      "recomposition_count",
      "duration_ms",
      "likely_cause",
      "details_json",
      "created_at",
    ]) {
      expect(await columnExists(db, "layout_events", col)).toBe(true);
    }
  });

  test("down drops layout_events table", async () => {
    await layoutEventsMigration.up(db);
    await layoutEventsMigration.down(db);
    expect(await tableExists(db, "layout_events")).toBe(false);
  });
});

describe("2026_03_19_002_storage_events_previous_value migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createDb();
    await storageEventsMigration.up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up adds previous_value column to storage_events", async () => {
    expect(await columnExists(db, "storage_events", "previous_value")).toBe(false);
    await storageEventsPreviousValueMigration.up(db);
    expect(await columnExists(db, "storage_events", "previous_value")).toBe(true);
  });

  test("up is idempotent: a second up() preserves existing rows and keeps the column", async () => {
    await storageEventsPreviousValueMigration.up(db);
    await sql`INSERT INTO storage_events (timestamp, file_name, change_type) VALUES (1000, 'prefs.xml', 'modify')`.execute(
      db,
    );

    await expect(storageEventsPreviousValueMigration.up(db)).resolves.toBeUndefined();

    const count = await sql<{ c: number }>`SELECT count(*) AS c FROM storage_events`.execute(db);
    expect(Number(count.rows[0].c)).toBe(1);
    expect(await columnExists(db, "storage_events", "previous_value")).toBe(true);
  });

  test("previous_value is nullable", async () => {
    await storageEventsPreviousValueMigration.up(db);
    await expect(
      sql`INSERT INTO storage_events (timestamp, file_name, change_type) VALUES (1000, 'prefs.xml', 'put')`.execute(
        db,
      ),
    ).resolves.toBeDefined();
  });

  test("down removes previous_value column", async () => {
    await storageEventsPreviousValueMigration.up(db);
    await storageEventsPreviousValueMigration.down(db);
    expect(await columnExists(db, "storage_events", "previous_value")).toBe(false);
  });
});

describe("2026_03_19_003_layout_events_screen_name migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createDb();
    await layoutEventsMigration.up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up adds screen_name column to layout_events", async () => {
    expect(await columnExists(db, "layout_events", "screen_name")).toBe(false);
    await layoutEventsScreenNameMigration.up(db);
    expect(await columnExists(db, "layout_events", "screen_name")).toBe(true);
  });

  test("up is idempotent: a second up() preserves existing rows and keeps the column", async () => {
    await layoutEventsScreenNameMigration.up(db);
    await sql`INSERT INTO layout_events (timestamp, sub_type) VALUES (1000, 'recomposition')`.execute(
      db,
    );

    await expect(layoutEventsScreenNameMigration.up(db)).resolves.toBeUndefined();

    const count = await sql<{ c: number }>`SELECT count(*) AS c FROM layout_events`.execute(db);
    expect(Number(count.rows[0].c)).toBe(1);
    expect(await columnExists(db, "layout_events", "screen_name")).toBe(true);
  });

  test("screen_name is nullable", async () => {
    await layoutEventsScreenNameMigration.up(db);
    await expect(
      sql`INSERT INTO layout_events (timestamp, sub_type) VALUES (1000, 'recomposition')`.execute(
        db,
      ),
    ).resolves.toBeDefined();
  });

  test("down removes screen_name column", async () => {
    await layoutEventsScreenNameMigration.up(db);
    await layoutEventsScreenNameMigration.down(db);
    expect(await columnExists(db, "layout_events", "screen_name")).toBe(false);
  });
});

describe("2026_03_20_000_network_event_details migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createDb();
    await telemetryMigration.up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up adds detail columns to network_events", async () => {
    for (const col of [
      "request_headers_json",
      "response_headers_json",
      "request_body",
      "response_body",
      "content_type",
    ]) {
      expect(await columnExists(db, "network_events", col)).toBe(false);
    }

    await networkEventDetailsMigration.up(db);

    for (const col of [
      "request_headers_json",
      "response_headers_json",
      "request_body",
      "response_body",
      "content_type",
    ]) {
      expect(await columnExists(db, "network_events", col)).toBe(true);
    }
  });

  test("up is idempotent: a second up() preserves existing rows and keeps the columns", async () => {
    await networkEventDetailsMigration.up(db);
    await sql`INSERT INTO network_events (timestamp, url, method) VALUES (1000, 'https://example.com', 'GET')`.execute(
      db,
    );

    await expect(networkEventDetailsMigration.up(db)).resolves.toBeUndefined();

    const count = await sql<{ c: number }>`SELECT count(*) AS c FROM network_events`.execute(db);
    expect(Number(count.rows[0].c)).toBe(1);
    expect(await columnExists(db, "network_events", "content_type")).toBe(true);
  });

  test("all new columns are nullable", async () => {
    await networkEventDetailsMigration.up(db);
    await expect(
      sql`INSERT INTO network_events (timestamp, url, method, status_code, duration_ms) VALUES (1000, 'https://example.com', 'GET', 200, 10)`.execute(
        db,
      ),
    ).resolves.toBeDefined();
  });

  test("down is a no-op (SQLite cannot drop columns)", async () => {
    await networkEventDetailsMigration.up(db);
    await expect(networkEventDetailsMigration.down(db)).resolves.toBeUndefined();
    for (const col of [
      "request_headers_json",
      "response_headers_json",
      "request_body",
      "response_body",
      "content_type",
    ]) {
      expect(await columnExists(db, "network_events", col)).toBe(true);
    }
  });
});

describe("2026_04_01_000_drop_custom_events migration", () => {
  let db: Kysely<unknown>;

  beforeEach(async () => {
    db = createDb();
    await telemetryMigration.up(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("up drops custom_events table", async () => {
    expect(await tableExists(db, "custom_events")).toBe(true);
    await dropCustomEventsMigration.up(db);
    expect(await tableExists(db, "custom_events")).toBe(false);
  });

  test("up is idempotent when table already absent", async () => {
    await dropCustomEventsMigration.up(db);
    await expect(dropCustomEventsMigration.up(db)).resolves.toBeUndefined();
  });

  test("down recreates custom_events table", async () => {
    await dropCustomEventsMigration.up(db);
    await dropCustomEventsMigration.down(db);
    expect(await tableExists(db, "custom_events")).toBe(true);
  });

  test("down-recreated custom_events has required columns", async () => {
    await dropCustomEventsMigration.up(db);
    await dropCustomEventsMigration.down(db);

    for (const col of ["id", "device_id", "timestamp", "name", "properties_json", "created_at"]) {
      expect(await columnExists(db, "custom_events", col)).toBe(true);
    }
  });

  test("other telemetry tables are unaffected by the migration", async () => {
    await dropCustomEventsMigration.up(db);
    expect(await tableExists(db, "network_events")).toBe(true);
    expect(await tableExists(db, "log_events")).toBe(true);
    expect(await tableExists(db, "os_events")).toBe(true);
  });
});

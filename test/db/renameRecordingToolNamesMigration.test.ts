import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { up as createFlags } from "../../src/db/migrations/2026_01_03_000_feature_flags";
import { up as createOverrides } from "../../src/db/migrations/2026_08_22_001_session_tool_overrides";
import { up, down } from "../../src/db/migrations/2026_10_12_000_rename_recording_tool_names";

describe("recording tool name migration", () => {
  let bunDb: BunDatabase;
  let db: Kysely<unknown>;

  beforeEach(async () => {
    bunDb = new BunDatabase(":memory:");
    db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: bunDb }) });
    await createFlags(db);
    await createOverrides(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  test("up renames the flag and preserves its data and unrelated rows", async () => {
    await sql`INSERT INTO feature_flags (key, enabled, config_json, created_at, updated_at)
      VALUES ('mcp-recording', 1, '{"capture":true}', 'created', 'updated'),
             ('other', 0, NULL, 'created-other', 'updated-other')`.execute(db);
    await up(db);
    expect(bunDb.query("SELECT * FROM feature_flags ORDER BY key").all()).toEqual([
      {
        key: "other",
        enabled: 0,
        config_json: null,
        created_at: "created-other",
        updated_at: "updated-other",
      },
      {
        key: "tool-call-recording",
        enabled: 1,
        config_json: '{"capture":true}',
        created_at: "created",
        updated_at: "updated",
      },
    ]);
  });

  test("up renames both overrides per session and preserves other rows", async () => {
    await sql`INSERT INTO session_tool_overrides (session_uuid, tool_name, enabled, updated_at)
      VALUES ('a', 'recordSteps', 1, 'updated-a'), ('a', 'startTestRecording', 0, 'updated-b'),
             ('b', 'recordSteps', 0, 'updated-c'), ('a', 'observe', 1, 'updated-other')`.execute(
      db,
    );
    await up(db);
    expect(
      bunDb.query("SELECT * FROM session_tool_overrides ORDER BY session_uuid, tool_name").all(),
    ).toEqual([
      { session_uuid: "a", tool_name: "observe", enabled: 1, updated_at: "updated-other" },
      { session_uuid: "a", tool_name: "recordDeviceGestures", enabled: 0, updated_at: "updated-b" },
      { session_uuid: "a", tool_name: "recordToolCalls", enabled: 1, updated_at: "updated-a" },
      { session_uuid: "b", tool_name: "recordToolCalls", enabled: 0, updated_at: "updated-c" },
    ]);
  });

  test("up keeps destination rows on flag and per-session override conflicts", async () => {
    await sql`INSERT INTO feature_flags (key, enabled, config_json)
      VALUES ('mcp-recording', 1, 'old'), ('tool-call-recording', 0, 'new')`.execute(db);
    await sql`INSERT INTO session_tool_overrides (session_uuid, tool_name, enabled, updated_at)
      VALUES ('a', 'recordSteps', 1, 'old'), ('a', 'recordToolCalls', 0, 'new'),
             ('a', 'startTestRecording', 0, 'old'), ('a', 'recordDeviceGestures', 1, 'new'),
             ('b', 'recordSteps', 1, 'other-session')`.execute(db);
    await up(db);
    expect(bunDb.query("SELECT key, enabled, config_json FROM feature_flags").all()).toEqual([
      { key: "tool-call-recording", enabled: 0, config_json: "new" },
    ]);
    expect(
      bunDb.query("SELECT * FROM session_tool_overrides ORDER BY session_uuid, tool_name").all(),
    ).toEqual([
      { session_uuid: "a", tool_name: "recordDeviceGestures", enabled: 1, updated_at: "new" },
      { session_uuid: "a", tool_name: "recordToolCalls", enabled: 0, updated_at: "new" },
      { session_uuid: "b", tool_name: "recordToolCalls", enabled: 1, updated_at: "other-session" },
    ]);
  });

  test("down reverses both names and preserves data and unrelated rows", async () => {
    await sql`INSERT INTO feature_flags (key, enabled, config_json)
      VALUES ('tool-call-recording', 1, 'config'), ('other', 0, NULL)`.execute(db);
    await sql`INSERT INTO session_tool_overrides (session_uuid, tool_name, enabled, updated_at)
      VALUES ('a', 'recordToolCalls', 0, 'calls'), ('a', 'recordDeviceGestures', 1, 'gestures'),
             ('a', 'observe', 1, 'other')`.execute(db);
    await down(db);
    expect(
      bunDb.query("SELECT key, enabled, config_json FROM feature_flags ORDER BY key").all(),
    ).toEqual([
      { key: "mcp-recording", enabled: 1, config_json: "config" },
      { key: "other", enabled: 0, config_json: null },
    ]);
    expect(bunDb.query("SELECT * FROM session_tool_overrides ORDER BY tool_name").all()).toEqual([
      { session_uuid: "a", tool_name: "observe", enabled: 1, updated_at: "other" },
      { session_uuid: "a", tool_name: "recordSteps", enabled: 0, updated_at: "calls" },
      { session_uuid: "a", tool_name: "startTestRecording", enabled: 1, updated_at: "gestures" },
    ]);
  });

  test("down keeps destination rows on both table conflicts", async () => {
    await sql`INSERT INTO feature_flags (key, enabled, config_json)
      VALUES ('tool-call-recording', 1, 'old'), ('mcp-recording', 0, 'new')`.execute(db);
    await sql`INSERT INTO session_tool_overrides (session_uuid, tool_name, enabled, updated_at)
      VALUES ('a', 'recordToolCalls', 1, 'old'), ('a', 'recordSteps', 0, 'new'),
             ('a', 'recordDeviceGestures', 0, 'old'), ('a', 'startTestRecording', 1, 'new'),
             ('b', 'recordDeviceGestures', 1, 'other-session')`.execute(db);
    await down(db);
    expect(bunDb.query("SELECT key, enabled, config_json FROM feature_flags").all()).toEqual([
      { key: "mcp-recording", enabled: 0, config_json: "new" },
    ]);
    expect(
      bunDb.query("SELECT * FROM session_tool_overrides ORDER BY session_uuid, tool_name").all(),
    ).toEqual([
      { session_uuid: "a", tool_name: "recordSteps", enabled: 0, updated_at: "new" },
      { session_uuid: "a", tool_name: "startTestRecording", enabled: 1, updated_at: "new" },
      {
        session_uuid: "b",
        tool_name: "startTestRecording",
        enabled: 1,
        updated_at: "other-session",
      },
    ]);
  });
});

import { type Kysely, sql } from "kysely";

/**
 * Phase 1 of the (app, build) navigation model (#4837, issue #4984).
 *
 * Adds a build-key provenance dimension to the app-level union navigation graph.
 * The union tables (navigation_apps / navigation_nodes / navigation_edges) are
 * left untouched — the build key is provenance ON each node/edge, recorded as
 * separate observation rows, NOT a separate-graph partition. A node/edge can have
 * many observation records (reached by many builds/devices/sessions).
 *
 * Backward-compat (AC4): existing single-build rows are backfilled to a DEFAULT
 * build key per app (version_code=0, content_hash='') with non-null legacy
 * sentinels for device_id/session_uuid, so today's behavior falls out as the
 * degenerate one-build case with no data loss.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // Build-key dimension: (packageId=app_id, versionCode, contentHash). Normalized
  // so observation rows carry a cheap int reference instead of repeating strings.
  await db.schema
    .createTable("navigation_build_keys")
    .ifNotExists()
    .addColumn("id", "integer", col => col.primaryKey().autoIncrement())
    .addColumn("app_id", "text", col =>
      col.notNull().references("navigation_apps.app_id").onDelete("cascade")
    )
    .addColumn("version_code", "integer", col => col.notNull())
    .addColumn("content_hash", "text", col => col.notNull())
    .addColumn("created_at", "text", col => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_navigation_build_keys_unique")
    .ifNotExists()
    .on("navigation_build_keys")
    .columns(["app_id", "version_code", "content_hash"])
    .unique()
    .execute();

  // Per-node observation records: {buildKey, deviceId, sessionUuid, firstSeen, lastSeen}.
  await db.schema
    .createTable("navigation_node_observations")
    .ifNotExists()
    .addColumn("id", "integer", col => col.primaryKey().autoIncrement())
    .addColumn("node_id", "integer", col =>
      col.notNull().references("navigation_nodes.id").onDelete("cascade")
    )
    .addColumn("build_key_id", "integer", col =>
      col.notNull().references("navigation_build_keys.id").onDelete("cascade")
    )
    .addColumn("device_id", "text", col => col.notNull())
    .addColumn("session_uuid", "text", col => col.notNull())
    .addColumn("first_seen_at", "integer", col => col.notNull())
    .addColumn("last_seen_at", "integer", col => col.notNull())
    .addColumn("created_at", "text", col => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_navigation_node_observations_unique")
    .ifNotExists()
    .on("navigation_node_observations")
    .columns(["node_id", "build_key_id", "device_id", "session_uuid"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_navigation_node_observations_build")
    .ifNotExists()
    .on("navigation_node_observations")
    .column("build_key_id")
    .execute();

  await db.schema
    .createIndex("idx_navigation_node_observations_device")
    .ifNotExists()
    .on("navigation_node_observations")
    .column("device_id")
    .execute();

  // Per-edge observation records (symmetric to nodes).
  await db.schema
    .createTable("navigation_edge_observations")
    .ifNotExists()
    .addColumn("id", "integer", col => col.primaryKey().autoIncrement())
    .addColumn("edge_id", "integer", col =>
      col.notNull().references("navigation_edges.id").onDelete("cascade")
    )
    .addColumn("build_key_id", "integer", col =>
      col.notNull().references("navigation_build_keys.id").onDelete("cascade")
    )
    .addColumn("device_id", "text", col => col.notNull())
    .addColumn("session_uuid", "text", col => col.notNull())
    .addColumn("first_seen_at", "integer", col => col.notNull())
    .addColumn("last_seen_at", "integer", col => col.notNull())
    .addColumn("created_at", "text", col => col.notNull().defaultTo(sql`(datetime('now'))`))
    .execute();

  await db.schema
    .createIndex("idx_navigation_edge_observations_unique")
    .ifNotExists()
    .on("navigation_edge_observations")
    .columns(["edge_id", "build_key_id", "device_id", "session_uuid"])
    .unique()
    .execute();

  await db.schema
    .createIndex("idx_navigation_edge_observations_build")
    .ifNotExists()
    .on("navigation_edge_observations")
    .column("build_key_id")
    .execute();

  await db.schema
    .createIndex("idx_navigation_edge_observations_device")
    .ifNotExists()
    .on("navigation_edge_observations")
    .column("device_id")
    .execute();

  // --- Backfill (AC4): one DEFAULT build key per app, one observation per row. ---
  // Kysely's SqliteAdapter reports supportsTransactionalDdl = false, so this up()
  // is NOT wrapped in a transaction. If a later statement fails after an earlier
  // insert, the migration is not recorded and reruns from the top — so every
  // backfill uses INSERT OR IGNORE (safe against its UNIQUE index) to stay
  // idempotent and retry-safe rather than wedging on a duplicate-key violation.
  await sql`
    INSERT OR IGNORE INTO navigation_build_keys (app_id, version_code, content_hash)
    SELECT app_id, 0, '' FROM navigation_apps
  `.execute(db);

  await sql`
    INSERT OR IGNORE INTO navigation_node_observations
      (node_id, build_key_id, device_id, session_uuid, first_seen_at, last_seen_at)
    SELECT n.id, bk.id, 'legacy', 'legacy', n.first_seen_at, n.last_seen_at
    FROM navigation_nodes n
    JOIN navigation_build_keys bk
      ON bk.app_id = n.app_id AND bk.version_code = 0 AND bk.content_hash = ''
  `.execute(db);

  await sql`
    INSERT OR IGNORE INTO navigation_edge_observations
      (edge_id, build_key_id, device_id, session_uuid, first_seen_at, last_seen_at)
    SELECT e.id, bk.id, 'legacy', 'legacy', e.timestamp, e.timestamp
    FROM navigation_edges e
    JOIN navigation_build_keys bk
      ON bk.app_id = e.app_id AND bk.version_code = 0 AND bk.content_hash = ''
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("navigation_edge_observations").execute();
  await db.schema.dropTable("navigation_node_observations").execute();
  await db.schema.dropTable("navigation_build_keys").execute();
}

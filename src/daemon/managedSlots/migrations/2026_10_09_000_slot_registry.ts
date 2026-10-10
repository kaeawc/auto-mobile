import { sql, type Kysely } from "kysely";

// #11174: host-wide managed-slot registry. Lives in its own SQLite file (never the per-daemon
// auto-mobile.db) so every daemon that can address the same devices shares one authority.
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("slot_scopes")
    .ifNotExists()
    .addColumn("scope_key", "text", (column) => column.primaryKey())
    .addColumn("managed_host_scope", "text", (column) => column.notNull())
    .addColumn("runner_namespace", "text", (column) => column.notNull())
    .addColumn("runner_incarnation", "text", (column) => column.notNull())
    .addColumn("state", "text", (column) =>
      column.notNull().check(sql`state IN ('valid', 'invalidating', 'invalidated')`),
    )
    .addColumn("invalidation_reason", "text", (column) =>
      column.check(
        sql`invalidation_reason IS NULL OR invalidation_reason IN ('incarnation_reset', 'operator_reset', 'abandoned')`,
      ),
    )
    .addColumn("created_at_ms", "integer", (column) => column.notNull())
    .addColumn("last_acquired_at_ms", "integer", (column) => column.notNull())
    .addColumn("invalidating_at_ms", "integer")
    .addColumn("invalidated_at_ms", "integer")
    .execute();

  // One live incarnation per (host, namespace): a new incarnation waits for the old to be invalidated.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS slot_scopes_live_namespace
    ON slot_scopes (managed_host_scope, runner_namespace)
    WHERE state <> 'invalidated'`.execute(db);

  await db.schema
    .createTable("slot_assignments")
    .ifNotExists()
    .addColumn("scope_key", "text", (column) =>
      column.notNull().references("slot_scopes.scope_key"),
    )
    .addColumn("slot_index", "integer", (column) => column.notNull().check(sql`slot_index >= 0`))
    .addColumn("role", "text", (column) => column.notNull())
    .addColumn("platform", "text", (column) =>
      column.notNull().check(sql`platform IN ('android', 'ios')`),
    )
    .addColumn("generation", "integer", (column) => column.notNull().check(sql`generation >= 0`))
    .addColumn("stable_device_id", "text")
    .addColumn("device_name", "text")
    .addColumn("requested_spec_json", "text", (column) => column.notNull())
    .addColumn("resolved_spec_json", "text")
    .addColumn("spec_fingerprint", "text")
    .addColumn("state", "text", (column) =>
      column
        .notNull()
        .check(sql`state IN ('provisioning', 'ready', 'replacing', 'cleanup_pending')`),
    )
    .addColumn("exec_owner_daemon_id", "text")
    .addColumn("exec_owner_pid", "integer")
    .addColumn("exec_session_uuid", "text")
    .addColumn("updated_at_ms", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("slot_assignments_pk", ["scope_key", "slot_index"])
    .execute();

  // One device, one slot.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS slot_assignments_device
    ON slot_assignments (platform, stable_device_id)
    WHERE stable_device_id IS NOT NULL`.execute(db);

  await db.schema
    .createTable("slot_free_devices")
    .ifNotExists()
    .addColumn("platform", "text", (column) =>
      column.notNull().check(sql`platform IN ('android', 'ios')`),
    )
    .addColumn("stable_device_id", "text", (column) => column.notNull())
    .addColumn("spec_fingerprint", "text")
    .addColumn("from_scope_key", "text", (column) => column.notNull())
    .addColumn("freed_at_ms", "integer", (column) => column.notNull())
    .addPrimaryKeyConstraint("slot_free_devices_pk", ["platform", "stable_device_id"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("slot_free_devices").ifExists().execute();
  await db.schema.dropTable("slot_assignments").ifExists().execute();
  await db.schema.dropTable("slot_scopes").ifExists().execute();
}

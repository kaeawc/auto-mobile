import { sql, type Kysely } from "kysely";

const ASSIGNMENT_COLUMNS_000 = sql.raw(
  [
    "scope_key",
    "slot_index",
    "role",
    "platform",
    "generation",
    "stable_device_id",
    "device_name",
    "requested_spec_json",
    "resolved_spec_json",
    "spec_fingerprint",
    "state",
    "exec_owner_daemon_id",
    "exec_owner_pid",
    "exec_session_uuid",
    "updated_at_ms",
  ].join(", "),
);

// #11242: harden the managed-slot registry before the acquire RPC wires it.
// - exec_owner_process_token: the owner's process-generation token, so a reused PID is not live.
// - state 'settling' + settler_*: a released execution's unsettled work, distinct from a failed
//   deletion ('cleanup_pending'), with the settling daemon recorded so a restart can recover it.
// - slot_scopes.last_released_at_ms: the abandonment clock runs from the last execution release,
//   not only the last acquisition, so a long execution's scope is not abandoned soon after it ends.
// SQLite cannot alter a CHECK constraint, so slot_assignments is rebuilt.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_scopes ADD COLUMN last_released_at_ms INTEGER`.execute(db);
  await sql`CREATE TABLE slot_assignments_v2 (
    scope_key TEXT NOT NULL REFERENCES slot_scopes (scope_key),
    slot_index INTEGER NOT NULL CHECK (slot_index >= 0),
    role TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    stable_device_id TEXT,
    device_name TEXT,
    requested_spec_json TEXT NOT NULL,
    resolved_spec_json TEXT,
    spec_fingerprint TEXT,
    state TEXT NOT NULL
      CHECK (state IN ('provisioning', 'ready', 'replacing', 'settling', 'cleanup_pending')),
    exec_owner_daemon_id TEXT,
    exec_owner_pid INTEGER,
    exec_owner_process_token TEXT,
    exec_session_uuid TEXT,
    settler_daemon_id TEXT,
    settler_pid INTEGER,
    settler_process_token TEXT,
    updated_at_ms INTEGER NOT NULL,
    CONSTRAINT slot_assignments_pk PRIMARY KEY (scope_key, slot_index)
  )`.execute(db);
  await sql`INSERT INTO slot_assignments_v2 (${ASSIGNMENT_COLUMNS_000})
    SELECT ${ASSIGNMENT_COLUMNS_000} FROM slot_assignments`.execute(db);
  await sql`DROP TABLE slot_assignments`.execute(db);
  await sql`ALTER TABLE slot_assignments_v2 RENAME TO slot_assignments`.execute(db);
  // One device, one slot.
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS slot_assignments_device
    ON slot_assignments (platform, stable_device_id)
    WHERE stable_device_id IS NOT NULL`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE slot_scopes DROP COLUMN last_released_at_ms`.execute(db);
  await sql`CREATE TABLE slot_assignments_v1 (
    scope_key TEXT NOT NULL REFERENCES slot_scopes (scope_key),
    slot_index INTEGER NOT NULL CHECK (slot_index >= 0),
    role TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
    generation INTEGER NOT NULL CHECK (generation >= 0),
    stable_device_id TEXT,
    device_name TEXT,
    requested_spec_json TEXT NOT NULL,
    resolved_spec_json TEXT,
    spec_fingerprint TEXT,
    state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'replacing', 'cleanup_pending')),
    exec_owner_daemon_id TEXT,
    exec_owner_pid INTEGER,
    exec_session_uuid TEXT,
    updated_at_ms INTEGER NOT NULL,
    CONSTRAINT slot_assignments_pk PRIMARY KEY (scope_key, slot_index)
  )`.execute(db);
  // A settling slot's device is fine; it was ready before its execution was released.
  await sql`INSERT INTO slot_assignments_v1 (${ASSIGNMENT_COLUMNS_000})
    SELECT scope_key, slot_index, role, platform, generation, stable_device_id, device_name,
      requested_spec_json, resolved_spec_json, spec_fingerprint,
      CASE state WHEN 'settling' THEN 'ready' ELSE state END,
      exec_owner_daemon_id, exec_owner_pid, exec_session_uuid, updated_at_ms
    FROM slot_assignments`.execute(db);
  await sql`DROP TABLE slot_assignments`.execute(db);
  await sql`ALTER TABLE slot_assignments_v1 RENAME TO slot_assignments`.execute(db);
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS slot_assignments_device
    ON slot_assignments (platform, stable_device_id)
    WHERE stable_device_id IS NOT NULL`.execute(db);
}

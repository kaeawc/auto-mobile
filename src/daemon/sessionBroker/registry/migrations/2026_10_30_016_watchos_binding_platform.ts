import { sql, type Kysely, type RawBuilder } from "kysely";
import { ActionableError } from "../../../../models/ActionableError";

/**
 * #15882: Apple Watch simulators join the shared managed-device limit, so a binding, its journal
 * and a device claim may name `watchos`. SQLite cannot alter a CHECK constraint, so each table with
 * a platform CHECK is rebuilt (as 001 rebuilt slot_assignments) with every row, index and the
 * journal's AUTOINCREMENT high-water mark carried over.
 */

type PlatformCheck = RawBuilder<unknown>;

const WIDE: PlatformCheck = sql`platform IN ('android', 'ios', 'watchos')`;
const NARROW: PlatformCheck = sql`platform IN ('android', 'ios')`;

const ASSIGNMENT_COLUMNS = sql.raw(
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
    "exec_owner_process_token",
    "exec_session_uuid",
    "settler_daemon_id",
    "settler_pid",
    "settler_process_token",
    "updated_at_ms",
  ].join(", "),
);

const JOURNAL_COLUMNS = sql.raw(
  [
    "id",
    "scope_key",
    "slot_index",
    "kind",
    "phase",
    "platform",
    "from_generation",
    "to_generation",
    "binding_generation",
    "binding_stable_device_id",
    "target_json",
    "owner_daemon_id",
    "owner_pid",
    "owner_process_token",
    "attempts",
    "last_error",
    "next_attempt_at_ms",
    "created_at_ms",
    "updated_at_ms",
  ].join(", "),
);

const CLAIM_COLUMNS = sql.raw(
  [
    "platform",
    "device_id",
    "kind",
    "daemon_session_id",
    "pid",
    "owner_token",
    "process_generation_token",
    "session_uuid",
    "claimed_at_ms",
    "updated_at_ms",
    "metadata",
  ].join(", "),
);

async function rebuildAssignments(db: Kysely<unknown>, check: PlatformCheck): Promise<void> {
  await sql`CREATE TABLE slot_assignments_next (
    scope_key TEXT NOT NULL REFERENCES slot_scopes (scope_key),
    slot_index INTEGER NOT NULL CHECK (slot_index >= 0),
    role TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (${check}),
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
  await sql`INSERT INTO slot_assignments_next (${ASSIGNMENT_COLUMNS})
    SELECT ${ASSIGNMENT_COLUMNS} FROM slot_assignments`.execute(db);
  await sql`DROP TABLE slot_assignments`.execute(db);
  await sql`ALTER TABLE slot_assignments_next RENAME TO slot_assignments`.execute(db);
  // One device, one binding.
  await sql`CREATE UNIQUE INDEX slot_assignments_device
    ON slot_assignments (platform, stable_device_id)
    WHERE stable_device_id IS NOT NULL`.execute(db);
}

async function rebuildJournal(db: Kysely<unknown>, check: PlatformCheck): Promise<void> {
  // Ids are never reused: keep the AUTOINCREMENT high-water mark, not only the highest live id.
  const sequence = await sql<{
    seq: number;
  }>`SELECT seq FROM sqlite_sequence WHERE name = 'slot_journal'`.execute(db);
  await sql`CREATE TABLE slot_journal_next (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_key TEXT NOT NULL REFERENCES slot_scopes (scope_key),
    slot_index INTEGER NOT NULL CHECK (slot_index >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('create', 'replace', 'release')),
    phase TEXT NOT NULL CHECK (
      phase IN ('intent', 'deleting', 'deleted', 'creating', 'created', 'committed', 'rolled_back')
    ),
    platform TEXT NOT NULL CHECK (${check}),
    from_generation INTEGER NOT NULL,
    to_generation INTEGER,
    binding_generation INTEGER NOT NULL,
    binding_stable_device_id TEXT,
    target_json TEXT NOT NULL,
    owner_daemon_id TEXT NOT NULL,
    owner_pid INTEGER NOT NULL,
    owner_process_token TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`.execute(db);
  await sql`INSERT INTO slot_journal_next (${JOURNAL_COLUMNS})
    SELECT ${JOURNAL_COLUMNS} FROM slot_journal`.execute(db);
  await sql`DROP TABLE slot_journal`.execute(db);
  await sql`ALTER TABLE slot_journal_next RENAME TO slot_journal`.execute(db);
  const highWater = sequence.rows[0]?.seq;
  if (highWater !== undefined) {
    await sql`DELETE FROM sqlite_sequence WHERE name = 'slot_journal'`.execute(db);
    await sql`INSERT INTO sqlite_sequence (name, seq)
      VALUES ('slot_journal', MAX(${highWater}, COALESCE((SELECT MAX(id) FROM slot_journal), 0)))`.execute(
      db,
    );
  }
  // At most one unfinished entry per binding.
  await sql`CREATE UNIQUE INDEX slot_journal_open_slot
    ON slot_journal (scope_key, slot_index)
    WHERE phase NOT IN ('committed', 'rolled_back')`.execute(db);
}

async function rebuildClaims(db: Kysely<unknown>, check: PlatformCheck): Promise<void> {
  await sql`CREATE TABLE device_claims_next (
    platform TEXT NOT NULL,
    device_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    daemon_session_id TEXT,
    pid INTEGER NOT NULL,
    owner_token TEXT NOT NULL,
    process_generation_token TEXT,
    session_uuid TEXT,
    claimed_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    metadata TEXT,
    CONSTRAINT device_claims_device PRIMARY KEY (platform, device_id),
    CONSTRAINT device_claims_platform CHECK (${check}),
    CONSTRAINT device_claims_kind CHECK (kind IN ('allocation', 'forward', 'slot')),
    CONSTRAINT device_claims_nonempty
      CHECK (length(trim(device_id)) > 0 AND length(trim(owner_token)) > 0 AND pid > 0)
  )`.execute(db);
  await sql`INSERT INTO device_claims_next (${CLAIM_COLUMNS})
    SELECT ${CLAIM_COLUMNS} FROM device_claims`.execute(db);
  await sql`DROP TABLE device_claims`.execute(db);
  await sql`ALTER TABLE device_claims_next RENAME TO device_claims`.execute(db);
}

async function rebuildAll(db: Kysely<unknown>, check: PlatformCheck): Promise<void> {
  await rebuildAssignments(db, check);
  await rebuildJournal(db, check);
  await rebuildClaims(db, check);
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await rebuildAll(db, WIDE);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  const watch = await sql<{ present: number }>`SELECT
    EXISTS(SELECT 1 FROM slot_assignments WHERE platform = 'watchos')
    OR EXISTS(SELECT 1 FROM slot_journal WHERE platform = 'watchos')
    OR EXISTS(SELECT 1 FROM device_claims WHERE platform = 'watchos') AS present`.execute(db);
  if (watch.rows[0]?.present) {
    throw new ActionableError(
      "The binding registry holds Apple Watch rows; release those bindings and claims before downgrading.",
    );
  }
  await rebuildAll(db, NARROW);
}

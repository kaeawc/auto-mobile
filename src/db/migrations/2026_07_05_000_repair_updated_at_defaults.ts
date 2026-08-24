import { type Kysely, sql } from "kysely";

/**
 * #2937 — give eight tables' `updated_at` columns their `(datetime('now'))`
 * default on already-upgraded databases.
 *
 * PR #2922 (issue #2913) reconciled the schema by adding
 * `.defaultTo(sql`(datetime('now'))`)` to these eight tables' `updated_at`
 * migration declarations, matching their `created_at` sibling. But editing a
 * historical migration body does NOT re-run it — Kysely tracks executed
 * migrations by name, with no content checksum — so the added default lands only
 * on FRESH/replayed databases. A database that already ran the pre-#2922
 * migrations keeps the old `updated_at TEXT NOT NULL` column with no default,
 * and a defaulted insert (one that omits `updated_at`) fails its NOT NULL
 * constraint there.
 *
 * This mirrors the `created_at` situation before #2915, minus the live bug:
 * `created_at` had a broken string-literal default actively poisoning new rows,
 * which the {@link file://./2026_07_03_000_repair_datetime_now_defaults.ts}
 * rebuild repaired. `updated_at` has no such poison — every current writer
 * supplies it explicitly — so this migration only needs to REBUILD each column's
 * default; the existing rows already hold real, explicitly-written timestamps and
 * are copied through untouched (no row repair).
 *
 * REBUILD MECHANICS — identical to the #2915 repair: SQLite cannot alter a column
 * default in place, and bun:sqlite forbids editing `sqlite_master` directly, so
 * each table is rebuilt via a twin: create a twin whose `updated_at` carries the
 * corrected default, copy the rows with `INSERT ... SELECT *`, drop the original,
 * rename the twin back, replay the table's explicit indexes/triggers, and restore
 * its `sqlite_sequence` AUTOINCREMENT high-water mark (so a rebuilt table cannot
 * reuse a deleted top id). FK enforcement is toggled OFF around the transaction so
 * dropping a referenced parent (e.g. `navigation_apps`) cannot cascade-delete its
 * children.
 *
 * TARGETING — the eight tables are enumerated in {@link TABLES_WITH_DEFAULTED_UPDATED_AT}
 * (exactly the set #2922 edited), and each is rebuilt only when its live
 * `updated_at` default is absent. Detection reads
 * `pragma_table_info(...).dflt_value`: `NULL` means the no-default upgraded column
 * (rebuild it); the corrected default reports as `datetime('now')` and is skipped.
 * `device_sessions` / `failure_groups` are deliberately NOT listed — their
 * `updated_at` default has existed on every database since #2915 repaired the
 * broken literal they originally shipped, so they need no rebuild.
 *
 * Safe on a fresh DB and idempotent: a fresh/replayed or already-rebuilt schema
 * carries the default, so nothing matches and the whole pass is a no-op that never
 * touches FK state. A second run finds every column already defaulted.
 */

/**
 * The eight tables whose `updated_at` default was added by PR #2922 (a migration
 * edit that does not replay), so an upgraded DB's copy still lacks it. Ordered
 * arbitrarily; each is independently rebuilt.
 */
const TABLES_WITH_DEFAULTED_UPDATED_AT = [
  "device_configs",
  "navigation_apps",
  "prediction_transition_stats",
  "accessibility_baselines",
  "feature_flags",
  "video_recording_configs",
  "device_snapshot_configs",
  "appearance_configs",
] as const;

/** The corrected default expression `updated_at` should carry, as raw SQL. */
const CORRECTED_DEFAULT = "(datetime('now'))";

interface ColumnInfoRow {
  name: string;
  dflt_value: string | null;
}

interface SqlRow {
  sql: string | null;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Fast path: only the tables whose `updated_at` column exists AND has no
  // default need a rebuild. On a fresh/already-fixed schema this is empty, so we
  // return WITHOUT touching PRAGMA foreign_keys — leaving the connection's FK
  // state exactly as the caller set it, as the common case (every existing DB and
  // test) requires. Only the rare upgraded-DB path below toggles it.
  const tablesToRebuild: string[] = [];
  for (const table of TABLES_WITH_DEFAULTED_UPDATED_AT) {
    if (await updatedAtLacksDefault(db, table)) {
      tablesToRebuild.push(table);
    }
  }
  if (tablesToRebuild.length === 0) {
    return;
  }

  // Rebuilding a table that OTHER tables reference by foreign key requires FK
  // enforcement OFF: `DROP TABLE` performs an implicit DELETE that would otherwise
  // fire `ON DELETE CASCADE` and wipe the child rows (deferral only delays the
  // constraint *check*, not the cascade *action*). `PRAGMA foreign_keys` is a
  // no-op inside a transaction, so it is toggled on the connection around the
  // transaction — safe because the migrator does not wrap SQLite migrations in a
  // transaction and the run is serialized by the migration lock. Restored to ON
  // afterwards, the state `configureSqliteDatabase` and the rest of the chain
  // expect on the production connection.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    // One transaction so a mid-rebuild failure cannot leave a half-swapped schema.
    await db.transaction().execute(async (trx) => {
      for (const table of tablesToRebuild) {
        await rebuildTableWithUpdatedAtDefault(trx, table);
      }
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

/**
 * True when `table` exists and its `updated_at` column is present with NO stored
 * default (the pre-#2922 upgraded-DB shape). A corrected `(datetime('now'))`
 * default reports its `dflt_value` as `datetime('now')` (non-null) and is skipped;
 * a missing table or column yields no matching row and is also skipped.
 *
 * The table name is inlined as a literal (`sql.lit`) rather than a bound
 * parameter: a parameterized `pragma_table_info(?)` read was observed to
 * intermittently return a null `dflt_value` under parallel-file load (a bun:sqlite
 * quirk, see #2922's test), which here — where null is the very signal that
 * triggers a rebuild — would spuriously rebuild a fresh table.
 */
async function updatedAtLacksDefault(db: Kysely<unknown>, table: string): Promise<boolean> {
  const columns = await sql<ColumnInfoRow>`
    SELECT name, dflt_value FROM pragma_table_info(${sql.lit(table)})
  `.execute(db);
  const updatedAt = columns.rows.find((column) => column.name === "updated_at");
  return updatedAt !== undefined && updatedAt.dflt_value === null;
}

/**
 * Rebuild `table` so its `updated_at` column gains the `(datetime('now'))`
 * default, preserving data, indexes, and triggers. Only the `updated_at` column's
 * `DEFAULT` clause changes; the column set and order are untouched, so
 * `INSERT ... SELECT *` lines the rows up 1:1.
 */
async function rebuildTableWithUpdatedAtDefault(
  trx: Kysely<unknown>,
  table: string,
): Promise<void> {
  const createRow = await sql<SqlRow>`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${table}
  `.execute(trx);
  const createSql = createRow.rows[0]?.sql;
  if (!createSql) {
    return;
  }

  const tempTable = `__rebuild_${table}`;
  const correctedSql = addUpdatedAtDefault(replaceFirstTableName(createSql, table, tempTable));

  // Capture the table's own indexes and triggers before the drop — auto-indexes
  // backing PRIMARY KEY / UNIQUE constraints have a NULL `sql` and are recreated
  // by the CREATE TABLE itself, so only the explicit ones need replaying.
  const auxiliary = await sql<SqlRow>`
    SELECT sql FROM sqlite_master
    WHERE tbl_name = ${table} AND type IN ('index', 'trigger') AND sql IS NOT NULL
  `.execute(trx);

  // Capture the AUTOINCREMENT high-water mark. `sqlite_sequence` records the
  // highest rowid EVER used so AUTOINCREMENT never reuses a deleted id; the
  // copy/drop/rename below would otherwise reset it to `max(current id)` and let a
  // deleted top id be handed out again. Restored after the rename.
  const originalSequence = await captureSequence(trx, table);

  await sql.raw(correctedSql).execute(trx);
  await sql`INSERT INTO ${sql.ref(tempTable)} SELECT * FROM ${sql.ref(table)}`.execute(trx);
  await sql`DROP TABLE ${sql.ref(table)}`.execute(trx);
  await sql`ALTER TABLE ${sql.ref(tempTable)} RENAME TO ${sql.ref(table)}`.execute(trx);
  for (const { sql: auxSql } of auxiliary.rows) {
    if (auxSql) {
      await sql.raw(auxSql).execute(trx);
    }
  }

  if (originalSequence !== undefined) {
    await sql`DELETE FROM sqlite_sequence WHERE name = ${table}`.execute(trx);
    await sql`INSERT INTO sqlite_sequence (name, seq) VALUES (${table}, ${originalSequence})`.execute(
      trx,
    );
  }
}

/**
 * Read a table's `sqlite_sequence` high-water mark, or `undefined` when the table
 * is not AUTOINCREMENT / has never been inserted into (no sequence row) or the
 * `sqlite_sequence` table does not exist (no AUTOINCREMENT table in the DB).
 */
async function captureSequence(trx: Kysely<unknown>, table: string): Promise<number | undefined> {
  const hasSequenceTable = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'
  `.execute(trx);
  if (hasSequenceTable.rows.length === 0) {
    return undefined;
  }
  const seqRow = await sql<{ seq: number }>`
    SELECT seq FROM sqlite_sequence WHERE name = ${table}
  `.execute(trx);
  return seqRow.rows[0]?.seq;
}

/**
 * Inject `default (datetime('now'))` into the `updated_at` column definition of a
 * `CREATE TABLE` statement, right after its type keyword. Matches only when the
 * column has no existing default (the type is immediately followed by `not null`),
 * so it is a no-op on a schema that already carries the default and never
 * double-adds. Only the first (and only) `"updated_at"` column definition is
 * rewritten.
 */
function addUpdatedAtDefault(createSql: string): string {
  return createSql.replace(
    /("updated_at"\s+\w+)(\s+not\s+null)/i,
    `$1 default ${CORRECTED_DEFAULT}$2`,
  );
}

/**
 * Replace the table name in a `CREATE TABLE` statement, tolerating the double-
 * quoted (Kysely) and bare forms and arbitrary whitespace after the keyword.
 * Only the first occurrence — the table being declared — is rewritten; a later
 * self-reference (e.g. a table-level FK) keeps pointing at the real name so the
 * copy still works.
 */
function replaceFirstTableName(createSql: string, from: string, to: string): string {
  return createSql.replace(
    /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"([^"]+)"|(\w+))/i,
    (match, prefix: string, quotedName: string | undefined, bareName: string | undefined) =>
      (quotedName ?? bareName) === from ? `${prefix}"${to}"` : match,
  );
}

export async function down(): Promise<void> {
  // Irreversible repair: the corrected default carries no information worth
  // reverting, so the down migration is intentionally a no-op.
}

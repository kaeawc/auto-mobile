import { type Kysely, sql } from "kysely";

/**
 * #2895 — repair the string-literal timestamp-default bug on already-migrated
 * databases.
 *
 * Every migration column that passed a plain SQL time-expression string to
 * `col.defaultTo(...)` — `"datetime('now')"` or `"CURRENT_TIMESTAMP"` — bound the
 * argument as a VALUE, not raw SQL, so its DDL emitted `DEFAULT 'datetime(''now'')'`
 * / `DEFAULT 'CURRENT_TIMESTAMP'`. Any row inserted without an explicit value for
 * such a column stored the useless literal text instead of a timestamp.
 *
 * The DDL is fixed FORWARD (all columns now use `defaultTo(sql`(datetime('now'))`)`),
 * so fresh databases are already correct. But a database that already ran the
 * buggy migrations keeps the broken `DEFAULT` in its stored schema — editing a
 * historical migration does NOT re-run it (Kysely tracks migrations by name, no
 * content checksum). So on an upgraded DB this migration must do TWO things:
 *
 *   1. REBUILD each column whose live default is the broken string literal, so
 *      FUTURE inserts that omit the column (e.g. `getOrCreateApp`, which omits
 *      `created_at`) stop re-poisoning it. SQLite cannot alter a column default
 *      in place, and bun:sqlite forbids editing `sqlite_master` directly, so we
 *      use the standard table-rebuild: create a twin table with the corrected
 *      default, copy the rows, drop the original, rename the twin back, recreate
 *      its indexes/triggers, and restore its `sqlite_sequence` AUTOINCREMENT
 *      high-water mark (so a rebuilt table cannot reuse a deleted top id). FK
 *      enforcement is toggled OFF around the
 *      rebuild (see `up`) so dropping a referenced parent cannot cascade-delete
 *      its children, then `PRAGMA foreign_key_check` verifies integrity before it
 *      is restored.
 *   2. REPAIR the existing poisoned rows in those columns to an evaluated
 *      timestamp.
 *
 * TARGETING — the fix keys off `pragma_table_info(...).dflt_value`, which reports
 * a column's stored default. Only the two broken string-literal forms match
 * ({@link BROKEN_DEFAULTS}); a corrected `(datetime('now'))` default, a bare
 * `CURRENT_TIMESTAMP` keyword, and legitimate value defaults (`'{}'`, `'success'`)
 * all report a different `dflt_value` and are skipped. This is deliberately
 * NARROWER than "rewrite any TEXT cell equal to the literal": columns like
 * `storage_events.value` persist arbitrary app data (an app could legitimately
 * store the string `datetime('now')`), so restricting the row repair to columns
 * that actually carry the broken default is what keeps it from corrupting real
 * data.
 *
 * The evaluated `datetime('now')` written for repaired rows is the best available
 * timestamp for a row that never had a real one (its true creation time is
 * unrecoverable). It is stored in SQLite's `YYYY-MM-DD HH:MM:SS` format — the same
 * format the fixed column defaults now emit and the codebase's other
 * server-evaluated-now writes use (`sql`datetime('now')`` in ThresholdManager /
 * MemoryThresholdManager) — rather than the app's ISO-8601. This divergence is
 * deliberate and harmless: no column is both defaulted AND written explicit ISO at
 * an ordered/compared read site (audited during #2895 review), and every TTL
 * comparison wraps the value in `datetime(...)`, which normalizes both formats.
 *
 * Safe on a fresh DB and idempotent: fresh/replayed schemas carry the corrected
 * default, so no column matches {@link BROKEN_DEFAULTS} and the whole pass is a
 * no-op. A second run finds nothing left to rebuild or repair.
 */

/**
 * A column's stored default (as reported by `pragma_table_info(...).dflt_value`)
 * mapped to the corrected default expression it should carry and the literal
 * value its poisoned rows hold. The `dflt_value` keys are the exact broken
 * string-literal forms — a correct `datetime('now')` / `CURRENT_TIMESTAMP`
 * default reports differently and never matches.
 */
const BROKEN_DEFAULTS: Record<string, { corrected: string; poisonedValue: string }> = {
  "'datetime(''now'')'": { corrected: "(datetime('now'))", poisonedValue: "datetime('now')" },
  "'CURRENT_TIMESTAMP'": { corrected: "CURRENT_TIMESTAMP", poisonedValue: "CURRENT_TIMESTAMP" },
};

interface NamedRow {
  name: string;
}

interface ColumnInfoRow {
  name: string;
  dflt_value: string | null;
}

interface SqlRow {
  sql: string | null;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Fast path: on a fresh/already-fixed schema no column carries a broken default,
  // so there is nothing to rebuild. Return WITHOUT touching PRAGMA foreign_keys so
  // the common case (every existing DB and test) leaves the connection's FK state
  // exactly as the caller set it. Only the rare upgraded-DB path below toggles it.
  const brokenTables = await findTablesWithBrokenDefaults(db);
  if (brokenTables.length === 0) {
    return;
  }

  // Rebuilding a table that OTHER tables reference by foreign key requires FK
  // enforcement OFF: `DROP TABLE` performs an implicit DELETE that would otherwise
  // fire `ON DELETE CASCADE` and wipe the child rows (deferral only delays the
  // constraint *check*, not the cascade *action*). `PRAGMA foreign_keys` is a
  // no-op inside a transaction, so it is toggled on the connection around the
  // transaction — safe because the migrator does not wrap SQLite migrations in a
  // transaction and the run is serialized by the migration lock. It is restored to
  // ON afterwards: this branch only runs on an upgraded production DB, whose
  // connection is configured FK-ON (`configureSqliteDatabase`), which is also the
  // state the rest of the migration chain expects.
  await sql`PRAGMA foreign_keys = OFF`.execute(db);
  try {
    // One transaction so a mid-rebuild failure cannot leave a half-swapped schema.
    await db.transaction().execute(async (trx) => {
      await rebuildAndRepair(trx, brokenTables);
    });
  } finally {
    await sql`PRAGMA foreign_keys = ON`.execute(db);
  }
}

/**
 * Return the tables that have at least one column whose stored default is a
 * broken string literal. Uses a `SELECT`-shaped `pragma_table_info(...)` read so
 * the bunSqliteDialect returns rows (a bare `PRAGMA x` value read does not).
 */
async function findTablesWithBrokenDefaults(db: Kysely<unknown>): Promise<string[]> {
  const tables = await sql<NamedRow>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `.execute(db);

  const broken: string[] = [];
  for (const { name: table } of tables.rows) {
    // Inline the table name as a literal (sql.lit), not a bound parameter: a
    // parameterized pragma_table_info(?) was observed to intermittently return a
    // null dflt_value under parallel-file load (bun:sqlite quirk, see #2922's
    // test). Here a spurious null on a genuinely-poisoned column would fail the
    // `!== null` guard below, so the column would never be added to the broken set
    // and its poisoned default would be silently skipped and never rebuilt (#3612).
    // Matches 2026_07_05_000_repair_updated_at_defaults.ts.
    const columns = await sql<ColumnInfoRow>`
      SELECT dflt_value FROM pragma_table_info(${sql.lit(table)})
    `.execute(db);
    if (
      columns.rows.some(
        (column) => column.dflt_value !== null && column.dflt_value in BROKEN_DEFAULTS,
      )
    ) {
      broken.push(table);
    }
  }
  return broken;
}

async function rebuildAndRepair(trx: Kysely<unknown>, tables: string[]): Promise<void> {
  for (const table of tables) {
    // sql.lit (not a bound param) for the same bun:sqlite null-dflt_value quirk
    // guarded in findTablesWithBrokenDefaults above (#2922 / #3612).
    const columns = await sql<ColumnInfoRow>`
      SELECT name, dflt_value FROM pragma_table_info(${sql.lit(table)})
    `.execute(trx);

    const brokenColumns = columns.rows.filter(
      (column) => column.dflt_value !== null && column.dflt_value in BROKEN_DEFAULTS,
    );
    if (brokenColumns.length === 0) {
      continue;
    }

    await rebuildTableWithCorrectedDefaults(trx, table);

    // Rows copied verbatim during the rebuild still hold the literal; heal them
    // now, restricted to the columns that actually carried the broken default.
    for (const column of brokenColumns) {
      const { poisonedValue } = BROKEN_DEFAULTS[column.dflt_value as string];
      await sql`
        UPDATE ${sql.ref(table)}
        SET ${sql.ref(column.name)} = datetime('now')
        WHERE ${sql.ref(column.name)} = ${poisonedValue}
      `.execute(trx);
    }
  }
}

/**
 * Rebuild `table` so every broken string-literal default becomes its corrected
 * raw-SQL form, preserving data, indexes, and triggers. Only the `DEFAULT`
 * clauses change; column set and order are untouched, so `INSERT ... SELECT *`
 * lines the rows up 1:1.
 */
async function rebuildTableWithCorrectedDefaults(
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
  let correctedSql = replaceFirstTableName(createSql, table, tempTable);
  for (const brokenDefault of Object.keys(BROKEN_DEFAULTS)) {
    // The broken literal only appears in the schema as a column default, so a
    // global replace cannot touch anything else.
    correctedSql = correctedSql.split(brokenDefault).join(BROKEN_DEFAULTS[brokenDefault].corrected);
  }

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
  // deleted top id be handed out again — aliasing ids that other tables reference
  // as plain integers. Restored after the rename.
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
  const hasSequenceTable = await sql<NamedRow>`
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
 * Replace the table name in a `CREATE TABLE` statement, tolerating the double-
 * quoted (Kysely) and bare forms and arbitrary whitespace after the keyword.
 * Only the first occurrence — the table being declared — is rewritten; a later
 * self-reference (e.g. a table-level FK) keeps pointing at the real name so the
 * copy still works.
 */
function replaceFirstTableName(createSql: string, from: string, to: string): string {
  // Match the declared table name as either a double-quoted identifier (Kysely's
  // form) or a bare word, and rewrite only when it is exactly `from` so a later
  // self-reference in the body is left untouched.
  return createSql.replace(
    /^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)(?:"([^"]+)"|(\w+))/i,
    (match, prefix: string, quotedName: string | undefined, bareName: string | undefined) =>
      (quotedName ?? bareName) === from ? `${prefix}"${to}"` : match,
  );
}

export async function down(): Promise<void> {
  // Irreversible repair: the corrected defaults and healed rows carry no
  // information worth reverting, so the down migration is intentionally a no-op.
}

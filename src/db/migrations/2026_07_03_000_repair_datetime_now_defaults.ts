import { type Kysely, sql } from "kysely";

/**
 * #2895 — data repair for the string-literal `datetime('now')` default bug.
 *
 * Every migration column that passed the plain string `datetime('now')` to
 * `col.defaultTo(...)` bound the argument as a VALUE, not raw SQL, so its DDL
 * emitted `DEFAULT 'datetime(''now'')'`. Any row inserted without an explicit value for
 * such a column stored the useless literal text `datetime('now')` instead of a
 * timestamp. The DDL is fixed forward (all columns now use
 * `defaultTo(sql`(datetime('now'))`)`), but databases that already ran the buggy
 * migrations carry poisoned rows this migration heals in place.
 *
 * STRATEGY — generic schema introspection rather than a hand-maintained
 * (table, column) list. The literal `datetime('now')` is the exact corruption
 * signature: no legitimate write path stores that string (real values are ISO
 * timestamps or `datetime('now')`-evaluated `YYYY-MM-DD HH:MM:SS`), so a
 * targeted `WHERE "<col>" = 'datetime(''now'')'` predicate touches ONLY poisoned
 * rows. Iterating every table/column guarantees completeness — a new defaulted
 * column can never be silently missed by this repair the way an enumerated list
 * would.
 *
 * The evaluated `datetime('now')` written here is the best available timestamp
 * for a row that never had a real one (its true creation time is unrecoverable).
 *
 * Safe on an empty/fresh DB and idempotent: on the destructive-recovery replay
 * (`resetDatabaseState` drops every table and re-runs all migrations) the schema
 * is rebuilt with the fixed defaults, so no row holds the literal and every
 * UPDATE is a no-op. A second run finds nothing left to repair.
 */
const LITERAL = "datetime('now')";

interface TableRow {
  name: string;
}

interface ColumnRow {
  name: string;
  type: string;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  // Wrap the whole sweep in ONE transaction so a mid-way failure cannot leave the
  // database half-repaired. These SQLite migrations are not auto-wrapped by the
  // migrator (`SqliteAdapter.supportsTransactionalDdl === false`), but the repair
  // is pure DML, so an explicit transaction gives atomicity — matching the
  // convention in `2026_07_01_000_failure_groups_signature_unique`.
  await db.transaction().execute(async trx => {
    const tables = await sql<TableRow>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `.execute(trx);

    for (const { name: table } of tables.rows) {
      const columns = await sql<ColumnRow>`
        SELECT name, type FROM pragma_table_info(${table})
      `.execute(trx);

      for (const column of columns.rows) {
        // Only TEXT-affinity columns can hold the literal string; skip the rest so
        // we never coerce a numeric/blob column.
        if (!/char|clob|text/i.test(column.type)) {
          continue;
        }
        await sql`
          UPDATE ${sql.ref(table)}
          SET ${sql.ref(column.name)} = datetime('now')
          WHERE ${sql.ref(column.name)} = ${LITERAL}
        `.execute(trx);
      }
    }
  });
}

export async function down(): Promise<void> {
  // Irreversible data repair: the original poisoned literals carried no
  // information worth restoring, so the down migration is intentionally a no-op.
}

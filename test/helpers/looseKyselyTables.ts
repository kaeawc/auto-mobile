import type { Kysely } from "kysely";

/** Column values a migration/lifecycle test reads or writes without a typed table schema. */
type LooseColumn = string | number | bigint | null;

/** Table schema for tests that touch tables by name (migration internals, dynamic table names). */
export type LooseTables = Record<string, Record<string, LooseColumn>>;

/**
 * A Kysely view over `db` where any table can be named, for migration and lifecycle tests
 * that inspect `sqlite_master`, `kysely_migration`, or tables outside the typed schema.
 */
export function looseKyselyTables<DB>(db: Kysely<DB>): Kysely<DB & LooseTables> {
  return db.withTables<LooseTables>();
}

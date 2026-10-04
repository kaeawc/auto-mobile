import type { Kysely } from "kysely";

/**
 * SQLite's catalog and Kysely's default migration bookkeeping tables. This
 * describes only the internal tables used during migration recovery, not the
 * application schema (which can be incomplete while migrations are running).
 * Ledger and lock columns match Kysely's Migrator table definitions.
 */
export interface MigratorSchema {
  sqlite_master: {
    type: string;
    name: string;
    tbl_name: string;
    rootpage: number;
    sql: string | null;
  };
  kysely_migration: {
    name: string;
    timestamp: string;
  };
  kysely_migration_lock: {
    id: string;
    is_locked: number;
  };
}

/**
 * Migration entry points receive Kysely<unknown> because the application schema
 * is not yet established. Generics cannot recover these known internal tables
 * from unknown. Narrow once at this boundary without cloning the connection or
 * changing its executor/plugins; callers check/create tables before using them.
 */
export function asMigratorDb(db: Kysely<unknown>): Kysely<MigratorSchema> {
  return db as Kysely<MigratorSchema>;
}

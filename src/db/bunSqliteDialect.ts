import {
  DatabaseIntrospector,
  Dialect,
  Driver,
  Kysely,
  QueryCompiler,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";
import { BunSqliteDriver, type BunSqliteDialectConfig } from "./BunSqliteDriver";
export {
  BunSqliteConnectionState,
  DEFAULT_RETRY_TOTAL_WAIT_MS,
  DEFAULT_OPTIMIZE_INTERVAL_MS,
  BEGIN_TRANSACTION_SQL,
  type BunSqliteStatement,
  type BunSqliteHandle,
} from "./BunSqliteConnectionState";

/**
 * Kysely dialect for Bun's built-in SQLite.
 * Based on SqliteDialect but uses bun:sqlite instead of better-sqlite3.
 */
export class BunSqliteDialect implements Dialect {
  readonly #config: BunSqliteDialectConfig;

  constructor(config: BunSqliteDialectConfig) {
    this.#config = config;
  }

  createDriver(): Driver {
    return new BunSqliteDriver(this.#config);
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): SqliteAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

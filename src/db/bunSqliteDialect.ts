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
import { BunSqliteDriver } from "./BunSqliteDriver";
import { type BunDatabase } from "./bunSqliteTypes";
import { type BunSqliteRetryConfig } from "./BunSqliteConnectionState";

/**
 * Low-frequency cadence for the periodic `PRAGMA optimize` (#3497). A long-lived
 * daemon that rarely restarts otherwise only refreshes planner statistics at
 * close, so index selection can drift as tables grow between restarts. `optimize`
 * is cheap and no-ops when nothing needs updating, so a several-minute tick keeps
 * stats fresh without meaningful overhead. Enabled only for the daemon's
 * file-backed connection (see database.ts); in-memory connections leave it off.
 */
export const DEFAULT_OPTIMIZE_INTERVAL_MS = 5 * 60 * 1000;

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

export interface BunSqliteDialectConfig {
  database: BunDatabase | (() => BunDatabase);
  beforeQuery?: () => Promise<void>;
  /**
   * BUSY/LOCKED retry knobs (issue #2874). All injected so tests can drive them
   * with fakes (a `FakeTimer`, a deterministic `Random`) and keep unit tests
   * <100ms and non-flaky. Defaults are production-safe.
   */
  retry?: BunSqliteRetryConfig;
  /**
   * When set and > 0, run `PRAGMA optimize` on this connection every N ms (#3497)
   * using the connection's injected timer. Left unset (disabled) for in-memory
   * connections; the daemon's file-backed connection enables it.
   */
  optimizeIntervalMs?: number;
}

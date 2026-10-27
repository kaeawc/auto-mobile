import type { DatabaseConnection, Driver, TransactionSettings } from "kysely";
import {
  BunSqliteConnectionState,
  type BunDatabase,
  type BunSqliteRetryConfig,
} from "./BunSqliteConnectionState";
import { BunSqliteConnectionLease } from "./BunSqliteConnectionLease";

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

export class BunSqliteDriver implements Driver {
  readonly #config: BunSqliteDialectConfig;
  #connectionState?: BunSqliteConnectionState;

  constructor(config: BunSqliteDialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {
    this.#connectionState = new BunSqliteConnectionState(
      this.#config.database,
      this.#config.beforeQuery,
      this.#config.retry,
      this.#config.optimizeIntervalMs,
    );
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#connectionState) {
      throw new Error("BunSqliteDriver not initialized");
    }
    return new BunSqliteConnectionLease(this.#connectionState);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings,
  ): Promise<void> {
    await this.#lease(connection).beginTransaction();
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await this.#lease(connection).commitTransaction();
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await this.#lease(connection).rollbackTransaction();
  }

  async releaseConnection(): Promise<void> {
    // No-op for Bun SQLite as we use a single connection
  }

  async destroy(): Promise<void> {
    // Close the handle but KEEP the connection state so acquireConnection keeps
    // resolving a (closed) lease. Kysely's ConnectionMutex releases its lock only
    // when the driver's acquireConnection RESOLVES; throwing here would strand the
    // next queued waiter with an unsettled promise (issue #2792). The closed state
    // rejects any query that reaches it instead.
    this.#connectionState?.close();
  }

  #lease(connection: DatabaseConnection): BunSqliteConnectionLease {
    if (!(connection instanceof BunSqliteConnectionLease)) {
      throw new Error("Invalid Bun SQLite connection");
    }
    return connection;
  }
}

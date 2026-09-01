import type { Database as BunDatabase } from "bun:sqlite";
import {
  DatabaseConnection,
  DatabaseIntrospector,
  Dialect,
  Driver,
  Kysely,
  QueryCompiler,
  QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  TransactionSettings,
} from "kysely";
import { CompiledQuery } from "kysely";
import { ActionableError } from "../models/ActionableError";
import { logger } from "../utils/logger";
import { BackoffPolicy, exponentialBackoff } from "../utils/Backoff";
import { classifySqliteError } from "./databaseFailureClassification";
import { defaultTimer, Timer } from "../utils/SystemTimer";
import { defaultRandom, Random } from "../utils/Random";

const MAX_CACHED_STATEMENTS = 200;

/**
 * Bounded retry for `SQLITE_BUSY`/`SQLITE_LOCKED` at the dialect boundary
 * (issue #2874). Small cap: the daemon runs a single writer behind a JS mutex,
 * so a busy/locked code is a rare `busy_timeout` expiry or checkpoint
 * contention that a short backoff clears. Never applied inside an open
 * transaction (partial re-execution) — see `#shouldRetry`.
 */
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF: BackoffPolicy = exponentialBackoff({
  initialDelayMs: 5,
  multiplier: 2,
  maxDelayMs: 50,
});

/**
 * Low-frequency cadence for the periodic `PRAGMA optimize` (#3497). A long-lived
 * daemon that rarely restarts otherwise only refreshes planner statistics at
 * close, so index selection can drift as tables grow between restarts. `optimize`
 * is cheap and no-ops when nothing needs updating, so a several-minute tick keeps
 * stats fresh without meaningful overhead. Enabled only for the daemon's
 * file-backed connection (see database.ts); in-memory connections leave it off.
 */
export const DEFAULT_OPTIMIZE_INTERVAL_MS = 5 * 60 * 1000;

type BunStatement = ReturnType<BunDatabase["prepare"]>;
type SchemaVersionRow = { schema_version?: number | bigint };

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

interface BunSqliteDialectConfig {
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

interface BunSqliteRetryConfig {
  /** Total attempts including the first. `<= 1` disables retry. */
  maxAttempts?: number;
  /** Backoff policy for the delay between attempts. */
  backoff?: BackoffPolicy;
  /** Sleep seam so tests avoid real timers. */
  timer?: Timer;
  /** Jitter source (0..1). Injected + faked for deterministic tests. */
  random?: Random;
}

class BunSqliteDriver implements Driver {
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

export class BunSqliteConnectionState {
  readonly #databaseSource: BunDatabase | (() => BunDatabase);
  readonly #beforeQuery?: () => Promise<void>;
  #db: BunDatabase | null = null;
  #transactionOwner: symbol | null = null;
  #pendingTransactions = 0;
  #activeQueries = 0;
  #waiters: Array<() => void> = [];
  #statementCache = new Map<string, BunStatement>();
  #observedSchemaVersion: number | null = null;
  #closed = false;
  readonly #maxRetryAttempts: number;
  readonly #retryBackoff: BackoffPolicy;
  readonly #timer: Timer;
  readonly #random: Random;
  #optimizeTimer: NodeJS.Timeout | null = null;

  constructor(
    database: BunDatabase | (() => BunDatabase),
    beforeQuery?: () => Promise<void>,
    retry?: BunSqliteRetryConfig,
    optimizeIntervalMs?: number,
  ) {
    this.#databaseSource = database;
    this.#db = typeof database === "function" ? null : database;
    this.#beforeQuery = beforeQuery;
    this.#maxRetryAttempts = Math.max(1, retry?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS);
    this.#retryBackoff = retry?.backoff ?? DEFAULT_RETRY_BACKOFF;
    this.#timer = retry?.timer ?? defaultTimer;
    this.#random = retry?.random ?? defaultRandom;

    if (optimizeIntervalMs && optimizeIntervalMs > 0) {
      this.#optimizeTimer = this.#timer.setInterval(
        () => this.#runPeriodicOptimize(),
        optimizeIntervalMs,
      );
      // A background maintenance tick must never keep the process alive.
      // FakeTimer handles have no unref, hence the optional call.
      (this.#optimizeTimer as { unref?: () => void }).unref?.();
    }
  }

  // Best-effort periodic refresh of the query-planner statistics (#3497). Skips
  // when the connection is closed, not yet opened, or mid-query/transaction so it
  // never runs inside another statement's transaction; the next tick retries.
  #runPeriodicOptimize(): void {
    if (
      this.#closed ||
      !this.#db ||
      this.#transactionOwner !== null ||
      this.#pendingTransactions > 0 ||
      this.#activeQueries > 0
    ) {
      return;
    }
    try {
      this.#db.exec("PRAGMA optimize;");
    } catch (error) {
      // Stale planner stats are preferable to a throwing background timer.
      logger.debug(`periodic PRAGMA optimize failed: ${error}`);
    }
  }

  async beginTransaction(owner: symbol): Promise<void> {
    this.#assertOpen();
    this.#pendingTransactions += 1;
    try {
      await this.#reserveTransaction(owner);
    } finally {
      this.#pendingTransactions -= 1;
      this.#notifyWaiters();
    }

    try {
      await this.executeQuery(CompiledQuery.raw("begin"), owner);
    } catch (error) {
      this.#transactionOwner = null;
      this.#notifyWaiters();
      throw error;
    }
  }

  async commitTransaction(owner: symbol): Promise<void> {
    try {
      await this.executeQuery(CompiledQuery.raw("commit"), owner);
    } finally {
      this.#clearTransactionOwner(owner);
    }
  }

  async rollbackTransaction(owner: symbol): Promise<void> {
    try {
      await this.executeQuery(CompiledQuery.raw("rollback"), owner);
      this.#clearStatementCache();
    } finally {
      this.#clearTransactionOwner(owner);
    }
  }

  async executeQuery<R>(compiledQuery: CompiledQuery, owner: symbol): Promise<QueryResult<R>> {
    await this.#enterQuery(owner);

    const { sql, parameters } = compiledQuery;

    try {
      // Bounded BUSY/LOCKED retry (issue #2874). Reads the structured
      // `err.cause.code` preserved in #2793 (by identity, not `.message`
      // scraping) to decide whether a locking contention is worth retrying.
      // Only retries in autocommit — never across a transaction boundary, so a
      // partially-applied statement inside another lease's transaction is never
      // re-executed. See #shouldRetry.
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.#executeOnce<R>(sql, parameters);
        } catch (error) {
          if (!this.#shouldRetry(error, attempt)) {
            throw error;
          }
          const delayMs = this.#retryDelayMs(attempt);
          logger.warn(
            `SQLite busy/locked (attempt ${attempt}/${this.#maxRetryAttempts}); ` +
              `retrying in ${delayMs}ms: ${sql}`,
          );
          await this.#timer.sleep(delayMs);
        }
      }
    } finally {
      this.#activeQueries -= 1;
      this.#notifyWaiters();
    }
  }

  /**
   * Decide whether a caught query error warrants another attempt. Retries only
   * when: the code (via `err.cause.code`, #2793 contract) is `retryable`
   * (`SQLITE_BUSY`/`SQLITE_LOCKED`); attempts remain; the handle is still open;
   * and we are NOT inside a transaction (autocommit only — `#transactionOwner`
   * is cleared). Never retries `constraint`/`fatal`.
   */
  #shouldRetry(error: unknown, attempt: number): boolean {
    if (attempt >= this.#maxRetryAttempts) {
      return false;
    }
    if (this.#closed) {
      return false;
    }
    // Autocommit only: if any transaction is open, retrying could re-run one
    // statement of a multi-statement unit (the begin/commit are themselves
    // routed through executeQuery). #transactionOwner is null exactly when no
    // lease holds the transaction lock, so this also blocks retrying the raw
    // begin/commit/rollback control statements.
    if (this.#transactionOwner !== null) {
      return false;
    }
    return classifySqliteError(error) === "retryable";
  }

  #retryDelayMs(attempt: number): number {
    const base = this.#retryBackoff.delayForAttempt(attempt);
    // Full jitter in [0, base] to avoid synchronized retry storms.
    return Math.floor(this.#random.next() * (base + 1));
  }

  async #executeOnce<R>(sql: string, parameters: readonly unknown[]): Promise<QueryResult<R>> {
    // Reject before touching (or reopening) the handle. A query that lost the
    // shutdown race must fail cleanly here rather than silently reopening a new
    // handle via #getDatabase() (issue #2792). Thrown outside the SQL-wrapping
    // catch so callers see the closed-db cause, not a generic "Query failed".
    if (this.#closed) {
      throw new Error("Cannot use a closed database");
    }

    try {
      await this.#beforeQuery?.();
      // beforeQuery can await (e.g. migration gating), during which close() may
      // run — re-check so a parked query rejects rather than reopening the handle.
      if (this.#closed) {
        throw new Error("Cannot use a closed database");
      }
      const db = this.#getDatabase();

      const schemaChanging = this.#isSchemaChangingSql(sql);
      const stmt = schemaChanging ? db.prepare(sql) : this.#getStatement(db, sql);

      // Check if this is a SELECT query or query with RETURNING clause
      const sqlLower = sql.trim().toLowerCase();
      const isSelect = sqlLower.startsWith("select");
      // Word boundary (not a bare substring) so an identifier like
      // `returning_items` isn't misclassified as a RETURNING clause. `_` is a
      // word char, so `\breturning\b` correctly rejects `returning_items`.
      const hasReturning = /\breturning\b/.test(sqlLower);

      try {
        if (isSelect || hasReturning) {
          // For SELECT queries or queries with RETURNING, return all rows
          const rows = stmt.all(...(parameters as any[])) as R[];
          const result = {
            rows,
            numAffectedRows: hasReturning ? BigInt(rows.length) : undefined,
          };
          if (schemaChanging) {
            this.#clearStatementCache();
          }
          return result;
        } else {
          // For INSERT/UPDATE/DELETE queries without RETURNING, execute and return changes
          const writeResult = stmt.run(...(parameters as any[]));
          const result = {
            rows: [],
            numAffectedRows: BigInt(writeResult.changes),
            insertId:
              writeResult.lastInsertRowid !== undefined
                ? BigInt(writeResult.lastInsertRowid)
                : undefined,
          };
          if (schemaChanging) {
            this.#clearStatementCache();
          }
          return result;
        }
      } finally {
        if (schemaChanging) {
          stmt.finalize();
        }
      }
    } catch (error) {
      // BigInt-safe: Kysely can bind BigInt params, and a bare
      // JSON.stringify(parameters) throws on BigInt — which would mask the real
      // SqliteError with a TypeError from the error reporter itself.
      const params = JSON.stringify(parameters, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      // Preserve the original SqliteError (code/stack) via `cause` so future
      // BUSY/constraint-aware retries and describeUnknownError (which recurses
      // into `.cause`) can reach it. ActionableError drops `cause`, so use a
      // plain Error here. Keep the original error text inline too: the
      // `#beforeQuery` migration gate above runs inside this try, so its
      // "startup migrations failed" throw is caught and rewrapped here — and
      // databaseLazyPath.integration.test.ts asserts that text via `.message`. The inline
      // `${error}` is BigInt-safe (unlike JSON.stringify) since it goes
      // through toString().
      throw new Error(`Query failed: ${error}\nSQL: ${sql}\nParameters: ${params}`, {
        cause: error,
      });
    }
  }

  close(): void {
    // Mark closed FIRST so any query that wakes from #waitForStateChange (below)
    // observes the closed state and rejects instead of running against a dead
    // handle. Then wake waiters so queued queries settle promptly.
    this.#closed = true;
    if (this.#optimizeTimer) {
      this.#timer.clearInterval(this.#optimizeTimer);
      this.#optimizeTimer = null;
    }
    this.#clearStatementCache();
    if (this.#db) {
      try {
        this.#db.exec("PRAGMA optimize;");
      } catch (error) {
        // Best-effort: stale planner stats are preferable to blocking shutdown.
        logger.debug(`PRAGMA optimize on close failed: ${error}`);
      }
      try {
        // Flush the WAL into the main DB and truncate the `-wal`/`-shm`
        // sidecars so a clean shutdown leaves a single-file artifact. Stays
        // after PRAGMA optimize because optimize may write planner stats.
        // synchronous — close() runs inside destroy() and must not introduce
        // an await point that could reorder with the mutex (issue #2802).
        this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      } catch (error) {
        // Best-effort: a busy/failed checkpoint at shutdown is expected under
        // load and safe to ignore — db.close() still persists committed data.
        logger.debug(`WAL checkpoint on close failed: ${error}`);
      }
      this.#db.close();
      this.#db = null;
    }
    this.#notifyWaiters();
  }

  #getDatabase(): BunDatabase {
    if (!this.#db) {
      this.#db =
        typeof this.#databaseSource === "function" ? this.#databaseSource() : this.#databaseSource;
    }

    return this.#db;
  }

  #getStatement(db: BunDatabase, sql: string): BunStatement {
    if (this.#statementCache.size === 0) {
      this.#observedSchemaVersion = this.#readSchemaVersion(db);
    }

    const cached = this.#statementCache.get(sql);
    if (cached) {
      this.#invalidateCacheIfSchemaVersionChanged(db);
      const current = this.#statementCache.get(sql);
      if (!current) {
        return this.#prepareAndCacheStatement(db, sql);
      }
      this.#statementCache.delete(sql);
      this.#statementCache.set(sql, current);
      return current;
    }

    return this.#prepareAndCacheStatement(db, sql);
  }

  #prepareAndCacheStatement(db: BunDatabase, sql: string): BunStatement {
    const statement = db.prepare(sql);
    this.#statementCache.set(sql, statement);
    if (this.#statementCache.size > MAX_CACHED_STATEMENTS) {
      const oldestKey = this.#statementCache.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = this.#statementCache.get(oldestKey);
        this.#statementCache.delete(oldestKey);
        evicted?.finalize();
      }
    }
    return statement;
  }

  #invalidateCacheIfSchemaVersionChanged(db: BunDatabase): void {
    const schemaVersion = this.#readSchemaVersion(db);
    if (this.#observedSchemaVersion === null) {
      this.#observedSchemaVersion = schemaVersion;
      return;
    }
    if (this.#observedSchemaVersion !== schemaVersion) {
      this.#clearStatementCache();
      this.#observedSchemaVersion = schemaVersion;
    }
  }

  #readSchemaVersion(db: BunDatabase): number {
    const statement = db.prepare("PRAGMA schema_version");
    try {
      const row = statement.get() as SchemaVersionRow | undefined;
      const schemaVersion = row?.schema_version;
      if (schemaVersion === undefined) {
        throw new Error("PRAGMA schema_version did not return a schema_version value");
      }
      return Number(schemaVersion);
    } finally {
      statement.finalize();
    }
  }

  #isSchemaChangingSql(sql: string): boolean {
    return /^(?:create|alter|drop)\b/i.test(sql.trim());
  }

  #clearStatementCache(): void {
    for (const statement of this.#statementCache.values()) {
      statement.finalize();
    }
    this.#statementCache.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("Cannot use a closed database");
    }
  }

  async #reserveTransaction(owner: symbol): Promise<void> {
    // A nested beginTransaction on a lease that already holds the transaction
    // lock would busy-loop forever here (the owner waiting for itself to
    // release), deadlocking the daemon's only DB connection. Mirror
    // #enterQuery's `=== owner` carve-out by failing fast with a clear error
    // instead. The caller (beginTransaction) still decrements
    // #pendingTransactions and wakes waiters in its finally, so no counter leak.
    if (this.#transactionOwner === owner) {
      throw new ActionableError("Nested transactions are not supported by BunSqliteDialect");
    }
    while (this.#transactionOwner !== null || this.#activeQueries > 0) {
      this.#assertOpen();
      await this.#waitForStateChange();
    }
    this.#assertOpen();
    this.#transactionOwner = owner;
  }

  async #enterQuery(owner: symbol): Promise<void> {
    while (
      (this.#transactionOwner !== null && this.#transactionOwner !== owner) ||
      (this.#transactionOwner === null && this.#pendingTransactions > 0)
    ) {
      // Bail if the handle closed while queued so a parked query can't spin
      // forever after shutdown (issue #2792). Thrown before the activeQueries
      // increment, so no counter is leaked.
      this.#assertOpen();
      await this.#waitForStateChange();
    }
    this.#activeQueries += 1;
  }

  #clearTransactionOwner(owner: symbol): void {
    if (this.#transactionOwner === owner) {
      this.#transactionOwner = null;
      this.#notifyWaiters();
    }
  }

  async #waitForStateChange(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  #notifyWaiters(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      waiter();
    }
  }
}

class BunSqliteConnectionLease implements DatabaseConnection {
  readonly #state: BunSqliteConnectionState;
  readonly #owner = Symbol("BunSqliteConnectionLease");

  constructor(state: BunSqliteConnectionState) {
    this.#state = state;
  }

  async beginTransaction(): Promise<void> {
    await this.#state.beginTransaction(this.#owner);
  }

  async commitTransaction(): Promise<void> {
    await this.#state.commitTransaction(this.#owner);
  }

  async rollbackTransaction(): Promise<void> {
    await this.#state.rollbackTransaction(this.#owner);
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    return this.#state.executeQuery<R>(compiledQuery, this.#owner);
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming is not supported by BunSqliteDialect");
  }
}

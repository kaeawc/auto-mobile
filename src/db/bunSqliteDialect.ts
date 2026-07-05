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

const MAX_CACHED_STATEMENTS = 200;

type BunStatement = ReturnType<BunDatabase["prepare"]>;

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
      this.#config.beforeQuery
    );
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#connectionState) {
      throw new Error("BunSqliteDriver not initialized");
    }
    return new BunSqliteConnectionLease(this.#connectionState);
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
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
  #closed = false;

  constructor(database: BunDatabase | (() => BunDatabase), beforeQuery?: () => Promise<void>) {
    this.#databaseSource = database;
    this.#db = typeof database === "function" ? null : database;
    this.#beforeQuery = beforeQuery;
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
          typeof value === "bigint" ? value.toString() : value
        );
        // Preserve the original SqliteError (code/stack) via `cause` so future
        // BUSY/constraint-aware retries and describeUnknownError (which recurses
        // into `.cause`) can reach it. ActionableError drops `cause`, so use a
        // plain Error here. Keep the original error text inline too: the
        // `#beforeQuery` migration gate above runs inside this try, so its
        // "startup migrations failed" throw is caught and rewrapped here — and
        // databaseLazyPath.test.ts asserts that text via `.message`. The inline
        // `${error}` is BigInt-safe (unlike JSON.stringify) since it goes
        // through toString().
        throw new Error(`Query failed: ${error}\nSQL: ${sql}\nParameters: ${params}`, {
          cause: error,
        });
      }
    } finally {
      this.#activeQueries -= 1;
      this.#notifyWaiters();
    }
  }

  close(): void {
    // Mark closed FIRST so any query that wakes from #waitForStateChange (below)
    // observes the closed state and rejects instead of running against a dead
    // handle. Then wake waiters so queued queries settle promptly.
    this.#closed = true;
    this.#clearStatementCache();
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
    this.#notifyWaiters();
  }

  #getDatabase(): BunDatabase {
    if (!this.#db) {
      this.#db =
        typeof this.#databaseSource === "function"
          ? this.#databaseSource()
          : this.#databaseSource;
    }

    return this.#db;
  }

  #getStatement(db: BunDatabase, sql: string): BunStatement {
    const cached = this.#statementCache.get(sql);
    if (cached) {
      this.#statementCache.delete(sql);
      this.#statementCache.set(sql, cached);
      return cached;
    }

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
    await new Promise<void>(resolve => {
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

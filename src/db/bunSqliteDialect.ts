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
  database: BunDatabase;
  beforeQuery?: () => Promise<void>;
}

class BunSqliteDriver implements Driver {
  readonly #config: BunSqliteDialectConfig;
  #connection?: BunSqliteConnection;

  constructor(config: BunSqliteDialectConfig) {
    this.#config = config;
  }

  async init(): Promise<void> {
    this.#connection = new BunSqliteConnection(this.#config.database, this.#config.beforeQuery);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (!this.#connection) {
      throw new Error("BunSqliteDriver not initialized");
    }
    return this.#connection;
  }

  async beginTransaction(connection: DatabaseConnection, _settings: TransactionSettings): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {
    // No-op for Bun SQLite as we use a single connection
  }

  async destroy(): Promise<void> {
    if (this.#connection) {
      this.#config.database.close();
    }
  }
}

class BunSqliteConnection implements DatabaseConnection {
  readonly #db: BunDatabase;
  readonly #beforeQuery?: () => Promise<void>;

  constructor(db: BunDatabase, beforeQuery?: () => Promise<void>) {
    this.#db = db;
    this.#beforeQuery = beforeQuery;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;

    try {
      await this.#beforeQuery?.();

      // Prepare statement
      const stmt = this.#db.prepare(sql);

      // Check if this is a SELECT query or query with RETURNING clause
      const sqlLower = sql.trim().toLowerCase();
      const isSelect = sqlLower.startsWith("select");
      const hasReturning = sqlLower.includes("returning");

      if (isSelect || hasReturning) {
        // For SELECT queries or queries with RETURNING, return all rows
        const rows = stmt.all(...(parameters as any[])) as R[];
        return {
          rows,
          numAffectedRows: hasReturning ? BigInt(rows.length) : undefined,
        };
      } else {
        // For INSERT/UPDATE/DELETE queries without RETURNING, execute and return changes
        const result = stmt.run(...(parameters as any[]));
        return {
          rows: [],
          numAffectedRows: BigInt(result.changes),
          insertId:
            result.lastInsertRowid !== undefined
              ? BigInt(result.lastInsertRowid)
              : undefined,
        };
      }
    } catch (error) {
      throw new Error(
        `Query failed: ${error}\nSQL: ${sql}\nParameters: ${JSON.stringify(parameters)}`
      );
    }
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming is not supported by BunSqliteDialect");
  }
}

import type { DatabaseConnection, CompiledQuery, QueryResult } from "kysely";
import type { BunSqliteConnectionState } from "./BunSqliteConnectionState";

export class BunSqliteConnectionLease implements DatabaseConnection {
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

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    yield await Promise.reject<QueryResult<R>>(
      new Error("Streaming is not supported by BunSqliteDialect"),
    );
  }
}

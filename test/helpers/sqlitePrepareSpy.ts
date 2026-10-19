import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import { spyOn } from "bun:test";

/** A prepared statement as the interceptors see it, whatever row and parameter types it carries. */
export type PreparedStatement = Statement<unknown, SQLQueryBindings[]>;

export interface DatabasePrepareHooks {
  /** Runs before the statement is prepared; throw to make `prepare` fail for this SQL. */
  readonly beforePrepare?: (sql: string) => void;
  /** Runs with the real statement; its return value is what `prepare` hands back. */
  readonly afterPrepare?: (sql: string, statement: PreparedStatement) => void;
}

/**
 * Spy on `Database.prototype.prepare` while delegating to the real method. The replacement keeps
 * `prepare`'s generic signature (rebinding the original preserves it, where `call` would erase
 * it), so the mock type-checks without a cast.
 */
export function spyOnDatabasePrepare(hooks: DatabasePrepareHooks = {}) {
  const prepare = Database.prototype.prepare;
  return spyOn(Database.prototype, "prepare").mockImplementation(function <
    Row,
    Params extends SQLQueryBindings | SQLQueryBindings[],
  >(this: Database, sql: string, params?: Params): ReturnType<typeof prepare<Row, Params>> {
    hooks.beforePrepare?.(sql);
    const statement = prepare.bind(this)<Row, Params>(sql, params);
    hooks.afterPrepare?.(sql, statement);
    return statement;
  });
}

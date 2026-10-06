import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BEGIN_TRANSACTION_SQL, BunSqliteDialect } from "../../src/db/bunSqliteDialect";

/**
 * Issue #10042: a deferred `BEGIN` lets a read-then-write transaction fail with
 * SQLITE_BUSY_SNAPSHOT when a peer process commits between its read and its
 * first write. Every app transaction must open with `BEGIN IMMEDIATE` so the
 * write lock is taken up front. The cross-connection behaviour is covered by
 * the file-backed `bunSqliteBeginImmediate.integration.test.ts`; this pins the
 * control statement itself on an in-memory handle.
 */
describe("BunSqliteDialect transaction control statement (issue #10042)", () => {
  it("opens every transaction with BEGIN IMMEDIATE, before any query in it", async () => {
    const memdb = new Database(":memory:");
    memdb.exec("CREATE TABLE t (id INTEGER)");
    const prepared: string[] = [];
    const prepare = memdb.prepare.bind(memdb);
    spyOn(memdb, "prepare").mockImplementation(((query: string) => {
      prepared.push(query.trim().toLowerCase());
      return prepare(query);
    }) as typeof memdb.prepare);
    const db = new Kysely<{ t: { id: number } }>({
      dialect: new BunSqliteDialect({ database: memdb }),
    });

    await db.transaction().execute(async (trx) => {
      await sql`SELECT id FROM t`.execute(trx);
      await trx.insertInto("t").values({ id: 1 }).execute();
    });

    const control = prepared.filter((q) => /^(begin|commit|rollback)/.test(q));
    expect(control).toEqual([BEGIN_TRANSACTION_SQL, "commit"]);
    expect(BEGIN_TRANSACTION_SQL).toBe("begin immediate");
    expect(prepared.indexOf(BEGIN_TRANSACTION_SQL)).toBeLessThan(
      prepared.findIndex((q) => q.startsWith("select id")),
    );
    await db.destroy();
  });
});

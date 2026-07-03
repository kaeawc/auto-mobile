import { describe, it, expect } from "bun:test";
import { Kysely, sql, CompiledQuery } from "kysely";
import { Database } from "bun:sqlite";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";

/**
 * Regression for issue #2792: destroy() racing queries queued in Kysely's
 * ConnectionMutex must not leave any waiter permanently stranded.
 *
 * The interleaving is driven deterministically with a gated `beforeQuery` (a
 * deferred promise, NOT sleeps): the first query parks inside the mutex while two
 * more queue behind it, then `destroy()` fires. Kysely releases its
 * ConnectionMutex only when the driver's `acquireConnection` resolves — if the
 * dialect throws on acquire after close, the next waiter never settles (hang).
 */
describe("BunSqliteDialect destroy-during-queued-query (issue #2792)", () => {
  function gatedDialect(): {
    dialect: BunSqliteDialect;
    firstEntered: Promise<void>;
    release: () => void;
    } {
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    let signalEntered!: () => void;
    const firstEntered = new Promise<void>(r => {
      signalEntered = r;
    });
    let count = 0;
    const beforeQuery = async (): Promise<void> => {
      count += 1;
      if (count === 1) {
        signalEntered();
        await gate; // park the first query while holding the mutex
      }
    };
    const memdb = new Database(":memory:");
    memdb.exec("CREATE TABLE t (id INTEGER)");
    const dialect = new BunSqliteDialect({ database: memdb, beforeQuery });
    return { dialect, firstEntered, release };
  }

  it("settles every queued query (none strand) when destroy races the queue", async () => {
    const { dialect, firstEntered, release } = gatedDialect();
    const db = new Kysely<any>({ dialect });

    const q1 = sql`SELECT 1 as v`.execute(db);
    await firstEntered; // Q1 now holds the ConnectionMutex

    const q2 = sql`SELECT 2 as v`.execute(db);
    const q3 = sql`SELECT 3 as v`.execute(db);
    // Let Q2/Q3 queue in Kysely's ConnectionMutex behind Q1.
    await Promise.resolve();
    await Promise.resolve();

    await db.destroy();
    release();

    // If any waiter strands, allSettled never resolves and the test times out.
    const results = await Promise.allSettled([q1, q2, q3]);
    expect(results).toHaveLength(3);
    // Every query must reach a terminal state — resolve or reject, never pending.
    for (const r of results) {
      expect(["fulfilled", "rejected"]).toContain(r.status);
    }
  });

  it("acquireConnection resolves after destroy and executeQuery rejects (no throw-on-acquire, no reopen)", async () => {
    // Exercise the driver directly: Kysely's RuntimeDriver rejects brand-new
    // queries at its own #destroyPromise guard, which would mask the dialect's
    // post-close behavior. The strand comes from the dialect THROWING on acquire,
    // so assert acquire resolves and the query rejects with a closed-db error.
    const memdb = new Database(":memory:");
    memdb.exec("CREATE TABLE t (id INTEGER)");
    const driver = new BunSqliteDialect({ database: memdb }).createDriver();
    await driver.init();

    const before = await driver.acquireConnection();
    await before.executeQuery(CompiledQuery.raw("SELECT 1")); // works before close
    await driver.releaseConnection(before);

    await driver.destroy();

    // Must NOT throw here — a throw is what strands the next Kysely mutex waiter.
    const after = await driver.acquireConnection();
    await expect(after.executeQuery(CompiledQuery.raw("SELECT 1"))).rejects.toThrow(
      /closed database/i
    );
  });
});

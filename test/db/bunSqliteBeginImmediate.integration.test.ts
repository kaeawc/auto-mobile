import { describe, expect, it } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { sql } from "kysely";
import { bindFileBackedDbHarness, WINDOWS_FILE_DB_TEST_TIMEOUT_MS } from "./withFileBackedDb";

/**
 * Issue #10042 — two connections on one WAL file (the supported two-daemons
 * arrangement). With a deferred `BEGIN`, a transaction that SELECTs and then
 * INSERTs fails the INSERT with SQLITE_BUSY_SNAPSHOT if the peer commits in
 * between (busy_timeout does not apply to a snapshot upgrade). With
 * `BEGIN IMMEDIATE` the peer cannot commit mid-transaction at all: it waits on
 * (here: with busy_timeout 0, fails fast against) the held write lock, and the
 * transaction commits cleanly.
 */
describe("BEGIN IMMEDIATE across two connections (issue #10042)", () => {
  const getHarness = bindFileBackedDbHarness();

  it(
    "commits a read-then-write transaction while a peer connection attempts a write mid-transaction",
    async () => {
      const lifecycle = await getHarness().openLifecycleTestDb("auto-mobile-begin-immediate-");
      const peer = new BunDatabase(lifecycle.dbPath);
      try {
        // busy_timeout 0 turns "the peer waits for the write lock" into a
        // deterministic immediate SQLITE_BUSY, so the test never sleeps and never
        // blocks this thread on the 5s production timeout.
        peer.exec("PRAGMA busy_timeout = 0;");
        const db = lifecycle.module.getDatabase();
        await sql`CREATE TABLE begin_immediate_probe (id INTEGER PRIMARY KEY, who TEXT)`.execute(
          db,
        );

        let peerWriteError: unknown;
        await db.transaction().execute(async (trx) => {
          // Read first: under a deferred BEGIN this pins a WAL read snapshot.
          await sql`SELECT count(*) AS n FROM begin_immediate_probe`.execute(trx);
          try {
            peer.exec("INSERT INTO begin_immediate_probe (who) VALUES ('peer')");
          } catch (error) {
            peerWriteError = error;
          }
          // Under a deferred BEGIN the peer commit above succeeded, so this write
          // would throw SQLITE_BUSY_SNAPSHOT.
          await sql`INSERT INTO begin_immediate_probe (who) VALUES ('app')`.execute(trx);
        });

        expect((peerWriteError as { code?: string } | undefined)?.code).toBe("SQLITE_BUSY");

        // Once the transaction commits the peer's write goes through.
        peer.exec("INSERT INTO begin_immediate_probe (who) VALUES ('peer')");
        const rows = peer.query("SELECT who FROM begin_immediate_probe ORDER BY id").all();
        expect(rows).toEqual([{ who: "app" }, { who: "peer" }]);
      } finally {
        peer.close();
        await lifecycle.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );

  it(
    "runs the app connection in WAL mode with the configured busy timeout",
    async () => {
      const lifecycle = await getHarness().openLifecycleTestDb("auto-mobile-begin-immediate-wal-");
      try {
        const db = lifecycle.module.getDatabase();
        const journal = await sql<{
          journal_mode: string;
        }>`SELECT journal_mode FROM pragma_journal_mode`.execute(db);
        const timeout = await sql<{
          timeout: number;
        }>`SELECT timeout FROM pragma_busy_timeout`.execute(db);
        expect(journal.rows[0]?.journal_mode).toBe("wal");
        expect(timeout.rows[0]?.timeout).toBe(5000);
      } finally {
        await lifecycle.close();
      }
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});

import { describe, expect, spyOn, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { runMigrations } from "../../src/db/migrator";
import { logger } from "../../src/utils/logger";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { recordNetworkEvent, cleanupIfNeeded as cleanupNetwork } from "../../src/db/networkEventRepository";
import { recordLogEvent, cleanupIfNeeded as cleanupLog } from "../../src/db/logEventRepository";
import { recordOsEvent, cleanupIfNeeded as cleanupOs } from "../../src/db/osEventRepository";
import { recordNavigationEvent, cleanupIfNeeded as cleanupNavigation } from "../../src/db/navigationEventRepository";
import { recordLayoutEvent, cleanupIfNeeded as cleanupLayout } from "../../src/db/layoutEventRepository";
import { recordStorageEvent, cleanupIfNeeded as cleanupStorage } from "../../src/db/storageEventRepository";

/**
 * Retention behavior for the six telemetry event repositories (#2799).
 *
 * The per-insert full-table `count(*)` was removed in favor of a single indexed
 * offset-probe on `idx_<table>_timestamp`. These tests lock in three things:
 *   1. the retention SQL no longer issues a `count(*)` (the hot-path scan is gone),
 *   2. retention still trims to the cap and prunes the same rows (output-preserving),
 *   3. a cleanup failure is logged, not silently swallowed (CLAUDE.md convention).
 *
 * `RETENTION_MAX_ROWS` is injectable via `cleanupIfNeeded(db, maxRows)` so the trim
 * behavior is verified at a low cap in <100ms without inserting 10k real rows.
 */

/** Builds an in-memory test DB that records every executed SQL string. */
async function createInstrumentedTestDatabase(): Promise<{ db: Kysely<Database>; sqls: string[] }> {
  const bunDb = new BunDatabase(":memory:");
  const sqls: string[] = [];
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
    log: event => {
      if (event.level === "query") {
        sqls.push(event.query.sql);
      }
    },
  });
  await runMigrations(db as Kysely<unknown>);
  return { db, sqls };
}

/** Lets detached fire-and-forget cleanups from `recordX` settle before assertions. */
async function flushPendingCleanups(): Promise<void> {
  await new Promise<void>(resolve => defaultTimer.setTimeout(() => resolve(), 15));
}

interface RepoUnderTest {
  name: string;
  record: (input: any, db?: Kysely<Database>) => Promise<number>;
  cleanup: (db?: Kysely<Database>, maxRows?: number) => Promise<void>;
  make: (timestamp: number) => any;
}

const REPOS: RepoUnderTest[] = [
  {
    name: "network",
    record: recordNetworkEvent,
    cleanup: cleanupNetwork,
    make: ts => ({
      deviceId: "d1", timestamp: ts, applicationId: null, sessionId: null,
      url: "https://x/y", method: "GET", statusCode: 200, durationMs: 1,
      requestBodySize: 0, responseBodySize: 0, protocol: null, host: null, path: null, error: null,
    }),
  },
  {
    name: "log",
    record: recordLogEvent,
    cleanup: cleanupLog,
    make: ts => ({
      deviceId: "d1", timestamp: ts, applicationId: null, sessionId: null,
      level: 3, tag: "T", message: "m", filterName: "f",
    }),
  },
  {
    name: "os",
    record: recordOsEvent,
    cleanup: cleanupOs,
    make: ts => ({
      deviceId: "d1", timestamp: ts, applicationId: null, sessionId: null,
      category: "lifecycle", kind: "resume", details: null,
    }),
  },
  {
    name: "navigation",
    record: recordNavigationEvent,
    cleanup: cleanupNavigation,
    make: ts => ({
      deviceId: "d1", timestamp: ts, applicationId: null, sessionId: null,
      destination: "Home", source: null, arguments: null, metadata: null,
    }),
  },
  {
    name: "layout",
    record: recordLayoutEvent,
    cleanup: cleanupLayout,
    make: ts => ({
      deviceId: "d1", timestamp: ts, applicationId: null, sessionId: null,
      subType: "recomposition", composableName: null, composableId: null,
      recompositionCount: null, durationMs: null, likelyCause: null, detailsJson: null,
    }),
  },
  {
    name: "storage",
    record: recordStorageEvent,
    cleanup: cleanupStorage,
    make: ts => ({
      deviceId: "d1", timestamp: ts, applicationId: null, sessionId: null,
      fileName: "prefs.xml", key: "k", value: "v", valueType: "string", changeType: "update",
    }),
  },
];

const TABLE_BY_NAME: Record<string, string> = {
  network: "network_events",
  log: "log_events",
  os: "os_events",
  navigation: "navigation_events",
  layout: "layout_events",
  storage: "storage_events",
};

describe("event repository retention (#2799)", () => {
  for (const repo of REPOS) {
    describe(repo.name, () => {
      test("cleanup issues no count(*) — only the indexed offset probe", async () => {
        const { db, sqls } = await createInstrumentedTestDatabase();
        try {
          // A few rows via the public record path; then isolate the explicit cleanup SQL.
          for (let ts = 1; ts <= 3; ts++) {
            await repo.record(repo.make(ts), db);
          }
          await flushPendingCleanups();
          sqls.length = 0;

          await repo.cleanup(db, 2);

          const joined = sqls.join("\n").toLowerCase();
          expect(joined.length).toBeGreaterThan(0);
          expect(joined).not.toContain("count(");
          expect(joined).toContain("offset");
        } finally {
          await db.destroy();
        }
      });

      test("retention trims to the cap and prunes the oldest rows (output-preserving)", async () => {
        const { db } = await createInstrumentedTestDatabase();
        try {
          const cap = 5;
          const total = 12;
          for (let ts = 1; ts <= total; ts++) {
            await repo.record(repo.make(ts), db);
          }
          await flushPendingCleanups();

          await repo.cleanup(db, cap);

          const rows = await db
            .selectFrom(TABLE_BY_NAME[repo.name] as any)
            .select("timestamp")
            .orderBy("timestamp", "asc")
            .execute();
          const timestamps = rows.map((r: any) => Number(r.timestamp));

          // Existing semantics keep cap+1 rows (offset(cap) cutoff, strict-less-than delete).
          expect(timestamps).toEqual([7, 8, 9, 10, 11, 12]);
        } finally {
          await db.destroy();
        }
      });

      test("under the cap, cleanup prunes nothing", async () => {
        const { db } = await createInstrumentedTestDatabase();
        try {
          for (let ts = 1; ts <= 3; ts++) {
            await repo.record(repo.make(ts), db);
          }
          await flushPendingCleanups();

          await repo.cleanup(db, 10);

          const rows = await db
            .selectFrom(TABLE_BY_NAME[repo.name] as any)
            .select("timestamp")
            .execute();
          expect(rows).toHaveLength(3);
        } finally {
          await db.destroy();
        }
      });

      test("a cleanup failure is logged, not silently swallowed", async () => {
        const { db } = await createInstrumentedTestDatabase();
        const warnSpy = spyOn(logger, "warn");
        try {
          await db.destroy(); // force every subsequent query to throw
          await expect(repo.cleanup(db, 3)).resolves.toBeUndefined(); // never propagates
          expect(warnSpy).toHaveBeenCalled();
          const logged = warnSpy.mock.calls.map(c => String(c[0])).join("\n");
          expect(logged).toContain(TABLE_BY_NAME[repo.name]);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });
  }
});

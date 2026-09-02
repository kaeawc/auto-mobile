import { describe, expect, spyOn, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { runMigrations } from "../../src/db/migrator";
import { logger } from "../../src/utils/logger";
import {
  pruneEventTableByCount,
  type EventRetentionState,
  type EventTableName,
} from "../../src/db/eventRetention";
import {
  recordNetworkEvent,
  cleanupIfNeeded as cleanupNetwork,
} from "../../src/db/networkEventRepository";
import {
  recordLogEvent,
  recordLogEvents,
  cleanupIfNeeded as cleanupLog,
} from "../../src/db/logEventRepository";
import { recordOsEvent, recordOsEvents } from "../../src/db/osEventRepository";
import {
  recordNavigationEvent,
  recordNavigationEvents,
} from "../../src/db/navigationEventRepository";
import { recordLayoutEvent, recordLayoutEvents } from "../../src/db/layoutEventRepository";
import { recordStorageEvent } from "../../src/db/storageEventRepository";

/**
 * Retention behavior for the six telemetry event repositories (#2799).
 *
 * The retention scan is now *amortized*: `pruneEventTableByCount` runs the
 * `count(*)` gate at most once per `checkInterval` inserts instead of on every insert
 * (issue Option A). These tests lock in:
 *   1. amortization — the `count(*)` gate runs at most once per interval; the
 *      other N-1 calls are synchronous no-ops that touch neither the DB nor the
 *      re-entrancy guard,
 *   2. retention still trims to the cap and prunes the same rows (output-preserving),
 *   3. a cleanup failure is logged, not silently swallowed (CLAUDE.md convention).
 *
 * `maxRows` and `checkInterval` are injectable, so behavior is verified at a low
 * cap / interval without inserting 10k real rows or 256 to force a scan.
 * `checkInterval: 1` fires the scan on every call regardless of the module
 * counter's residual value, so behavior tests are deterministic and self-normalizing.
 */

/** In-memory test DB that also records every executed SQL string (for the amortization spy). */
async function createInstrumentedTestDatabase(): Promise<{ db: Kysely<Database>; sqls: string[] }> {
  const bunDb = new BunDatabase(":memory:");
  const sqls: string[] = [];
  const db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: bunDb }),
    log: (event) => {
      if (event.level === "query") {
        sqls.push(event.query.sql);
      }
    },
  });
  await runMigrations(db as Kysely<unknown>);
  return { db, sqls };
}

interface RepoUnderTest {
  name: string;
  table: EventTableName;
  record: (input: any, db?: Kysely<Database>) => Promise<unknown>;
  make: (timestamp: number) => any;
}

const REPOS: RepoUnderTest[] = [
  {
    name: "network",
    table: "network_events",
    record: recordNetworkEvent,
    make: (ts) => ({
      deviceId: "d1",
      timestamp: ts,
      applicationId: null,
      sessionId: null,
      url: "https://x/y",
      method: "GET",
      statusCode: 200,
      durationMs: 1,
      requestBodySize: 0,
      responseBodySize: 0,
      protocol: null,
      host: null,
      path: null,
      error: null,
    }),
  },
  {
    name: "log",
    table: "log_events",
    record: recordLogEvent,
    make: (ts) => ({
      deviceId: "d1",
      timestamp: ts,
      applicationId: null,
      sessionId: null,
      level: 3,
      tag: "T",
      message: "m",
      filterName: "f",
    }),
  },
  {
    name: "os",
    table: "os_events",
    record: recordOsEvent,
    make: (ts) => ({
      deviceId: "d1",
      timestamp: ts,
      applicationId: null,
      sessionId: null,
      category: "lifecycle",
      kind: "resume",
      details: null,
    }),
  },
  {
    name: "navigation",
    table: "navigation_events",
    record: recordNavigationEvent,
    make: (ts) => ({
      deviceId: "d1",
      timestamp: ts,
      applicationId: null,
      sessionId: null,
      destination: "Home",
      source: null,
      arguments: null,
      metadata: null,
    }),
  },
  {
    name: "layout",
    table: "layout_events",
    record: recordLayoutEvent,
    make: (ts) => ({
      deviceId: "d1",
      timestamp: ts,
      applicationId: null,
      sessionId: null,
      subType: "recomposition",
      composableName: null,
      composableId: null,
      recompositionCount: null,
      durationMs: null,
      likelyCause: null,
      detailsJson: null,
    }),
  },
  {
    name: "storage",
    table: "storage_events",
    record: recordStorageEvent,
    make: (ts) => ({
      deviceId: "d1",
      timestamp: ts,
      applicationId: null,
      sessionId: null,
      fileName: "prefs.xml",
      key: "k",
      value: "v",
      valueType: "string",
      changeType: "update",
    }),
  },
];

const countOccurrences = (sqls: string[], needle: string): number =>
  sqls.filter((s) => s.toLowerCase().includes(needle)).length;

function createRetentionState(): EventRetentionState {
  return { cleanupInProgress: false, insertsSinceCleanup: 0 };
}

async function cleanupRepo(
  repo: RepoUnderTest,
  db: Kysely<Database>,
  state: EventRetentionState,
  maxRows: number,
  checkInterval: number,
): Promise<void> {
  await pruneEventTableByCount(db, repo.table, state, maxRows, checkInterval);
}

describe("event repository retention (#2799)", () => {
  test("repository cleanup wrappers keep independent state and target their own table", async () => {
    const { db, sqls } = await createInstrumentedTestDatabase();
    try {
      const interval = 2;
      await cleanupNetwork(db, 1000, 1);
      await cleanupLog(db, 1000, 1);
      sqls.length = 0;

      await cleanupNetwork(db, 1000, interval);
      await cleanupLog(db, 1000, interval);
      expect(sqls).toHaveLength(0);

      await cleanupNetwork(db, 1000, interval);
      expect(countOccurrences(sqls, 'from "network_events"')).toBe(1);
      expect(countOccurrences(sqls, 'from "log_events"')).toBe(0);

      sqls.length = 0;
      await cleanupLog(db, 1000, interval);
      expect(countOccurrences(sqls, 'from "network_events"')).toBe(0);
      expect(countOccurrences(sqls, 'from "log_events"')).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  describe("batched multi-row INSERT (#3138)", () => {
    const BATCH_REPOS = [
      {
        name: "log",
        table: "log_events" as EventTableName,
        record: recordLogEvents,
        make: REPOS[1].make,
      },
      {
        name: "os",
        table: "os_events" as EventTableName,
        record: recordOsEvents,
        make: REPOS[2].make,
      },
      {
        name: "navigation",
        table: "navigation_events" as EventTableName,
        record: recordNavigationEvents,
        make: REPOS[3].make,
      },
      {
        name: "layout",
        table: "layout_events" as EventTableName,
        record: recordLayoutEvents,
        make: REPOS[4].make,
      },
    ];

    for (const repo of BATCH_REPOS) {
      test(`${repo.name}: writes all rows in one INSERT statement`, async () => {
        const { db, sqls } = await createInstrumentedTestDatabase();
        try {
          sqls.length = 0;
          await repo.record([repo.make(1), repo.make(2), repo.make(3)], db);
          const inserts = sqls.filter((s) =>
            s.toLowerCase().includes(`insert into "${repo.table}"`),
          );
          expect(inserts).toHaveLength(1);

          const rows = await db
            .selectFrom(repo.table as any)
            .select("timestamp")
            .orderBy("timestamp", "asc")
            .execute();
          expect(rows.map((r: any) => Number(r.timestamp))).toEqual([1, 2, 3]);
        } finally {
          await db.destroy();
        }
      });

      test(`${repo.name}: empty batch is a no-op`, async () => {
        const { db, sqls } = await createInstrumentedTestDatabase();
        try {
          sqls.length = 0;
          await repo.record([], db);
          expect(sqls.filter((s) => s.toLowerCase().includes("insert into"))).toHaveLength(0);
        } finally {
          await db.destroy();
        }
      });
    }
  });

  for (const repo of REPOS) {
    describe(repo.name, () => {
      test("amortizes: count(*) gate runs at most once per checkInterval", async () => {
        const { db, sqls } = await createInstrumentedTestDatabase();
        try {
          const interval = 5;
          const state = createRetentionState();
          // Drain any residual counter to a known state; this fires one scan.
          await cleanupRepo(repo, db, state, 1000, 1);
          sqls.length = 0;

          // The first interval-1 calls must be pure no-ops: no DB query at all.
          for (let i = 0; i < interval - 1; i++) {
            await cleanupRepo(repo, db, state, 1000, interval);
          }
          expect(sqls).toHaveLength(0);

          // The interval-th call fires exactly one count(*) gate.
          await cleanupRepo(repo, db, state, 1000, interval);
          expect(countOccurrences(sqls, "count(")).toBe(1);
        } finally {
          await db.destroy();
        }
      });

      test("retention trims to exactly the cap and prunes the oldest rows (#3137)", async () => {
        const { db } = await createInstrumentedTestDatabase();
        try {
          const cap = 5;
          for (let ts = 1; ts <= 12; ts++) {
            await repo.record(repo.make(ts), db);
          }
          // checkInterval: 1 forces the scan to run now, regardless of the counter.
          await cleanupRepo(repo, db, createRetentionState(), cap, 1);

          const rows = await db
            .selectFrom(repo.table as any)
            .select("timestamp")
            .orderBy("timestamp", "asc")
            .execute();
          const timestamps = rows.map((r: any) => Number(r.timestamp));

          // Canonical idiom (#3137): trims to *exactly* cap rows — the cap newest.
          // (The prior offset(cap) + strict-less-than form kept cap+1: [7..12].)
          expect(timestamps).toEqual([8, 9, 10, 11, 12]);
        } finally {
          await db.destroy();
        }
      });

      test("same-timestamp rows at the cutoff are broken by id (#3137)", async () => {
        const { db } = await createInstrumentedTestDatabase();
        try {
          const cap = 3;
          // Five rows all sharing timestamp 100. The prior `timestamp < cutoff`
          // form could never delete any of them (all equal to the cutoff),
          // retaining all five. The id-tiebreak form trims to exactly cap by
          // deleting the lowest-id rows at the tied timestamp.
          for (let i = 0; i < 5; i++) {
            await repo.record(repo.make(100), db);
          }
          // Not every repo's record() returns the id, so read them from the DB.
          const beforeRows = await db
            .selectFrom(repo.table as any)
            .select("id")
            .orderBy("id", "asc")
            .execute();
          const ids = beforeRows.map((r: any) => Number(r.id));

          await cleanupRepo(repo, db, createRetentionState(), cap, 1);

          const rows = await db
            .selectFrom(repo.table as any)
            .select("id")
            .orderBy("id", "asc")
            .execute();
          const remaining = rows.map((r: any) => Number(r.id));

          // Exactly the cap highest ids survive; the two oldest (lowest id) are pruned.
          expect(remaining).toEqual(ids.slice(-cap));
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
          await cleanupRepo(repo, db, createRetentionState(), 10, 1);

          const rows = await db
            .selectFrom(repo.table as any)
            .select("timestamp")
            .execute();
          expect(rows).toHaveLength(3);
        } finally {
          await db.destroy();
        }
      });

      test("batch amortization counter advances by whole batch size (#3138)", async () => {
        const { db, sqls } = await createInstrumentedTestDatabase();
        try {
          const interval = 5;
          const state = createRetentionState();
          sqls.length = 0;
          // A single call reporting `inserted: interval` must immediately arm the
          // gate — a batched INSERT of N rows counts as N, not 1.
          await pruneEventTableByCount(db, repo.table, state, 1000, interval, interval);
          expect(countOccurrences(sqls, "count(")).toBe(1);

          // And a call reporting fewer than the interval does NOT fire the gate.
          sqls.length = 0;
          const state2 = createRetentionState();
          await pruneEventTableByCount(db, repo.table, state2, 1000, interval, interval - 1);
          expect(countOccurrences(sqls, "count(")).toBe(0);
        } finally {
          await db.destroy();
        }
      });

      test("a cleanup failure is logged, not silently swallowed", async () => {
        const { db } = await createInstrumentedTestDatabase();
        const warnSpy = spyOn(logger, "warn");
        try {
          await db.destroy(); // force every subsequent query to throw
          // checkInterval: 1 so the scan actually runs (and then throws).
          await expect(
            cleanupRepo(repo, db, createRetentionState(), 3, 1),
          ).resolves.toBeUndefined(); // never propagates
          expect(warnSpy).toHaveBeenCalled();
          const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
          expect(logged).toContain(repo.table);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });
  }
});

import { describe, expect, spyOn, test } from "bun:test";
import type { Database as BunDatabase } from "bun:sqlite";
import { BunSqliteConnectionState } from "../../src/db/bunSqliteDialect";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

/**
 * Periodic `PRAGMA optimize` for a long-lived daemon connection (#3497).
 *
 * The optimize runs on a low-frequency timer using the connection's injected
 * `Timer`, so these tests drive a `FakeTimer` and a fake `bun:sqlite` handle to
 * prove — deterministically and <100ms — that it fires on the interval, repeats,
 * swallows/logs failures without throwing, is disabled by default, does not
 * force-open a lazy connection, and stops on close.
 */

// Minimal fake of the bun:sqlite surface the connection touches. Records every
// `exec()` SQL; optionally makes `exec` throw to exercise the best-effort path.
function makeFakeDb(opts: { execThrows?: boolean } = {}): { db: BunDatabase; execs: string[] } {
  const execs: string[] = [];
  const db = {
    prepare: (_sql: string) => ({
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => ({ schema_version: 0 }),
      finalize: () => {},
    }),
    exec: (sql: string) => {
      execs.push(sql);
      if (opts.execThrows) {
        throw new Error("optimize boom");
      }
    },
    close: () => {},
  } as unknown as BunDatabase;
  return { db, execs };
}

const optimizeCount = (execs: string[]): number =>
  execs.filter((s) => s.includes("PRAGMA optimize")).length;

describe("periodic PRAGMA optimize (#3497)", () => {
  test("fires on the interval and repeats", () => {
    const timer = new FakeTimer();
    const { db, execs } = makeFakeDb();
    new BunSqliteConnectionState(db, undefined, { timer }, 1000);

    expect(optimizeCount(execs)).toBe(0);

    timer.advanceTime(1000);
    expect(optimizeCount(execs)).toBe(1);

    timer.advanceTime(1000);
    expect(optimizeCount(execs)).toBe(2);
  });

  test("swallows and logs an optimize failure without throwing", () => {
    const timer = new FakeTimer();
    const { db } = makeFakeDb({ execThrows: true });
    const debugSpy = spyOn(logger, "debug");
    try {
      new BunSqliteConnectionState(db, undefined, { timer }, 1000);

      expect(() => timer.advanceTime(1000)).not.toThrow();
      const logged = debugSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("periodic PRAGMA optimize failed");
    } finally {
      debugSpy.mockRestore();
    }
  });

  test("is disabled when no interval is configured", () => {
    const timer = new FakeTimer();
    const { db, execs } = makeFakeDb();
    new BunSqliteConnectionState(db, undefined, { timer });

    timer.advanceTime(100_000);
    expect(optimizeCount(execs)).toBe(0);
  });

  test("does not force-open a lazy connection", () => {
    const timer = new FakeTimer();
    let opened = false;
    const source = (): BunDatabase => {
      opened = true;
      return makeFakeDb().db;
    };
    new BunSqliteConnectionState(source, undefined, { timer }, 1000);

    timer.advanceTime(5000);
    // The tick skips when the connection has not been opened by a query yet,
    // rather than opening one just to optimize.
    expect(opened).toBe(false);
  });

  test("stops firing after close", () => {
    const timer = new FakeTimer();
    const { db, execs } = makeFakeDb();
    const state = new BunSqliteConnectionState(db, undefined, { timer }, 1000);

    state.close(); // runs the close-time optimize once, then clears the timer
    const afterClose = optimizeCount(execs);

    timer.advanceTime(10_000);
    expect(optimizeCount(execs)).toBe(afterClose);
  });
});

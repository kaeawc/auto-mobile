import { describe, expect, it, spyOn } from "bun:test";
import type { Database as BunDatabase } from "bun:sqlite";
import { CompiledQuery } from "kysely";
import {
  BunSqliteConnectionState,
  DEFAULT_RETRY_TOTAL_WAIT_MS,
} from "../../src/db/bunSqliteDialect";
import {
  APP_CONNECTION_MAX_RETRY_ATTEMPTS,
  SQLITE_APP_CONNECTION_BUSY_TIMEOUT_MS,
  SQLITE_BUSY_TIMEOUT_MS,
} from "../../src/db/database";
import { logger } from "../../src/utils/logger";
import type { Random } from "../../src/utils/Random";
import { FakeTimer } from "../fakes/FakeTimer";

const zeroRandom: Random = { next: () => 0, pick: <T>(items: readonly T[]) => items[0]! };
const WRITE = CompiledQuery.raw("insert into t values (1)");
const MAX_BACKOFF_MS = 50;

function contendedConnection(releaseAtMs = Infinity) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
  const attempts: { durationMs: number; sleepsBefore: number }[] = [];
  const attempt = () => {
    const start = timer.now();
    timer.advanceTime(SQLITE_APP_CONNECTION_BUSY_TIMEOUT_MS);
    attempts.push({
      durationMs: timer.now() - start,
      sleepsBefore: timer.getSleepHistory().length,
    });
    if (timer.now() < releaseAtMs) {
      throw busy;
    }
  };
  const db = {
    prepare: () => ({
      all: () => {
        attempt();
        return [];
      },
      run: () => {
        attempt();
        return { changes: 1, lastInsertRowid: 1 };
      },
      get: () => ({ schema_version: 0 }),
      finalize: () => {},
    }),
    exec: () => {},
    close: () => {},
  } as unknown as BunDatabase;
  const state = new BunSqliteConnectionState(db, undefined, {
    maxAttempts: APP_CONNECTION_MAX_RETRY_ATTEMPTS,
    timer,
    random: zeroRandom,
  });
  return { state, timer, busy, attempts };
}

describe("app connection busy retry", () => {
  it("pins short app waits, enough attempts and the unchanged migration wait", () => {
    expect(SQLITE_APP_CONNECTION_BUSY_TIMEOUT_MS).toBeLessThanOrEqual(250);
    expect(APP_CONNECTION_MAX_RETRY_ATTEMPTS).toBe(
      Math.ceil(DEFAULT_RETRY_TOTAL_WAIT_MS / SQLITE_APP_CONNECTION_BUSY_TIMEOUT_MS) + 1,
    );
    expect(
      APP_CONNECTION_MAX_RETRY_ATTEMPTS * SQLITE_APP_CONNECTION_BUSY_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(DEFAULT_RETRY_TOTAL_WAIT_MS);
    expect(SQLITE_BUSY_TIMEOUT_MS).toBe(5000);
  });

  for (const operation of ["write", "begin"] as const) {
    it(`retries an autocommit ${operation} until the peer releases at 3 s, yielding every time`, async () => {
      const { state, timer, attempts } = contendedConnection(3000);
      if (operation === "write") {
        await state.executeQuery(WRITE, Symbol("write"));
      } else {
        await state.beginTransaction(Symbol("begin"));
      }
      expect(timer.now()).toBeGreaterThanOrEqual(3000);
      expect(attempts.length).toBeGreaterThan(3);
      expect(timer.getSleepHistory()).toHaveLength(attempts.length - 1);
      attempts.forEach((attempt, index) => {
        expect(attempt.sleepsBefore).toBe(index);
        expect(attempt.durationMs).toBeLessThanOrEqual(SQLITE_APP_CONNECTION_BUSY_TIMEOUT_MS);
      });
    });
  }

  it("stops at the deadline plus one short attempt and backoff, preserving BUSY", async () => {
    const { state, timer, busy, attempts } = contendedConnection();
    const error = await state.executeQuery(WRITE, Symbol("write")).then(
      () => {
        throw new Error("Expected BUSY");
      },
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBe(busy);
    expect(timer.now()).toBeGreaterThanOrEqual(DEFAULT_RETRY_TOTAL_WAIT_MS);
    expect(timer.now()).toBeLessThanOrEqual(
      DEFAULT_RETRY_TOTAL_WAIT_MS + SQLITE_APP_CONNECTION_BUSY_TIMEOUT_MS + MAX_BACKOFF_MS,
    );
    expect(timer.getSleepHistory()).toHaveLength(attempts.length - 1);
    attempts.forEach((attempt) =>
      expect(attempt.durationMs).toBeLessThanOrEqual(SQLITE_APP_CONNECTION_BUSY_TIMEOUT_MS),
    );
  });

  it("warns on the first retry and debugs subsequent retries", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const { state, attempts } = contendedConnection(3000);
      await state.executeQuery(WRITE, Symbol("write"));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(
        /^SQLite busy\/locked \(attempt 1\/21\); retrying in \d+ms: /,
      );
      const retries = debug.mock.calls.filter(
        ([message]: Parameters<typeof logger.debug>) =>
          typeof message === "string" && message.startsWith("SQLite busy/locked"),
      );
      expect(retries).toHaveLength(attempts.length - 2);
      expect(retries[0]?.[0]).toContain("attempt 2/21");
    } finally {
      warn.mockRestore();
      debug.mockRestore();
    }
  });
});

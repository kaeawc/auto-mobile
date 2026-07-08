import { describe, expect, test } from "bun:test";
import { DefaultDatabaseHealthProbe } from "../../src/db/DatabaseHealthProbe";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeProbeConnection {
  execStatements: string[] = [];
  queryStatements: string[] = [];
  closed = false;

  exec(sql: string): void {
    this.execStatements.push(sql);
  }

  query(sql: string): { get: () => { ok: number } } {
    this.queryStatements.push(sql);
    return {
      get: () => ({ ok: 1 }),
    };
  }

  close(): void {
    this.closed = true;
  }
}

describe("DefaultDatabaseHealthProbe", () => {
  test("throws a cached migration error without issuing SELECT 1", async () => {
    const migrationError = new Error("startup migration failed");
    let openCalls = 0;
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => migrationError,
      openProbeConnection: () => {
        openCalls += 1;
        return new FakeProbeConnection();
      },
    });

    await expect(probe.check()).rejects.toBe(migrationError);
    expect(openCalls).toBe(0);
  });

  test("issues a lightweight SELECT 1 with a short SQLite busy timeout", async () => {
    const connection = new FakeProbeConnection();
    const openedPaths: string[] = [];
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => null,
      getDatabasePath: () => ":memory:",
      openProbeConnection: dbPath => {
        openedPaths.push(dbPath);
        return connection;
      },
    });

    await probe.check();

    expect(openedPaths).toEqual([":memory:"]);
    expect(connection.execStatements).toEqual(["PRAGMA busy_timeout = 50;"]);
    expect(connection.queryStatements).toEqual(["SELECT 1 as ok"]);
    expect(connection.closed).toBe(true);
  });

  test("bounds a wedged SELECT 1 probe", async () => {
    const timer = new FakeTimer();
    const probe = new DefaultDatabaseHealthProbe({
      timer,
      getMigrationsError: () => null,
      executeSelectOne: () => new Promise(() => {}),
      timeoutMs: 25,
    });

    await expect(timer.resolvePromise(probe.check(), 25)).rejects.toThrow(
      "Database health probe timed out after 25ms"
    );
  });
});

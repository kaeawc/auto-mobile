import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { DefaultDatabaseHealthProbe } from "../../src/db/DatabaseHealthProbe";
import { FakeTimer } from "../fakes/FakeTimer";

interface SqliteSetupConnection {
  exec(sql: string): unknown;
  close(): void;
}

type BunDatabaseConstructor = new (dbPath: string) => SqliteSetupConnection;

function createSqliteFile(dbPath: string): void {
  const { Database } = require("bun:sqlite") as { Database: BunDatabaseConstructor };
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE probe_smoke (id INTEGER PRIMARY KEY)");
  } finally {
    db.close();
  }
}

describe("DefaultDatabaseHealthProbe", () => {
  let tempDirs: string[] = [];

  afterEach(async () => {
    for (const tempDir of tempDirs) {
      await rm(tempDir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  test("throws a cached migration error without issuing SELECT 1", async () => {
    const migrationError = new Error("startup migration failed");
    let selectCalls = 0;
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => migrationError,
      executeSelectOne: async () => {
        selectCalls += 1;
      },
    });

    await expect(probe.check()).rejects.toBe(migrationError);
    expect(selectCalls).toBe(0);
  });

  test("resolves after a worker-backed SELECT 1 against a real read-only sqlite file", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "auto-mobile-health-probe-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "auto-mobile.db");
    createSqliteFile(dbPath);
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => null,
      getDatabasePath: () => dbPath,
    });

    // A healthy DB makes the worker post `{ ok: true }`; check() resolves.
    await expect(probe.check()).resolves.toBeUndefined();
  });

  test("rejects with the worker's error envelope when the sqlite file cannot be opened", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "auto-mobile-health-probe-"));
    tempDirs.push(tempDir);
    // A path under a non-existent directory: the readonly/create:false worker
    // connection cannot open it, so the worker posts `{ ok: false, message }`
    // and check() must reject with that message (the ok:false envelope).
    const missingPath = join(tempDir, "missing-subdir", "auto-mobile.db");
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => null,
      getDatabasePath: () => missingPath,
    });

    await expect(probe.check()).rejects.toThrow(/unable to open database file/);
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
      "Database health probe timed out after 25ms",
    );
  });
});

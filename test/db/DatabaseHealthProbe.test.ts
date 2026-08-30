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

class FakeProbeWorker {
  private messageListener: ((message: { id: number; ok: boolean }) => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;
  private exitListener: ((code: number) => void) | undefined;
  terminateCalls = 0;

  postMessage(message: { id: number }): void {
    queueMicrotask(() => this.messageListener?.({ id: message.id, ok: true }));
  }

  on(
    event: "message" | "error" | "exit",
    listener:
      | ((message: { id: number; ok: boolean }) => void)
      | ((error: Error) => void)
      | ((code: number) => void),
  ): this {
    if (event === "message") {
      this.messageListener = listener as (message: { id: number; ok: boolean }) => void;
    } else if (event === "error") {
      this.errorListener = listener as (error: Error) => void;
    } else if (event === "exit") {
      this.exitListener = listener as (code: number) => void;
    }
    return this;
  }

  async terminate(): Promise<number> {
    this.terminateCalls++;
    this.exitListener?.(0);
    return 0;
  }

  fail(error: Error): void {
    this.errorListener?.(error);
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

  test("reuses one worker across checks and terminates it on dispose", async () => {
    const workers: FakeProbeWorker[] = [];
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => null,
      getDatabasePath: () => "/tmp/auto-mobile-test.db",
      workerFactory: () => {
        const worker = new FakeProbeWorker();
        workers.push(worker);
        return worker;
      },
    });

    await probe.check();
    await probe.check();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminateCalls).toBe(0);

    await probe.dispose();
    expect(workers[0]?.terminateCalls).toBe(1);
  });

  test("replaces a worker that fails between checks", async () => {
    const workers: FakeProbeWorker[] = [];
    const probe = new DefaultDatabaseHealthProbe({
      getMigrationsError: () => null,
      getDatabasePath: () => "/tmp/auto-mobile-test.db",
      workerFactory: () => {
        const worker = new FakeProbeWorker();
        workers.push(worker);
        return worker;
      },
    });

    await probe.check();
    workers[0]?.fail(new Error("worker stopped"));
    await probe.check();

    expect(workers).toHaveLength(2);
  });
});

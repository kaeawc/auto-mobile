import { existsSync } from "node:fs";
import { getDatabasePath, getMigrationsError } from "./database";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

const DATABASE_HEALTH_PROBE_TIMEOUT_MS = 1_000;
const DATABASE_HEALTH_PROBE_BUSY_TIMEOUT_MS = 50;

interface SqliteProbeConnection {
  exec(sql: string): unknown;
  query(sql: string): {
    get(): unknown;
  };
  close(): void;
}

type BunDatabaseConstructor = new (
  dbPath: string,
  options?: { readonly?: boolean; create?: boolean }
) => SqliteProbeConnection;

export interface DatabaseHealthProbe {
  check(): Promise<void>;
}

interface DatabaseHealthProbeDependencies {
  timer?: Timer;
  getMigrationsError?: () => Error | null;
  executeSelectOne?: () => Promise<unknown>;
  getDatabasePath?: () => string;
  openProbeConnection?: (dbPath: string) => SqliteProbeConnection;
  timeoutMs?: number;
  sqliteBusyTimeoutMs?: number;
}

export class DefaultDatabaseHealthProbe implements DatabaseHealthProbe {
  private readonly timer: Timer;
  private readonly getMigrationsError: () => Error | null;
  private readonly executeSelectOne: () => Promise<unknown>;
  private readonly getDatabasePath: () => string;
  private readonly openProbeConnection: (dbPath: string) => SqliteProbeConnection;
  private readonly timeoutMs: number;
  private readonly sqliteBusyTimeoutMs: number;

  constructor(dependencies: DatabaseHealthProbeDependencies = {}) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.getMigrationsError = dependencies.getMigrationsError ?? getMigrationsError;
    this.getDatabasePath = dependencies.getDatabasePath ?? getDatabasePath;
    this.openProbeConnection = dependencies.openProbeConnection ?? openReadonlyProbeConnection;
    this.executeSelectOne = dependencies.executeSelectOne ?? (() => {
      this.executeSqliteSelectOne();
      return Promise.resolve();
    });
    this.timeoutMs = dependencies.timeoutMs ?? DATABASE_HEALTH_PROBE_TIMEOUT_MS;
    this.sqliteBusyTimeoutMs = dependencies.sqliteBusyTimeoutMs ?? DATABASE_HEALTH_PROBE_BUSY_TIMEOUT_MS;
  }

  async check(): Promise<void> {
    const migrationsError = this.getMigrationsError();
    if (migrationsError) {
      throw migrationsError;
    }

    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this.executeSelectOne(),
        new Promise<never>((_, reject) => {
          timeoutHandle = this.timer.setTimeout(() => {
            reject(new Error(`Database health probe timed out after ${this.timeoutMs}ms`));
          }, this.timeoutMs);
          if (typeof (timeoutHandle as { unref?: () => void }).unref === "function") {
            (timeoutHandle as { unref: () => void }).unref();
          }
        }),
      ]);
    } finally {
      if (timeoutHandle) {
        this.timer.clearTimeout(timeoutHandle);
      }
    }
  }

  private executeSqliteSelectOne(): void {
    const dbPath = this.getDatabasePath();
    if (dbPath !== ":memory:" && !existsSync(dbPath)) {
      throw new Error(`Database health probe path does not exist: ${dbPath}`);
    }

    const connection = this.openProbeConnection(dbPath);
    try {
      connection.exec(`PRAGMA busy_timeout = ${this.sqliteBusyTimeoutMs};`);
      connection.query("SELECT 1 as ok").get();
    } finally {
      connection.close();
    }
  }
}

function openReadonlyProbeConnection(dbPath: string): SqliteProbeConnection {
  const { Database } = require("bun:sqlite") as { Database: BunDatabaseConstructor };
  return new Database(dbPath, { readonly: true, create: false }) as SqliteProbeConnection;
}

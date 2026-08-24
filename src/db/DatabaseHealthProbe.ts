import { Worker } from "node:worker_threads";
import { getDatabasePath, getMigrationsError } from "./database";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

const DATABASE_HEALTH_PROBE_TIMEOUT_MS = 1_000;
const DATABASE_HEALTH_PROBE_BUSY_TIMEOUT_MS = 50;

export interface DatabaseHealthProbe {
  check(): Promise<void>;
}

interface DatabaseHealthProbeDependencies {
  timer?: Timer;
  getMigrationsError?: () => Error | null;
  executeSelectOne?: () => Promise<unknown>;
  getDatabasePath?: () => string;
  timeoutMs?: number;
  sqliteBusyTimeoutMs?: number;
}

export class DefaultDatabaseHealthProbe implements DatabaseHealthProbe {
  private readonly timer: Timer;
  private readonly getMigrationsError: () => Error | null;
  private readonly executeSelectOne: () => Promise<unknown>;
  private readonly getDatabasePath: () => string;
  private readonly timeoutMs: number;
  private readonly sqliteBusyTimeoutMs: number;

  constructor(dependencies: DatabaseHealthProbeDependencies = {}) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.getMigrationsError = dependencies.getMigrationsError ?? getMigrationsError;
    this.getDatabasePath = dependencies.getDatabasePath ?? getDatabasePath;
    this.timeoutMs = dependencies.timeoutMs ?? DATABASE_HEALTH_PROBE_TIMEOUT_MS;
    this.sqliteBusyTimeoutMs =
      dependencies.sqliteBusyTimeoutMs ?? DATABASE_HEALTH_PROBE_BUSY_TIMEOUT_MS;
    this.executeSelectOne =
      dependencies.executeSelectOne ??
      (() =>
        executeSqliteSelectOneInWorker(
          this.getDatabasePath(),
          this.sqliteBusyTimeoutMs,
          this.timeoutMs,
          this.timer,
        ));
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
}

function executeSqliteSelectOneInWorker(
  dbPath: string,
  sqliteBusyTimeoutMs: number,
  timeoutMs: number,
  timer: Timer,
): Promise<void> {
  const worker = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    try {
      const { Database } = require("bun:sqlite");
      const db = new Database(workerData.dbPath, { readonly: true, create: false });
      try {
        db.exec("PRAGMA busy_timeout = " + Number(workerData.sqliteBusyTimeoutMs) + ";");
        db.query("SELECT 1 as ok").get();
        parentPort.postMessage({ ok: true });
      } finally {
        db.close();
      }
    } catch (error) {
      parentPort.postMessage({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  `,
    {
      eval: true,
      workerData: { dbPath, sqliteBusyTimeoutMs },
    },
  );

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      timer.clearTimeout(timeoutHandle);
      callback();
    };
    const timeoutHandle = timer.setTimeout(() => {
      void worker.terminate();
      finish(() => reject(new Error(`Database health probe timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    if (typeof (timeoutHandle as { unref?: () => void }).unref === "function") {
      (timeoutHandle as { unref: () => void }).unref();
    }

    worker.once("message", (message: { ok: boolean; message?: string; stack?: string }) => {
      void worker.terminate();
      if (message.ok) {
        finish(resolve);
        return;
      }
      const error = new Error(message.message ?? "Database health probe failed");
      if (message.stack) {
        error.stack = message.stack;
      }
      finish(() => reject(error));
    });
    worker.once("error", (error) => {
      void worker.terminate();
      finish(() => reject(error));
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(() => reject(new Error(`Database health probe worker exited with code ${code}`)));
      }
    });
  });
}

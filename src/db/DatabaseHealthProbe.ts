import { Worker } from "node:worker_threads";
import { getDatabasePath, getMigrationsError } from "./database";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

const DATABASE_HEALTH_PROBE_TIMEOUT_MS = 1_000;
const DATABASE_HEALTH_PROBE_BUSY_TIMEOUT_MS = 50;
const SQLITE_PROBE_WORKER_SOURCE = `
  const { parentPort, workerData } = require("node:worker_threads");
  const { Database } = require("bun:sqlite");
  const db = new Database(workerData.dbPath, { readonly: true, create: false });
  db.exec("PRAGMA busy_timeout = " + Number(workerData.sqliteBusyTimeoutMs) + ";");
  parentPort.on("message", (request) => {
    try {
      db.query("SELECT 1 as ok").get();
      parentPort.postMessage({ id: request.id, ok: true });
    } catch (error) {
      parentPort.postMessage({
        id: request.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  });
`;

export interface DatabaseHealthProbe {
  check(): Promise<void>;
  dispose?(): Promise<void>;
}

interface ProbeWorker {
  postMessage(message: { id: number }): void;
  on(event: "message", listener: (message: ProbeWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface ProbeWorkerMessage {
  id: number;
  ok: boolean;
  message?: string;
  stack?: string;
}

interface DatabaseHealthProbeDependencies {
  timer?: Timer;
  getMigrationsError?: () => Error | null;
  executeSelectOne?: () => Promise<unknown>;
  getDatabasePath?: () => string;
  timeoutMs?: number;
  sqliteBusyTimeoutMs?: number;
  workerFactory?: (source: string, workerData: Record<string, unknown>) => ProbeWorker;
}

export class DefaultDatabaseHealthProbe implements DatabaseHealthProbe {
  private readonly timer: Timer;
  private readonly getMigrationsError: () => Error | null;
  private readonly executeSelectOne: () => Promise<unknown>;
  private readonly getDatabasePath: () => string;
  private readonly timeoutMs: number;
  private readonly sqliteBusyTimeoutMs: number;
  private readonly workerFactory: (
    source: string,
    workerData: Record<string, unknown>,
  ) => ProbeWorker;
  private worker: ProbeWorker | null = null;
  private workerRequestId = 0;
  private pendingRequest: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(dependencies: DatabaseHealthProbeDependencies = {}) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.getMigrationsError = dependencies.getMigrationsError ?? getMigrationsError;
    this.getDatabasePath = dependencies.getDatabasePath ?? getDatabasePath;
    this.timeoutMs = dependencies.timeoutMs ?? DATABASE_HEALTH_PROBE_TIMEOUT_MS;
    this.sqliteBusyTimeoutMs =
      dependencies.sqliteBusyTimeoutMs ?? DATABASE_HEALTH_PROBE_BUSY_TIMEOUT_MS;
    this.workerFactory =
      dependencies.workerFactory ??
      ((source, workerData) => new Worker(source, { eval: true, workerData }));
    this.executeSelectOne =
      dependencies.executeSelectOne ?? (() => this.executeSelectOneInWorker());
  }

  async check(): Promise<void> {
    const migrationsError = this.getMigrationsError();
    if (migrationsError) {
      throw migrationsError;
    }

    // check() owns the SINGLE authoritative timeout for the whole probe.
    // executeSelectOneInWorker() no longer arms an independent timer of its
    // own (issue #6655): racing two equal-duration timeouts made the
    // observed outcome depend on which one a given Timer/runtime happened to
    // fire first, rather than on explicit code. If this timeout wins the
    // race, abandon any in-flight worker round-trip so pendingRequest never
    // outlives check() and a subsequent check() always attempts a fresh
    // probe instead of short-circuiting on "already running".
    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        this.executeSelectOne(),
        new Promise<never>((_, reject) => {
          timeoutHandle = this.timer.setTimeout(() => {
            this.abandonPendingWorkerRequest();
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

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (this.pendingRequest) {
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      pending.reject(new Error("Database health probe disposed"));
    }
    if (worker) {
      await worker.terminate();
    }
  }

  /**
   * Clear any in-flight worker request and null out the worker so a fresh
   * one is created on the next check(). Used when check()'s own timeout
   * fires while a worker round-trip is still pending — the worker is
   * abandoned (terminated fire-and-forget) rather than left to eventually
   * settle a request nobody is awaiting anymore.
   */
  private abandonPendingWorkerRequest(): void {
    const worker = this.worker;
    this.worker = null;
    this.pendingRequest = null;
    if (worker) {
      void worker.terminate();
    }
  }

  private executeSelectOneInWorker(): Promise<void> {
    if (this.pendingRequest) {
      return Promise.reject(new Error("Database health probe is already running"));
    }
    const worker = this.getWorker();
    const requestId = ++this.workerRequestId;
    return new Promise<void>((resolve, reject) => {
      this.pendingRequest = { resolve, reject };
      worker.postMessage({ id: requestId });
    });
  }

  private getWorker(): ProbeWorker {
    if (this.worker) {
      return this.worker;
    }
    const worker = this.workerFactory(SQLITE_PROBE_WORKER_SOURCE, {
      dbPath: this.getDatabasePath(),
      sqliteBusyTimeoutMs: this.sqliteBusyTimeoutMs,
    });
    worker.on("message", (message: ProbeWorkerMessage) => {
      if (this.worker !== worker || !this.pendingRequest || message.id !== this.workerRequestId) {
        return;
      }
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      if (message.ok) {
        pending.resolve();
        return;
      }
      const error = new Error(message.message ?? "Database health probe failed");
      if (message.stack) {
        error.stack = message.stack;
      }
      pending.reject(error);
    });
    worker.on("error", (error) => {
      if (this.worker !== worker) {
        return;
      }
      this.worker = null;
      if (!this.pendingRequest) {
        return;
      }
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      pending.reject(error);
    });
    worker.on("exit", (code) => {
      if (this.worker !== worker || code === 0) {
        return;
      }
      this.worker = null;
      if (!this.pendingRequest) {
        return;
      }
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      pending.reject(new Error(`Database health probe worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }
}

import { DatabaseHealthProbeInitTimeoutError } from "./DatabaseHealthProbeInitTimeoutError";
import { DatabaseHealthProbeTimeoutError } from "./DatabaseHealthProbeTimeoutError";
import { Worker } from "node:worker_threads";
import { getDatabasePath, getMigrationsError } from "./database";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { logger } from "../utils/logger";

const DATABASE_HEALTH_PROBE_TIMEOUT_MS = 1_000;
const DATABASE_HEALTH_PROBE_INIT_TIMEOUT_MS = 10_000;
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
  parentPort.postMessage({ type: "ready" });
`;

export interface DatabaseHealthProbe {
  check(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface ProbeWorker {
  postMessage(message: { id: number }): void;
  on(event: "message", listener: (message: ProbeWorkerMessage) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

interface ProbeWorkerResponse {
  id: number;
  ok: boolean;
  message?: string;
  stack?: string;
}

export type ProbeWorkerMessage = { type: "ready" } | ProbeWorkerResponse;

interface ProbeWorkerState {
  worker: ProbeWorker;
  readiness: Promise<void>;
  ready: boolean;
  startedAt: number;
  resolveReady: () => void;
  rejectReady: (error: Error) => void;
}

interface DatabaseHealthProbeDependencies {
  timer?: Timer;
  getMigrationsError?: () => Error | null;
  executeSelectOne?: () => Promise<unknown>;
  getDatabasePath?: () => string;
  timeoutMs?: number;
  initTimeoutMs?: number;
  sqliteBusyTimeoutMs?: number;
  workerFactory?: (source: string, workerData: Record<string, unknown>) => ProbeWorker;
}

export class DefaultDatabaseHealthProbe implements DatabaseHealthProbe {
  private readonly timer: Timer;
  private readonly getMigrationsError: () => Error | null;
  private readonly executeSelectOne?: () => Promise<unknown>;
  private readonly getDatabasePath: () => string;
  private readonly timeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly sqliteBusyTimeoutMs: number;
  private readonly workerFactory: (
    source: string,
    workerData: Record<string, unknown>,
  ) => ProbeWorker;
  private worker: ProbeWorkerState | null = null;
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
    this.initTimeoutMs = dependencies.initTimeoutMs ?? DATABASE_HEALTH_PROBE_INIT_TIMEOUT_MS;
    this.sqliteBusyTimeoutMs =
      dependencies.sqliteBusyTimeoutMs ?? DATABASE_HEALTH_PROBE_BUSY_TIMEOUT_MS;
    this.workerFactory =
      dependencies.workerFactory ??
      ((source, workerData) => new Worker(source, { eval: true, workerData }));
    this.executeSelectOne = dependencies.executeSelectOne;
  }

  async check(): Promise<void> {
    const migrationsError = this.getMigrationsError();
    if (migrationsError) {
      throw migrationsError;
    }

    // The injected executor retains its single whole-call deadline. Only the
    // default worker path separates cold startup from the SQL round-trip.
    const startupStartedAt = this.timer.monotonicNow?.() ?? this.timer.now();
    const worker = this.executeSelectOne ? undefined : this.getWorker();
    let startupMs = 0;
    if (worker && !worker.ready) {
      await raceWithDeadline(worker.readiness, {
        timer: this.timer,
        timeoutMs: this.initTimeoutMs,
        unref: true,
        label: "Database health probe worker initialization",
        timeoutError: () => new DatabaseHealthProbeInitTimeoutError(this.initTimeoutMs),
        onTimeout: () => {
          logger.warn(
            `Database health probe worker init timed out after ${this.timer.now() - worker.startedAt}ms ` +
              `(init budget ${this.initTimeoutMs}ms)`,
          );
          this.abandonPendingWorkerRequest(
            worker,
            new DatabaseHealthProbeInitTimeoutError(this.initTimeoutMs),
          );
        },
      });
      startupMs = Math.max(0, (this.timer.monotonicNow?.() ?? this.timer.now()) - startupStartedAt);
    }

    // check() owns the single authoritative SQL timeout (#6655); the worker
    // never arms a competing deadline, and cold startup consumes none of it.
    await raceWithDeadline(
      () => this.executeSelectOne?.() ?? this.executeSelectOneInWorker(worker!),
      {
        timer: this.timer,
        timeoutMs: this.timeoutMs,
        unref: true,
        label: "Database health probe",
        timeoutError: () => new DatabaseHealthProbeTimeoutError(this.timeoutMs, "query", startupMs),
        onTimeout: () => {
          if (worker) {
            this.abandonPendingWorkerRequest(
              worker,
              new DatabaseHealthProbeTimeoutError(this.timeoutMs, "query", startupMs),
            );
          }
        },
      },
    );
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    const error = new Error("Database health probe disposed");
    worker?.rejectReady(error);
    if (this.pendingRequest) {
      const pending = this.pendingRequest;
      this.pendingRequest = null;
      pending.reject(error);
    }
    if (worker) {
      await worker.worker.terminate();
    }
  }

  /**
   * Clear any in-flight worker request and null out the worker so a fresh
   * one is created on the next check(). Used when check()'s own timeout
   * fires while a worker round-trip is still pending — the worker is
   * abandoned (terminated fire-and-forget) rather than left to eventually
   * settle a request nobody is awaiting anymore.
   */
  private abandonPendingWorkerRequest(worker: ProbeWorkerState, error: Error): void {
    if (this.worker !== worker) {
      return;
    }
    this.worker = null;
    worker.rejectReady(error);
    this.pendingRequest?.reject(error);
    this.pendingRequest = null;
    void worker.worker.terminate().catch((terminationError: unknown) => {
      // The worker is detached and all waiters rejected; termination cannot affect a later check.
      logger.debug("Abandoned database health probe worker termination failed", terminationError);
    });
  }

  private executeSelectOneInWorker(state: ProbeWorkerState): Promise<void> {
    if (this.worker !== state) {
      return Promise.reject(new Error("Database health probe worker is no longer available"));
    }
    if (this.pendingRequest) {
      return Promise.reject(new Error("Database health probe is already running"));
    }
    const requestId = ++this.workerRequestId;
    return new Promise<void>((resolve, reject) => {
      this.pendingRequest = { resolve, reject };
      state.worker.postMessage({ id: requestId });
    });
  }

  private getWorker(): ProbeWorkerState {
    if (this.worker) {
      return this.worker;
    }
    const startedAt = this.timer.now();
    const worker = this.workerFactory(SQLITE_PROBE_WORKER_SOURCE, {
      dbPath: this.getDatabasePath(),
      sqliteBusyTimeoutMs: this.sqliteBusyTimeoutMs,
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readiness = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const state: ProbeWorkerState = {
      worker,
      readiness,
      ready: false,
      startedAt,
      resolveReady,
      rejectReady,
    };
    this.worker = state;
    worker.on("message", (message: ProbeWorkerMessage) => {
      if (this.worker !== state) {
        return;
      }
      if ("type" in message) {
        if (!state.ready) {
          state.ready = true;
          state.resolveReady();
          logger.debug(
            `Database health probe worker ready after ${this.timer.now() - state.startedAt}ms`,
          );
        }
        return;
      }
      if (!this.pendingRequest || message.id !== this.workerRequestId) {
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
      this.rejectWorker(state, error);
    });
    worker.on("exit", (code) => {
      this.rejectWorker(state, new Error(`Database health probe worker exited with code ${code}`));
    });
    return state;
  }

  private rejectWorker(state: ProbeWorkerState, error: Error): void {
    if (this.worker !== state) {
      return;
    }
    this.worker = null;
    state.rejectReady(error);
    this.pendingRequest?.reject(error);
    this.pendingRequest = null;
  }
}

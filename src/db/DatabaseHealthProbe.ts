import { sql } from "kysely";
import { getDatabase, getMigrationsError } from "./database";
import { defaultTimer, type Timer } from "../utils/SystemTimer";

const DATABASE_HEALTH_PROBE_TIMEOUT_MS = 1_000;

export interface DatabaseHealthProbe {
  check(): Promise<void>;
}

interface DatabaseHealthProbeDependencies {
  timer?: Timer;
  getMigrationsError?: () => Error | null;
  executeSelectOne?: () => Promise<unknown>;
  timeoutMs?: number;
}

export class DefaultDatabaseHealthProbe implements DatabaseHealthProbe {
  private readonly timer: Timer;
  private readonly getMigrationsError: () => Error | null;
  private readonly executeSelectOne: () => Promise<unknown>;
  private readonly timeoutMs: number;

  constructor(dependencies: DatabaseHealthProbeDependencies = {}) {
    this.timer = dependencies.timer ?? defaultTimer;
    this.getMigrationsError = dependencies.getMigrationsError ?? getMigrationsError;
    this.executeSelectOne =
      dependencies.executeSelectOne ?? (() => sql<{ ok: number }>`SELECT 1 as ok`.execute(getDatabase()));
    this.timeoutMs = dependencies.timeoutMs ?? DATABASE_HEALTH_PROBE_TIMEOUT_MS;
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

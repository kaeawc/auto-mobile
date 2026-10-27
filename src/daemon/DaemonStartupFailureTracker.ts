import { FileStartupFailureStore } from "./FileStartupFailureStore";
import { logger } from "../utils/logger";

import type { DatabaseFailureKind } from "../db/databaseFailureClassification";

/**
 * Tracks recent fatal daemon-startup failures across process launches so the
 * circuit-breaker in Daemon.initializeDatabase() can converge to a stable dead
 * state (bounded backoff) instead of a hot restart loop when a permanent DB
 * failure keeps reproducing (issue #2784).
 *
 * The daemon exits on a fatal startup failure and is re-spawned externally (a
 * fresh process each time), so the failure count MUST be persisted to disk to
 * survive the restart — an in-process counter would reset to zero every launch.
 */
export interface StartupFailureTracker {
  /**
   * Record a fatal startup failure occurring at `now` and return the number of
   * failures recorded within the rolling window (including this one).
   */
  recordFailure(kind: DatabaseFailureKind, now: number): number;

  /** Clear the recorded failures after a successful startup. */
  reset(): void;
}

/**
 * Persistence backend for the failure tracker. Injected so the throttle-on-
 * persistence-failure path is testable deterministically and cross-platform,
 * rather than depending on an OS-specific unwritable path.
 */
export interface StartupFailureStore {
  /** The raw persisted contents, or null if nothing is stored yet. */
  read(): string | null;
  /** Persist the contents. MUST throw if the write does not durably succeed. */
  write(data: string): void;
  /** Best-effort removal of any persisted contents. */
  clear(): void;
}

interface StartupFailureRecord {
  at: number;
  kind: DatabaseFailureKind;
}

/** Failures older than this fall out of the rolling window. */
export const STARTUP_FAILURE_WINDOW_MS = 5 * 60 * 1000;

export class DefaultStartupFailureTracker implements StartupFailureTracker {
  private readonly store: StartupFailureStore;
  private readonly windowMs: number;

  constructor(
    store: StartupFailureStore = new FileStartupFailureStore(),
    windowMs: number = STARTUP_FAILURE_WINDOW_MS,
  ) {
    this.store = store;
    this.windowMs = windowMs;
  }

  recordFailure(kind: DatabaseFailureKind, now: number): number {
    const records = this.read().filter((record) => now - record.at <= this.windowMs);
    records.push({ at: now, kind });

    try {
      this.store.write(JSON.stringify(records));
    } catch (error) {
      // Persistence failure itself throttles: if we can't record the escalation
      // across respawns (e.g. the state dir is unwritable — the same class of
      // permanent failure that would otherwise hot-loop), report at least the
      // second tier so the permanent-failure backoff still engages instead of
      // spinning at count 1 forever.
      logger.debug(`Failed to persist startup failure tracker: ${error}`);
      return Math.max(records.length, 2);
    }

    return records.length;
  }

  reset(): void {
    this.store.clear();
  }

  private read(): StartupFailureRecord[] {
    const raw = this.store.read();
    if (raw === null) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (record): record is StartupFailureRecord =>
          typeof record?.at === "number" &&
          (record.kind === "transient" || record.kind === "permanent"),
      );
    } catch (error) {
      // A corrupt/unreadable tracker file must not itself break startup — treat
      // it as "no prior failures" so we still exit fatally but without backoff.
      logger.debug(`Failed to parse startup failure tracker contents: ${error}`);
      return [];
    }
  }
}

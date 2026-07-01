import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { getTempDir, TEMP_SUBDIRS } from "../utils/tempDir";
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

interface StartupFailureRecord {
  at: number;
  kind: DatabaseFailureKind;
}

/** Failures older than this fall out of the rolling window. */
export const STARTUP_FAILURE_WINDOW_MS = 5 * 60 * 1000;

export class DefaultStartupFailureTracker implements StartupFailureTracker {
  private readonly filePath: string;
  private readonly windowMs: number;

  constructor(filePath: string = defaultTrackerFilePath(), windowMs: number = STARTUP_FAILURE_WINDOW_MS) {
    this.filePath = filePath;
    this.windowMs = windowMs;
  }

  recordFailure(kind: DatabaseFailureKind, now: number): number {
    const records = this.read().filter(record => now - record.at < this.windowMs);
    records.push({ at: now, kind });
    const persisted = this.write(records);
    if (!persisted) {
      // Persistence failure itself throttles: if we can't record the escalation
      // across respawns (e.g. the state dir is unwritable — the same class of
      // permanent failure that would otherwise hot-loop), report at least the
      // second tier so the permanent-failure backoff still engages instead of
      // spinning at count 1 forever.
      return Math.max(records.length, 2);
    }
    return records.length;
  }

  reset(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.rmSync(this.filePath, { force: true });
      }
    } catch (error) {
      // Best-effort cleanup; a stale tracker file only delays the next backoff.
      logger.debug(`Failed to clear startup failure tracker file: ${error}`);
    }
  }

  private read(): StartupFailureRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) {
        return [];
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter(
        (record): record is StartupFailureRecord =>
          typeof record?.at === "number" && (record.kind === "transient" || record.kind === "permanent")
      );
    } catch (error) {
      // A corrupt/unreadable tracker file must not itself break startup — treat
      // it as "no prior failures" so we still exit fatally but without backoff.
      logger.debug(`Failed to read startup failure tracker file: ${error}`);
      return [];
    }
  }

  private write(records: StartupFailureRecord[]): boolean {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(records), { mode: 0o600 });
      return true;
    } catch (error) {
      logger.debug(`Failed to persist startup failure tracker file: ${error}`);
      return false;
    }
  }
}

function defaultTrackerFilePath(): string {
  // Stored under the auto-mobile data dir (AUTOMOBILE_DATA_DIR / ~/.auto-mobile),
  // NOT the DB directory: a custom, unwritable AUTOMOBILE_DB_DIR is itself a
  // permanent startup failure, and putting the breaker there would leave every
  // respawn unable to read prior records — so it could never escalate to backoff.
  return path.join(getTempDir(TEMP_SUBDIRS.STATE), "daemon-startup-failures.json");
}

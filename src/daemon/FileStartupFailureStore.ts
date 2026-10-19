import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";
import { getTempDir, TEMP_SUBDIRS } from "../utils/tempDir";
import { type StartupFailureStore } from "./DaemonStartupFailureTracker";

/** File-backed store under a directory independent of the DB directory. */
export class FileStartupFailureStore implements StartupFailureStore {
  constructor(private readonly filePath: string = defaultTrackerFilePath()) {}

  read(): string | null {
    try {
      return fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath, "utf8") : null;
    } catch (error) {
      logger.debug(`Failed to read startup failure tracker file: ${error}`);
      return null;
    }
  }

  write(data: string): void {
    // No try/catch: a failed write must propagate so recordFailure() can throttle.
    // Write to a per-process temp file then atomically rename, so a crash or a
    // racing daemon launch can never leave a torn/partial file that read() would
    // fail to parse (which would silently reset the failure count to zero and
    // defeat backoff escalation).
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${process.pid}.tmp`);
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }

  clear(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        fs.rmSync(this.filePath, { force: true });
      }
    } catch (error) {
      // Best-effort cleanup; a stale tracker file only delays the next backoff.
      logger.debug(`Failed to clear startup failure tracker file: ${error}`);
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

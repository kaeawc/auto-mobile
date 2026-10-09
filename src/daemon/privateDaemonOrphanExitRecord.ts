import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";

/**
 * What a harness private daemon leaves behind when its orphan watchdog stops it (#11074). A later
 * client that auto-starts a daemon on the same control socket without an explicit `--port` would
 * otherwise get a daemon on the default port with different settings than the one that exited;
 * the record lets the replacement bind the same port, strictly.
 */
export interface PrivateDaemonOrphanExitRecord {
  port: number;
  exitedAtMs: number;
}

export function orphanExitRecordPath(socketPath: string): string {
  return `${socketPath}.orphan-exit.json`;
}

export function writePrivateDaemonOrphanExitRecord(
  socketPath: string,
  record: PrivateDaemonOrphanExitRecord,
): void {
  try {
    writeFileSync(orphanExitRecordPath(socketPath), JSON.stringify(record));
  } catch (error) {
    // Best effort: without the record the next client simply starts with its own settings.
    logger.warn(`Failed to record private daemon orphan exit: ${errorMessage(error)}`, error);
  }
}

/** Reads and removes the record, so only the first replacement inherits the settings. */
export function consumePrivateDaemonOrphanExitRecord(
  socketPath: string,
): PrivateDaemonOrphanExitRecord | undefined {
  const path = orphanExitRecordPath(socketPath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // No record is the normal case for every start that is not a post-orphan-exit restart.
    logger.debug(`No private daemon orphan exit record at ${path}: ${errorMessage(error)}`);
    return undefined;
  }
  try {
    rmSync(path, { force: true });
  } catch (error) {
    logger.warn(`Failed to remove orphan exit record ${path}: ${errorMessage(error)}`, error);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "port" in parsed &&
      "exitedAtMs" in parsed &&
      Number.isInteger(parsed.port) &&
      typeof parsed.exitedAtMs === "number"
    ) {
      return { port: Number(parsed.port), exitedAtMs: parsed.exitedAtMs };
    }
  } catch (error) {
    logger.warn(`Ignoring malformed orphan exit record ${path}: ${errorMessage(error)}`, error);
  }
  return undefined;
}

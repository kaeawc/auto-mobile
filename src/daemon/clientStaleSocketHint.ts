import { PID_FILE_PATH } from "./wire/constants";
import { DaemonUnavailableError } from "./DaemonUnavailableError";
import { isProcessRunning, readPidFileDataSync } from "./daemonFiles";
import { logger } from "../utils/logger";

/** Options consulted only to produce the stale-socket diagnostic hint (issue #6140). */
export interface StaleSocketHintOptions {
  pidFilePath?: string;
  isProcessRunning?: (pid: number) => boolean;
}

/**
 * Adds a diagnostic hint to a failed connect's error when the PID file names a
 * PID that is confirmed dead — otherwise returns the error unchanged. NEVER
 * touches the filesystem (issue #6140): this only reads the PID file to decide
 * whether the hint applies.
 */
export function annotateStaleSocketHint(error: unknown, options: StaleSocketHintOptions): Error {
  const originalError = error instanceof Error ? error : new DaemonUnavailableError(String(error));
  const pidFilePath = options.pidFilePath ?? PID_FILE_PATH;
  const pidData = readPidFileDataSync(pidFilePath);
  if (!pidData || typeof pidData.pid !== "number") {
    return originalError;
  }
  const processRunning =
    options.isProcessRunning ??
    ((pid: number) => isProcessRunning(pid, { debugLog: logger.debug }));
  if (processRunning(pidData.pid)) {
    return originalError;
  }
  return new DaemonUnavailableError(
    `${originalError.message} — the recorded daemon PID ${pidData.pid} is not running; ` +
      "the socket may be stale and will be reclaimed automatically the next time the daemon " +
      "starts (run `--daemon restart` if this persists)",
  );
}

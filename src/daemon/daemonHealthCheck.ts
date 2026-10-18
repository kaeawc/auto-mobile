import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { SingleFlightInterval } from "../utils/SingleFlightInterval";
import type { Timer } from "../utils/SystemTimer";
import { DatabaseHealthLateness } from "./databaseHealthLateness";

export type HealthFailureKind = "http" | "socket" | "database" | "unknown";

export const HEALTH_CHECK_INTERVAL_MS = 30_000;
/** Consecutive same-kind failures tolerated before recovery is attempted. */
export const MAX_FAILED_HEALTH_CHECKS = 3;

/** The slice of daemon state a health tick reads; each member is a live getter. */
export interface DaemonHealthCheckDeps {
  timer: Timer;
  httpServer(): { listening: boolean } | null | undefined;
  socketServerListening(): boolean;
  observationStreamHealthy(): boolean;
  databaseHealthProbe(): { check(): Promise<void> };
  /** Receives the latest probe failure message, or undefined once a probe passes. */
  onDatabaseFailureChanged(message: string | undefined): void;
  recover(kind: HealthFailureKind): Promise<void>;
}

/**
 * Builds the periodic daemon health check. It runs through
 * SingleFlightInterval so a probe slower than the interval cannot overlap
 * itself; the caller owns start() and stop().
 */
export function createDaemonHealthCheck(deps: DaemonHealthCheckDeps): SingleFlightInterval {
  const lateness = new DatabaseHealthLateness(deps.timer, HEALTH_CHECK_INTERVAL_MS);
  let failedCheckCount = 0;
  let lastFailureKind: HealthFailureKind = "unknown";

  const recordFailure = (kind: HealthFailureKind): void => {
    // Recovery depends on the failure kind, so only same-kind streaks may
    // reach a kind-specific recovery action.
    if (lastFailureKind !== kind) {
      failedCheckCount = 0;
    }
    lastFailureKind = kind;
    failedCheckCount++;
  };
  const resetFailures = (): void => {
    failedCheckCount = 0;
    lastFailureKind = "unknown";
  };

  const listenersHealthy = (): boolean => {
    const httpServer = deps.httpServer();
    if (!httpServer) {
      logger.warn("Health check failed: HTTP server not initialized");
      recordFailure("http");
      return false;
    }
    if (!httpServer.listening) {
      logger.warn("Health check failed: HTTP server not listening");
      recordFailure("http");
      return false;
    }
    // Socket servers are checked before shared dependencies; clients can only
    // subscribe to advertised streams while their socket paths exist.
    if (!deps.socketServerListening()) {
      logger.warn("Health check failed: Socket server not listening");
      recordFailure("socket");
      return false;
    }
    if (!deps.observationStreamHealthy()) {
      logger.warn("Health check failed: Observation stream socket unavailable");
      recordFailure("socket");
      return false;
    }
    return true;
  };

  /** Returns false when an inconclusive timeout should end the tick without recovery. */
  const checkDatabase = async (tickGap: ReturnType<DatabaseHealthLateness["tick"]>) => {
    const timeoutIsInconclusive = lateness.beginProbe(tickGap);
    try {
      await deps.databaseHealthProbe().check();
      deps.onDatabaseFailureChanged(undefined);
      resetFailures();
      logger.debug("Health check passed");
    } catch (error) {
      if (timeoutIsInconclusive(error, failedCheckCount)) {
        return false;
      }
      deps.onDatabaseFailureChanged(errorMessage(error));
      logger.warn(`Health check failed: Database probe failed: ${error}`);
      recordFailure("database");
    }
    return true;
  };

  const tick = async (): Promise<void> => {
    const tickGap = lateness.tick();
    try {
      if (listenersHealthy() && !(await checkDatabase(tickGap))) {
        return;
      }
      if (failedCheckCount >= MAX_FAILED_HEALTH_CHECKS) {
        logger.error(`Health check failed ${failedCheckCount} times, attempting recovery...`);
        await deps.recover(lastFailureKind);
        resetFailures();
      }
    } catch (error) {
      logger.warn(`Health check error: ${error}`);
      recordFailure("unknown");
    }
  };

  return new SingleFlightInterval(deps.timer, HEALTH_CHECK_INTERVAL_MS, tick);
}

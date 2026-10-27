import { isAuxiliarySocketUnavailable } from "./auxiliarySocketAvailability";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { SingleFlightInterval } from "../utils/SingleFlightInterval";
import type { Timer } from "../utils/SystemTimer";
import { DatabaseHealthLateness } from "./databaseHealthLateness";
import { DatabaseHealthProbeTimeoutError } from "../db/DatabaseHealthProbeTimeoutError";

export type HealthFailureKind = "http" | "socket" | "database" | "unknown";

export const HEALTH_CHECK_INTERVAL_MS = 30_000;
/** Consecutive same-kind failures tolerated before recovery is attempted. */
export const MAX_FAILED_HEALTH_CHECKS = 3;
/**
 * How long a reported host I/O stall keeps excusing database probe timeouts after it was last
 * seen: the log sink abandons a stalled stream and needs a fresh write to flag the stall again,
 * so the live flag alone drops out for part of every long stall (#11990).
 */
export const HOST_IO_STALL_MEMORY_MS = 2 * HEALTH_CHECK_INTERVAL_MS;
/**
 * Consecutive probe timeouts the host I/O signal may excuse (about 5 minutes) before they count
 * as strikes again, so a stuck signal cannot hide a database that is genuinely hung.
 */
export const MAX_IO_STALL_EXCUSED_TIMEOUTS = 10;

/** The slice of daemon state a health tick reads; each member is a live getter. */
export interface DaemonHealthCheckDeps {
  timer: Timer;
  httpServer(): { listening: boolean } | null | undefined;
  socketServerListening(): boolean;
  observationStreamHealthy(): boolean;
  /** Retry only the optional stream bind; a held path must not restart healthy transports. */
  retryDegradedObservationStream(): Promise<void>;
  /** Republish discovery after a degraded stream is restored; false means publication declined. */
  onObservationStreamRestored(): Promise<boolean>;
  databaseHealthProbe(): { check(): Promise<void> };
  /** Receives the latest probe failure message, or undefined once a probe passes. */
  onDatabaseFailureChanged(message: string | undefined): void;
  recover(kind: HealthFailureKind): Promise<void>;
  /**
   * True while host disk I/O is known to be blocked (#11990). A database probe timeout then says
   * nothing about the database (a restart would reopen it on the same stalled disk), so it is not
   * counted toward recovery, up to {@link MAX_IO_STALL_EXCUSED_TIMEOUTS} in a row. Production
   * derives it from the file log sink, a proxy for the database volume that is always false for a
   * stderr sink. Defaults to never.
   */
  hostIoStalled?(): boolean;
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
  let ioExcusedTimeouts = 0;

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
    if (!deps.observationStreamHealthy() && !isAuxiliarySocketUnavailable("observation-stream")) {
      logger.warn("Health check failed: Observation stream socket unavailable");
      recordFailure("socket");
      return false;
    }
    return true;
  };

  /** A probe timeout during a host I/O stall (#11990) is inconclusive, up to a bounded streak. */
  const ioStallExcuses = (error: unknown, ioStalledAtStart: boolean): boolean => {
    if (
      !(error instanceof DatabaseHealthProbeTimeoutError) ||
      !(ioStalledAtStart || (deps.hostIoStalled?.() ?? false))
    ) {
      return false;
    }
    if (ioExcusedTimeouts >= MAX_IO_STALL_EXCUSED_TIMEOUTS) {
      if (ioExcusedTimeouts === MAX_IO_STALL_EXCUSED_TIMEOUTS) {
        ioExcusedTimeouts++;
        logger.error(
          `Host I/O stall excused ${MAX_IO_STALL_EXCUSED_TIMEOUTS} consecutive database probe ` +
            "timeouts; counting further timeouts toward recovery",
        );
      }
      return false;
    }
    ioExcusedTimeouts++;
    logger.warn(
      `Database health probe timeout inconclusive: host I/O stalled, timeout=${error.timeoutMs}ms; ` +
        `strike count stays at ${failedCheckCount}`,
    );
    return true;
  };

  /** Returns false when an inconclusive timeout should end the tick without recovery. */
  const checkDatabase = async (tickGap: ReturnType<DatabaseHealthLateness["tick"]>) => {
    const timeoutIsInconclusive = lateness.beginProbe(tickGap);
    // A stall that began before the probe can end before its timeout is judged; check both ends.
    const ioStalledAtStart = deps.hostIoStalled?.() ?? false;
    try {
      await deps.databaseHealthProbe().check();
      deps.onDatabaseFailureChanged(undefined);
      resetFailures();
      ioExcusedTimeouts = 0;
      logger.debug("Health check passed");
    } catch (error) {
      if (timeoutIsInconclusive(error, failedCheckCount)) {
        return false;
      }
      if (ioStallExcuses(error, ioStalledAtStart)) {
        return false;
      }
      deps.onDatabaseFailureChanged(errorMessage(error));
      logger.warn(`Health check failed: Database probe failed: ${error}`);
      recordFailure("database");
    }
    return true;
  };

  const republishRestoredObservation = async (): Promise<void> => {
    try {
      if (!(await deps.onObservationStreamRestored())) {
        logger.warn("Observation stream restored but daemon identity republish was declined");
      }
    } catch (error) {
      // Discovery publication is best-effort; its failure must not restart healthy transports.
      logger.warn("Observation stream restored but daemon identity republish failed", error);
    }
  };

  const retryDegradedObservation = async (): Promise<void> => {
    if (!isAuxiliarySocketUnavailable("observation-stream") || deps.observationStreamHealthy()) {
      return;
    }
    try {
      await deps.retryDegradedObservationStream();
    } catch (error) {
      // Optional stream retries must not hide DB health or disrupt healthy transports.
      logger.warn(
        `Observation stream bind retry failed; keeping daemon serving: ${errorMessage(error)}`,
        error,
      );
      return;
    }
    if (!isAuxiliarySocketUnavailable("observation-stream") && deps.observationStreamHealthy()) {
      await republishRestoredObservation();
    }
  };

  const tick = async (): Promise<void> => {
    const tickGap = lateness.tick();
    try {
      if (listenersHealthy()) {
        const databaseConclusive = await checkDatabase(tickGap);
        await retryDegradedObservation();
        if (!databaseConclusive) {
          return;
        }
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

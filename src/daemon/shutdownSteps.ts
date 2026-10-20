import { logger } from "../utils/logger";
import {
  DAEMON_HANDOFF_INTERRUPTED_MESSAGE,
  DaemonHandoffInterruptionError,
} from "./daemonHandoffInterruption";
import { awaitInFlightMigrations, getDbWriteBarrier } from "../db";
import { executionTracker } from "./executionTracker";

/** Cancels in-flight provisionDevice calls with the handoff reason and waits for them to persist. */
export async function interruptProvisioningForShutdown(drainTimeoutMs: number): Promise<void> {
  const reason = new DaemonHandoffInterruptionError(DAEMON_HANDOFF_INTERRUPTED_MESSAGE);
  const cancelled = await executionTracker.cancelToolExecutions("provisionDevice", reason);
  if (cancelled === 0) {
    return;
  }
  const drained = await executionTracker.waitForToolExecutionsToEnd(
    "provisionDevice",
    drainTimeoutMs,
  );
  if (!drained) {
    logger.warn(
      `Timed out after ${drainTimeoutMs}ms persisting ${cancelled} interrupted provisionDevice operation(s) before daemon shutdown`,
    );
  }
}

export async function drainShutdownDatabaseWrites(timeoutMs: number): Promise<void> {
  // Quiesce in-flight best-effort DB writes (fire-and-forget telemetry ingest,
  // background retention cleanup) BEFORE closing the connection, so a query
  // queued in Kysely's ConnectionMutex can't strand shutdown on an unsettled
  // promise (issue #2792). Bounded: a wedged write cannot itself hang shutdown.
  const drained = await getDbWriteBarrier().drain(timeoutMs);
  if (!drained) {
    logger.warn(
      `Timed out after ${timeoutMs}ms draining in-flight DB writes; closing database anyway`,
    );
  }
}

export async function settleShutdownMigrations(timeoutMs: number): Promise<void> {
  // If a SIGTERM arrived mid cold-start migration, the detached migration
  // connection is still open and writing on its own connection (its writes are
  // NOT tracked by the write barrier drained above). Let it settle before
  // closeDatabase() destroys the app connection, so their WAL writes/checkpoint
  // can't contend and stall shutdown on busy_timeout (Windows; issue #3044).
  // Bounded so a wedged migration cannot itself hang shutdown.
  const migrationsSettled = await awaitInFlightMigrations(timeoutMs);
  if (!migrationsSettled) {
    logger.warn(
      `Timed out after ${timeoutMs}ms awaiting in-flight startup migration; closing database anyway`,
    );
  }
}

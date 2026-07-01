import { logger } from "../utils/logger";
import { toActionableError } from "../models/ActionableError";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { exponentialBackoff } from "../utils/Backoff";
import { describeUnknownError } from "../utils/describeUnknownError";
import { classifyDatabaseFailure } from "../db/databaseFailureClassification";
import { DatabaseInitializer, DefaultDatabaseInitializer } from "../db/DatabaseInitializer";
import {
  StartupFailureTracker,
  DefaultStartupFailureTracker,
} from "./DaemonStartupFailureTracker";

/**
 * Convert a fatal database startup/bring-up failure into a rethrown
 * `ActionableError`, applying the crash-loop circuit breaker (issue #2784).
 *
 * Startup DB failure is fatal so the process exits for a clean restart. To keep
 * a *permanent* failure (corrupt DB, deterministic migration throw) from
 * hot-looping the process manager, repeated permanent failures are throttled
 * with an increasing exponential backoff before the fatal rethrow, converging to
 * a stable low-frequency dead state. Transient failures (locked file, temporary
 * disk-full) exit fast so the next launch can retry immediately.
 */
export async function handleFatalDatabaseStartupFailure(
  error: unknown,
  tracker: StartupFailureTracker,
  timer: Timer = defaultTimer
): Promise<never> {
  const kind = classifyDatabaseFailure(error);
  const recentFailures = tracker.recordFailure(kind, timer.now());
  logger.error(
    `Fatal: database initialization failed (${kind}; ${recentFailures} recent failure(s)); ` +
      `daemon cannot serve queries and will exit for a clean restart: ${describeUnknownError(error)}`
  );

  if (kind === "permanent" && recentFailures > 1) {
    const backoffMs = exponentialBackoff({
      initialDelayMs: 1000,
      multiplier: 2,
      maxDelayMs: 60_000,
    }).delayForAttempt(recentFailures - 1);
    logger.error(
      `Database initialization has failed ${recentFailures} times; backing off ${backoffMs}ms before exit to avoid a restart hot-loop.`
    );
    await timer.sleep(backoffMs);
  }

  throw toActionableError(error, "Database initialization failed at daemon startup");
}

/**
 * Pre-flight the database under the startup circuit breaker BEFORE any DB-backed
 * service touches it.
 *
 * In `--daemon-mode` the first DB touch is `FeatureFlagService.initialize()` in
 * `main()`, which runs before `Daemon.start()`. Without this guard a permanent
 * DB failure surfaces there and exits via `main().catch` before the daemon's
 * own fatal handler can record the failure or back off — re-spawning in a tight
 * loop. Running the guard first funnels that early failure through the same
 * classify/record/backoff/rethrow path.
 *
 * On success the failure tracker is reset (a healthy DB start clears the breaker).
 */
export async function guardDatabaseStartup(
  initializer: DatabaseInitializer = new DefaultDatabaseInitializer(),
  tracker: StartupFailureTracker = new DefaultStartupFailureTracker(),
  timer: Timer = defaultTimer
): Promise<void> {
  try {
    await initializer.initialize();
    tracker.reset();
  } catch (error) {
    await handleFatalDatabaseStartupFailure(error, tracker, timer);
  }
}

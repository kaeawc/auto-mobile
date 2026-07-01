import { logger } from "../utils/logger";
import { toActionableError } from "../models/ActionableError";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { exponentialBackoff } from "../utils/Backoff";
import { describeUnknownError } from "../utils/describeUnknownError";
import { classifyDatabaseFailure } from "../db/databaseFailureClassification";
import { DAEMON_STARTUP_TIMEOUT_MS } from "./constants";
import {
  StartupFailureTracker,
  DefaultStartupFailureTracker,
} from "./DaemonStartupFailureTracker";

/**
 * Cap the backoff strictly below the manager's startup timeout. The daemon
 * sleeps here *before* `process.exit(1)`, but `DaemonManager.waitForDaemonStartup()`
 * reports failure after `DAEMON_STARTUP_TIMEOUT_MS` and the next spawn SIGTERMs
 * any live `--daemon-mode` process — so a sleep >= that timeout would be
 * truncated (the sleeper is killed) and never actually throttle. Staying under
 * it (with headroom for the exit to be observed) lets the backoff complete, so
 * the effective respawn cadence really does converge to this bound. Floored at
 * 1s so an aggressively-low override can't disable throttling entirely.
 */
export const MAX_STARTUP_BACKOFF_MS = Math.max(1000, DAEMON_STARTUP_TIMEOUT_MS - 2000);

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
      maxDelayMs: MAX_STARTUP_BACKOFF_MS,
    }).delayForAttempt(recentFailures - 1);
    logger.error(
      `Database initialization has failed ${recentFailures} times; backing off ${backoffMs}ms before exit to avoid a restart hot-loop.`
    );
    await timer.sleep(backoffMs);
  }

  throw toActionableError(error, "Database initialization failed at daemon startup");
}

/**
 * Run early `--daemon-mode` database startup `work` under the circuit breaker,
 * BEFORE `Daemon.start()`.
 *
 * The first DB touches in `main()` — migrations and `FeatureFlagService`'s
 * `ensureFlags`/`listFlags` queries — run before `Daemon.start()`. Without this
 * guard a permanent DB failure there (failed migration, or a migrated-but-
 * missing/malformed `feature_flags` table) surfaces via `main().catch` and exits
 * before the daemon's own fatal handler can record it or back off — re-spawning
 * in a tight loop. Wrapping ALL of that DB `work` here funnels every early
 * failure through the same classify/record/backoff/rethrow path.
 *
 * Does NOT reset the tracker on success: reset must happen only after the ENTIRE
 * daemon startup DB path (including `Daemon.initializeDatabase()`'s cleanup
 * queries) succeeds, otherwise a later permanent failure recorded by the daemon
 * would be erased by the next launch's preflight success and never escalate.
 */
export async function guardDatabaseStartup(
  work: () => Promise<void>,
  tracker: StartupFailureTracker = new DefaultStartupFailureTracker(),
  timer: Timer = defaultTimer
): Promise<void> {
  try {
    await work();
  } catch (error) {
    await handleFatalDatabaseStartupFailure(error, tracker, timer);
  }
}

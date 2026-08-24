import { errorMessage } from "./describeUnknownError";
import { defaultTimer, type Timer } from "./SystemTimer";
import { logger, type Logger } from "./logger";

export const STARTUP_MAINTENANCE_SLOW_WARNING_MS = 5_000;

export interface StartupMaintenanceDependencies {
  readonly platform: NodeJS.Platform;
  readonly startAndroidSweep: () => Promise<void>;
  readonly startIosReap: () => Promise<void>;
  readonly timer?: Timer;
  readonly logger?: Logger;
}

/**
 * Starts cleanup leaked by previous daemon processes without delaying JSON-RPC
 * readiness. The work remains best-effort after the caller's bounded window.
 */
export function startStartupMaintenance(dependencies: StartupMaintenanceDependencies): void {
  const timer = dependencies.timer ?? defaultTimer;
  const log = dependencies.logger ?? logger;

  startBackgroundCleanup(
    "Android CtrlProxy prefetch cleanup",
    dependencies.startAndroidSweep,
    timer,
    log,
  );
  if (dependencies.platform === "darwin") {
    startBackgroundCleanup("iOS CtrlProxy runner cleanup", dependencies.startIosReap, timer, log);
  }
}

function startBackgroundCleanup(
  label: string,
  cleanup: () => Promise<void>,
  timer: Timer,
  log: Logger,
): void {
  let work: Promise<void>;
  try {
    work = cleanup();
  } catch (error) {
    log.warn(`[STARTUP_MAINTENANCE] ${label} failed: ${formatError(error)}`);
    return;
  }

  const timeout = timer.setTimeout(() => {
    log.warn(
      `[STARTUP_MAINTENANCE] ${label} exceeded ${STARTUP_MAINTENANCE_SLOW_WARNING_MS}ms; continuing startup`,
    );
  }, STARTUP_MAINTENANCE_SLOW_WARNING_MS);
  (timeout as { unref?: () => void }).unref?.();

  void work
    .catch((error) => {
      log.warn(`[STARTUP_MAINTENANCE] ${label} failed: ${formatError(error)}`);
    })
    .finally(() => {
      timer.clearTimeout(timeout);
    });
}

function formatError(error: unknown): string {
  return errorMessage(error);
}

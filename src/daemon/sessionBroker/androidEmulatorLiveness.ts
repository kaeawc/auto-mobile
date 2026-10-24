import { ActionableError } from "../../models/ActionableError";
import { exponentialBackoff } from "../../utils/Backoff";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import type { Timer } from "../../utils/SystemTimer";
import type { EmulatorProcessStopper } from "../../utils/android-cmdline-tools/EmulatorProcessStop";

/** Two consecutive reads that miss the owned process, so one torn process-table read cannot abort a reset. */
export const EMULATOR_DEATH_CONFIRMATIONS = 2;
const livenessBackoff = exponentialBackoff({
  initialDelayMs: 500,
  multiplier: 2,
  maxDelayMs: 2000,
});

interface EmulatorLivenessTarget {
  serial: string;
  avdName: string;
}

interface EmulatorDeathWatchOptions {
  stopper: Pick<EmulatorProcessStopper, "identify">;
  timer: Pick<Timer, "now" | "sleep" | "setTimeout" | "clearTimeout">;
  signal: AbortSignal;
  deadlineMs: number;
  /** Ownership fence; a lost lease fails the watch just as a dead process does. */
  assertOwned(): Promise<void>;
}

/**
 * Settles only by rejecting: when the owned emulator process is proven gone for
 * {@link EMULATOR_DEATH_CONFIRMATIONS} consecutive reads, when ownership is lost, or when
 * the signal aborts. An unreadable or ambiguous process table proves nothing and keeps
 * watching, so the surrounding budget stays the backstop.
 */
export async function watchEmulatorProcessDeath(
  target: EmulatorLivenessTarget,
  options: EmulatorDeathWatchOptions,
): Promise<never> {
  const { stopper, timer, signal, deadlineMs, assertOwned } = options;
  let misses = 0;
  for (let attempt = 1; ; attempt++) {
    await raceWithDeadline(timer.sleep(livenessBackoff.delayForAttempt(attempt)), {
      timer,
      signal,
      label: "Android emulator liveness watch",
    });
    await assertOwned();
    try {
      const identity = await stopper.identify(target, { signal, deadlineMs });
      misses = identity.kind === "absent" || identity.kind === "mismatch" ? misses + 1 : 0;
    } catch (error) {
      signal.throwIfAborted();
      // A failed process-table read never proves death; keep watching until the budget ends.
      logger.debug(`Android emulator liveness probe failed: ${errorMessage(error)}`);
      misses = 0;
    }
    if (misses >= EMULATOR_DEATH_CONFIRMATIONS) {
      throw new ActionableError(
        `Android emulator process for ${target.serial} (${target.avdName}) exited during snapshot restore`,
      );
    }
  }
}

import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";

export const COLD_BOOT_SETTLEMENT_GRACE_MS = 1_000;

type TerminationTimer = Pick<Timer, "setTimeout" | "clearTimeout">;

export interface ColdBootTermination {
  /** Resolves when the process emits `exit`; already resolved for a settled or non-observable handle. */
  exited: Promise<void>;
  /** True once the process is confirmed gone; false when it survived SIGTERM and SIGKILL. */
  confirmed: Promise<boolean>;
}

/**
 * Terminates an emulator process this request started and waits for it to be
 * confirmed gone: SIGTERM, one bounded wait on the injected timer, SIGKILL, one
 * more bounded wait. `kill()` only requests signal delivery, so the emulator is
 * still holding its AVD lock files until it emits `exit`; callers must not
 * release the AVD's lifecycle lease before `confirmed` resolves true.
 *
 * The first signal is sent synchronously, before this returns.
 */
export function terminateColdBootProcess(
  processHandle: ChildProcess,
  label: string,
  timer: TerminationTimer,
): ColdBootTermination {
  const alreadySettled =
    typeof processHandle.once !== "function" ||
    processHandle.exitCode !== null ||
    processHandle.signalCode !== null;
  const exited = alreadySettled
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        processHandle.once("exit", () => resolve());
      });
  try {
    processHandle.kill();
  } catch (error) {
    logger.warn(`[ColdBoot] Failed to cancel cold boot ${label}: ${errorMessage(error)}`, error);
  }
  return {
    exited,
    confirmed: alreadySettled
      ? Promise.resolve(true)
      : awaitColdBootSettlement(exited, processHandle, label, timer),
  };
}

/**
 * An emulator that ignores SIGTERM never emits `exit`, so an unbounded wait on
 * its settlement strands every resource whose release is deferred onto it (the
 * lifecycle lease above all). Bound the wait with the injected timer and
 * escalate to SIGKILL. Resolves true when the process exited, false when it is
 * still running one grace after SIGKILL.
 */
async function awaitColdBootSettlement(
  processSettlement: Promise<void>,
  processHandle: ChildProcess,
  label: string,
  timer: TerminationTimer,
): Promise<boolean> {
  if (await raceColdBootExit(processSettlement, timer)) {
    return true;
  }
  logger.warn(
    `[ColdBoot] Cold boot ${label} did not exit within ` +
      `${COLD_BOOT_SETTLEMENT_GRACE_MS}ms; escalating to SIGKILL`,
  );
  try {
    processHandle.kill("SIGKILL");
  } catch (error) {
    // Best effort: the child may have died between the race and here, and the
    // caller must not stay blocked on the escalation either.
    logger.debug(`[ColdBoot] SIGKILL for cold boot ${label} failed: ${errorMessage(error)}`);
  }
  // Resolving here would hand the stable key to the next request mid-shutdown,
  // so wait for the real exit, bounded by one more grace.
  const confirmed = await raceColdBootExit(processSettlement, timer);
  if (!confirmed) {
    logger.warn(
      `[ColdBoot] Cold boot ${label} did not exit within ` +
        `${COLD_BOOT_SETTLEMENT_GRACE_MS}ms of SIGKILL`,
    );
  }
  return confirmed;
}

/**
 * Waits for `settlement`, bounded by one `COLD_BOOT_SETTLEMENT_GRACE_MS` grace
 * on the injected timer. Resolves true when the process settled first, false
 * when the grace expired.
 */
async function raceColdBootExit(
  settlement: Promise<void>,
  timer: TerminationTimer,
): Promise<boolean> {
  const deadline = new Error("Cold boot exit wait timed out");
  try {
    return await raceWithDeadline(
      settlement.then(() => true),
      {
        timer,
        timeoutMs: COLD_BOOT_SETTLEMENT_GRACE_MS,
        label: "Cold boot exit",
        timeoutError: () => deadline,
      },
    );
  } catch (error) {
    if (error === deadline) {
      return false;
    }
    throw error;
  }
}

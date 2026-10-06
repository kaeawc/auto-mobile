import type { HostChildProcess as ChildProcess } from "../utils/HostCommandExecutor";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import { isProcessRunning } from "../utils/processLiveness";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import type { Timer } from "../utils/SystemTimer";

export const COLD_BOOT_SETTLEMENT_GRACE_MS = 1_000;
/** Cadence of the liveness re-check on an emulator that survived SIGTERM and SIGKILL (#9920). */
export const SURVIVING_PROCESS_RECHECK_INTERVAL_MS = 5_000;

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

function unrefTimer(handle: NodeJS.Timeout): void {
  if (typeof handle === "object" && handle !== null && typeof handle.unref === "function") {
    handle.unref();
  }
}

/**
 * Resolves once a process that survived SIGTERM and SIGKILL is gone: either its
 * `exit` event fires, or a periodic liveness probe by pid finds it absent (an
 * unkillable process, or one whose exit event was missed, would otherwise keep
 * the AVD's lifecycle lease forever, #9920). The re-check timer is unref'd and
 * cleared as soon as the watch settles, so it can never hold the daemon open.
 * Without a pid only the `exit` event can settle the watch.
 */
export function watchSurvivingProcess(
  processHandle: Pick<ChildProcess, "pid">,
  exited: Promise<void>,
  label: string,
  timer: TerminationTimer,
  isRunning: (pid: number) => boolean = isProcessRunning,
): Promise<void> {
  const pid = processHandle.pid;
  return new Promise<void>((resolve) => {
    let pending: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = () => {
      settled = true;
      if (pending !== undefined) {
        timer.clearTimeout(pending);
        pending = undefined;
      }
      resolve();
    };
    void exited.then(finish, finish);
    if (pid === undefined) {
      return;
    }
    const recheck = () => {
      pending = undefined;
      if (settled) {
        return;
      }
      if (!isRunning(pid)) {
        logger.warn(`[ColdBoot] Cold boot ${label} process ${pid} is gone; releasing its AVD`);
        finish();
        return;
      }
      pending = timer.setTimeout(recheck, SURVIVING_PROCESS_RECHECK_INTERVAL_MS);
      unrefTimer(pending);
    };
    pending = timer.setTimeout(recheck, SURVIVING_PROCESS_RECHECK_INTERVAL_MS);
    unrefTimer(pending);
  });
}

/**
 * Outcome of terminating an emulator this boot started. `survived` carries a
 * `gone` promise that settles once the process is finally absent; the AVD's
 * lifecycle lease must be held until then. `unobservable` means the exit could
 * not even be observed, so nothing can be held on.
 */
export type OwnedTermination =
  | { state: "confirmed" }
  | { state: "survived"; gone: Promise<void> }
  | { state: "unobservable" };

export interface OwnedEmulatorTerminationOptions {
  /** Marks the AVD's lease as held by a process that survived both signals. */
  markHeldByUnkillableProcess?: (pid: number | undefined) => void;
  isProcessRunning?: (pid: number) => boolean;
}

/**
 * Terminates an emulator this request started (never an adopted one) with the
 * SIGTERM -> bounded wait -> SIGKILL escalation. A survivor is marked on the
 * lease and watched until its pid is gone; its owner must keep the AVD's
 * lifecycle lease held until `gone` settles (#9901), which the watch's liveness
 * re-check bounds (#9920). Shared by every owner of a started emulator handle:
 * the boot service's owned boot and a cancelled launch alike (#10075).
 */
export async function terminateOwnedEmulatorProcess(
  handle: ChildProcess,
  label: string,
  timer: TerminationTimer,
  options: OwnedEmulatorTerminationOptions = {},
): Promise<OwnedTermination> {
  const { exited, confirmed } = terminateColdBootProcess(handle, label, timer);
  try {
    if (await confirmed) {
      return { state: "confirmed" };
    }
  } catch (error) {
    // The exit could not even be observed, so nothing can be held on: the lease is
    // released at once and the owner's own failure stays the one surfaced.
    logger.warn(
      `[startDevice] Could not observe exit of emulator process ${handle.pid ?? "unknown"}: ${errorMessage(error)}`,
      error,
    );
    return { state: "unobservable" };
  }
  logger.warn(
    `[startDevice] Emulator process ${handle.pid ?? "unknown"} for ${label} survived ` +
      "SIGTERM and SIGKILL; holding the AVD lifecycle lease until it is gone",
  );
  const gone = watchSurvivingProcess(handle, exited, label, timer, options.isProcessRunning);
  options.markHeldByUnkillableProcess?.(handle.pid);
  return { state: "survived", gone };
}

/** What the request saw of a termination: `pending` when it stopped waiting for it. */
export type OwnedTerminationWait = OwnedTermination["state"] | "pending";

interface TerminationRequestBounds {
  timer: Pick<Timer, "now" | "setTimeout" | "clearTimeout">;
  deadlineMs: number;
  signal?: AbortSignal;
}

/**
 * Waits for `termination`, but never past the caller's abort or deadline: a
 * cancelled or expired request must not be held up to 2 s for cleanup the
 * daemon can finish in the background (#9920). Resolves `pending` when the
 * request ended first; the termination keeps running and its owner must keep
 * the lease held for it.
 */
export async function awaitTerminationWithinRequest(
  termination: Promise<OwnedTermination>,
  request: TerminationRequestBounds,
): Promise<OwnedTerminationWait> {
  const remainingMs = request.deadlineMs - request.timer.now();
  if (request.signal?.aborted || remainingMs <= 0) {
    return "pending";
  }
  const requestEnded = new Error("Request ended before the emulator termination settled");
  try {
    const outcome = await raceWithDeadline(termination, {
      timer: request.timer,
      timeoutMs: remainingMs,
      signal: request.signal,
      label: "Cold boot termination",
      timeoutError: () => requestEnded,
    });
    return outcome.state;
  } catch (error) {
    if (error === requestEnded || request.signal?.aborted) {
      return "pending";
    }
    throw error;
  }
}

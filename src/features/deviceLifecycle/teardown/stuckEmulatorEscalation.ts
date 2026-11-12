import type { BootedDevice } from "../../../models";
import type { BackoffPolicy } from "../../../utils/Backoff";
import {
  EMULATOR_KILL_WAIT_MS,
  EMULATOR_STOP_RESULT_MARGIN_MS,
  EMULATOR_TERM_GRACE_MS,
  type EmulatorProcessStopOutcome,
  type EmulatorProcessStopper,
} from "../../../utils/android-cmdline-tools/EmulatorProcessStop";
import { EmulatorStopDispatchedError } from "../../../utils/android-cmdline-tools/EmulatorStopDispatchedError";
import { emulatorProcessEscapeHint } from "../../../utils/android-cmdline-tools/EmulatorStillRunningError";
import { DeviceShutdownTimeoutError } from "../../../models/DeviceShutdownTimeoutError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { shutdownTimeoutError } from "../core/deadlines";
import {
  DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
  getShutdownDiscovery,
  judgeShutdownDiscovery,
  SHUTDOWN_DISCOVERY_INCOMPLETE_DETAIL,
  type ShutdownDiscoveryContext,
  waitForDeviceShutdown,
} from "./shutdownDiscovery";
import { isShutdownTimeoutError } from "./shutdownPreparation";

/**
 * Soft emulator-console kills (the caller's first one included) before the daemon stops trying the
 * console and signals the emulator process it owns (#14018).
 */
export const STUCK_EMULATOR_MAX_SOFT_ATTEMPTS = 3;

/** Time left for a stopper's SIGTERM grace, SIGKILL wait, result margin and a final discovery. */
const FINAL_VERIFICATION_MS = 2_000;
export const STUCK_EMULATOR_ESCALATION_RESERVE_MS =
  EMULATOR_TERM_GRACE_MS +
  EMULATOR_KILL_WAIT_MS +
  EMULATOR_STOP_RESULT_MARGIN_MS +
  FINAL_VERIFICATION_MS;

/** Wire `code` of {@link EmulatorTeardownEscalationError}; the session broker keys quarantine on it. */
export const EMULATOR_TEARDOWN_FAILED_CODE = "emulator_teardown_failed";

export type EmulatorTeardownFailureReason =
  | "still-running"
  | "still-listed"
  | "identity-mismatch"
  | "unidentified"
  | "no-identity";

/**
 * The emulator could not be stopped by the soft-kill budget or by the process-level escalation.
 * A stop was dispatched, so a late exit must remain intentional
 * ({@link EmulatorStopDispatchedError}); the failure is terminal, not a retry of the same soft kill.
 */
export class EmulatorTeardownEscalationError extends EmulatorStopDispatchedError {
  readonly code = EMULATOR_TEARDOWN_FAILED_CODE;
  readonly retryable = false;

  readonly softAttempts: number;
  readonly pid?: number;

  constructor(
    message: string,
    readonly reason: EmulatorTeardownFailureReason,
    readonly serial: string,
    { softAttempts, pid }: { softAttempts: number; pid?: number },
  ) {
    super(message);
    this.softAttempts = softAttempts;
    this.pid = pid;
  }
}

export interface StuckEmulatorEscalationInput {
  context: ShutdownDiscoveryContext;
  skipAndroidNameEnrichment: boolean;
  stopper: EmulatorProcessStopper;
  /** The AVD the pooled/target identity expects; the stopper only signals a matching process. */
  avdName: string | undefined;
  /** Delay between soft re-sends; attempt 1 is the wait after the caller's own first kill. */
  backoff: BackoffPolicy;
  /** Send the soft console kill again; failures are tolerated and the poll decides. */
  redispatchSoftKill: (options: { timeoutMs: number }) => Promise<unknown>;
}

/**
 * Wait for an emulator to leave discovery after a soft `emu kill`, re-sending the soft kill a
 * bounded number of times, then SIGTERM/SIGKILL the emulator process the process table ties to
 * this serial and AVD (by pid, never by name), and verify the serial left discovery.
 */
export async function waitForEmulatorShutdownWithEscalation(
  input: StuckEmulatorEscalationInput,
): Promise<BootedDevice | undefined> {
  const { context, skipAndroidNameEnrichment, backoff } = input;
  const { timer, deadlineMs } = context;
  const startedAt = timer.now();
  const reserveMs = Math.min(
    STUCK_EMULATOR_ESCALATION_RESERVE_MS,
    Math.floor(((deadlineMs - startedAt) * 2) / 3),
  );
  const softDeadlineMs = deadlineMs - reserveMs;
  const attemptWindowMs = Math.max(
    DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
    Math.floor((softDeadlineMs - startedAt) / STUCK_EMULATOR_MAX_SOFT_ATTEMPTS),
  );

  let softAttempts = 1;
  let lastDetail: string | undefined;
  for (;;) {
    try {
      return await waitForDeviceShutdown(
        waitContext(
          context,
          startedAt,
          Math.max(timer.now() + 1, Math.min(softDeadlineMs, timer.now() + attemptWindowMs)),
        ),
        skipAndroidNameEnrichment,
      );
    } catch (error) {
      if (!isShutdownTimeoutError(error) || context.requestAbortSignal?.aborted) {
        throw error;
      }
      // A soft window running out is the expected stuck state; the loop re-kills or escalates.
      logger.debug(`[DeviceTools] Soft window ${softAttempts} ended: ${errorMessage(error)}`);
      lastDetail = error instanceof DeviceShutdownTimeoutError ? error.detail : undefined;
    }
    if (softAttempts >= STUCK_EMULATOR_MAX_SOFT_ATTEMPTS || timer.now() >= softDeadlineMs) {
      break;
    }
    await timer.sleep(
      Math.max(0, Math.min(backoff.delayForAttempt(softAttempts), softDeadlineMs - timer.now())),
    );
    softAttempts++;
    await redispatch(input, softDeadlineMs);
  }
  return await escalateToProcessStop(input, softAttempts, { startedAt, lastDetail });
}

/**
 * A disappearance wait ending at `deadlineMs`. Its timeout message quotes the time actually
 * spent waiting since the escalation began, not the caller's whole shutdown budget: a soft
 * window or final check that gives up after 10 s must not claim 30000ms elapsed (#17957).
 */
function waitContext(
  context: ShutdownDiscoveryContext,
  startedAt: number,
  deadlineMs: number,
): ShutdownDiscoveryContext {
  return { ...context, deadlineMs, timeoutMs: Math.max(0, deadlineMs - startedAt) };
}

async function redispatch(input: StuckEmulatorEscalationInput, softDeadlineMs: number) {
  const { context } = input;
  try {
    await input.redispatchSoftKill({
      timeoutMs: Math.max(1, softDeadlineMs - context.timer.now()),
    });
  } catch (error) {
    context.requestAbortSignal?.throwIfAborted();
    // The next poll is the authority on whether the emulator left; a refused or timed-out
    // console kill is the stuck state this budget exists to bound, not a reason to stop early.
    logger.warn(
      `[DeviceTools] Soft re-kill of ${context.device.deviceId} failed: ${errorMessage(error)}`,
      error,
    );
  }
}

async function escalateToProcessStop(
  input: StuckEmulatorEscalationInput,
  softAttempts: number,
  { startedAt, lastDetail }: { startedAt: number; lastDetail: string | undefined },
): Promise<BootedDevice | undefined> {
  const { context, stopper, avdName } = input;
  const serial = context.device.deviceId;
  if (!avdName) {
    throw new EmulatorTeardownEscalationError(
      `Emulator '${serial}' did not stop after ${consoleKills(softAttempts)} and no AVD name is ` +
        `known to verify its process before signalling it. ${emulatorProcessEscapeHint(serial)}`,
      "no-identity",
      serial,
      { softAttempts },
    );
  }
  logger.warn(
    `[DeviceTools] Emulator ${serial} ignored ${consoleKills(softAttempts)}; stopping its process`,
  );
  context.requestAbortSignal?.throwIfAborted();
  const outcome = await stopper.stop(
    { serial, avdName },
    { deadlineMs: context.deadlineMs, signal: context.requestAbortSignal },
  );
  if (outcome.kind === "stopped") {
    return await verifyGoneAfterStop(input, softAttempts, outcome.pid, startedAt);
  }
  if (isProcessGone(outcome)) {
    // No emulator process remains to signal, yet the last poll still listed the serial: the
    // emulator exited (a soft kill or a re-kill's own stop took effect) and adb has not dropped
    // the serial yet. Keep confirming for the rest of the budget the escalation reserved rather
    // than reporting the stale soft-window timeout while the device is going away (#17957). A
    // serial that never leaves stays the plain retryable shutdown timeout, not a failed stop.
    // Nothing was signalled here, so unlike a stop's verification it gets no polling past the
    // caller's deadline. With none left, one bounded discovery still runs: the stopper's own
    // process-table read can spend the rest of the budget, and the serial may already be gone.
    if (context.timer.now() >= context.deadlineMs) {
      return await finalPollAfterDeadline(input, startedAt, lastDetail);
    }
    return await waitForDeviceShutdown(
      waitContext(context, startedAt, context.deadlineMs),
      input.skipAndroidNameEnrichment,
    );
  }
  throw failureForOutcome(outcome, serial, avdName, softAttempts);
}

/**
 * One discovery, bounded by {@link FINAL_VERIFICATION_MS}, for an exited emulator whose budget ran
 * out before adb was re-checked. A serial still listed is the plain retryable shutdown timeout,
 * quoting the whole escalation's wait rather than the last soft window's (#17957).
 */
async function finalPollAfterDeadline(
  input: StuckEmulatorEscalationInput,
  startedAt: number,
  lastDetail: string | undefined,
): Promise<BootedDevice | undefined> {
  const { context } = input;
  const { timer, device } = context;
  if (lastDetail === SHUTDOWN_DISCOVERY_INCOMPLETE_DETAIL) {
    // Discovery itself was wedged, so one more read could not confirm anything within the bound.
    throw shutdownTimeoutError(device, lastDetail, Math.max(0, timer.now() - startedAt));
  }
  const pollContext = waitContext(context, startedAt, timer.now() + FINAL_VERIFICATION_MS);
  const discovery = await getShutdownDiscovery(pollContext, input.skipAndroidNameEnrichment);
  const judgement = await judgeShutdownDiscovery(pollContext, discovery);
  if (judgement.settled) {
    return judgement.replacement;
  }
  throw shutdownTimeoutError(device, judgement.detail, Math.max(0, timer.now() - startedAt));
}

function consoleKills(count: number): string {
  return `${count} console kill${count === 1 ? "" : "s"}`;
}

function isProcessGone(outcome: EmulatorProcessStopOutcome): boolean {
  return outcome.kind === "unidentified" && outcome.identity.kind === "absent";
}

async function verifyGoneAfterStop(
  input: StuckEmulatorEscalationInput,
  softAttempts: number,
  pid: number | undefined,
  startedAt: number,
): Promise<BootedDevice | undefined> {
  const { context } = input;
  try {
    return await waitForDeviceShutdown(
      waitContext(
        context,
        startedAt,
        Math.max(context.deadlineMs, context.timer.now() + FINAL_VERIFICATION_MS),
      ),
      input.skipAndroidNameEnrichment,
    );
  } catch (error) {
    if (!isShutdownTimeoutError(error) || context.requestAbortSignal?.aborted) {
      throw error;
    }
    const serial = context.device.deviceId;
    throw new EmulatorTeardownEscalationError(
      `Emulator '${serial}'${pid === undefined ? "" : ` (pid ${pid})`} was signalled after ` +
        `${consoleKills(softAttempts)} but is still reported as booted. ` +
        emulatorProcessEscapeHint(serial),
      "still-listed",
      serial,
      { softAttempts, pid },
    );
  }
}

function failureForOutcome(
  outcome: Exclude<EmulatorProcessStopOutcome, { kind: "stopped" }>,
  serial: string,
  avdName: string,
  softAttempts: number,
): EmulatorTeardownEscalationError {
  switch (outcome.kind) {
    case "still-running":
      return new EmulatorTeardownEscalationError(
        `Emulator '${serial}' (AVD '${avdName}') is still running with pid ${outcome.pid} after ` +
          `${consoleKills(softAttempts)} and a process-level stop` +
          `${outcome.signalled ? "" : " (no signal could be delivered)"}. ` +
          emulatorProcessEscapeHint(serial, [{ pid: outcome.pid, command: outcome.command }]),
        "still-running",
        serial,
        { softAttempts, pid: outcome.pid },
      );
    case "identity-mismatch":
      return new EmulatorTeardownEscalationError(
        `Emulator '${serial}' now runs AVD '${outcome.runningAvdName}', not '${avdName}'; ` +
          "refusing to signal its replacement after the console kills failed.",
        "identity-mismatch",
        serial,
        { softAttempts, pid: outcome.pid },
      );
    case "unidentified": {
      const candidates = outcome.identity.kind === "ambiguous" ? outcome.identity.candidates : [];
      return new EmulatorTeardownEscalationError(
        `Emulator '${serial}' did not stop after ${consoleKills(softAttempts)} and its process ` +
          `could not be uniquely identified (${outcome.identity.kind}). ` +
          emulatorProcessEscapeHint(
            serial,
            candidates,
            outcome.identity.kind === "unreadable" ? "unreadable" : undefined,
          ),
        "unidentified",
        serial,
        { softAttempts },
      );
    }
  }
}

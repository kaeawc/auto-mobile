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
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import {
  DEVICE_SHUTDOWN_POLL_INTERVAL_MS,
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
  readonly code = "emulator_teardown_failed";
  readonly retryable = false;

  constructor(
    message: string,
    readonly reason: EmulatorTeardownFailureReason,
    readonly serial: string,
    readonly softAttempts: number,
    readonly pid?: number,
  ) {
    super(message);
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
  let lastTimeout: unknown;
  for (;;) {
    try {
      return await waitForDeviceShutdown(
        {
          ...context,
          deadlineMs: Math.max(
            timer.now() + 1,
            Math.min(softDeadlineMs, timer.now() + attemptWindowMs),
          ),
        },
        skipAndroidNameEnrichment,
      );
    } catch (error) {
      if (!isShutdownTimeoutError(error) || context.requestAbortSignal?.aborted) {
        throw error;
      }
      lastTimeout = error;
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
  return await escalateToProcessStop(input, softAttempts, lastTimeout);
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
  softWindowTimeout: unknown,
): Promise<BootedDevice | undefined> {
  const { context, stopper, avdName } = input;
  const serial = context.device.deviceId;
  if (!avdName) {
    throw new EmulatorTeardownEscalationError(
      `Emulator '${serial}' did not stop after ${consoleKills(softAttempts)} and no AVD name is ` +
        `known to verify its process before signalling it. ${emulatorProcessEscapeHint(serial)}`,
      "no-identity",
      serial,
      softAttempts,
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
    return await verifyGoneAfterStop(input, softAttempts, outcome.pid);
  }
  if (isProcessGone(outcome)) {
    // No emulator process remains to signal, yet the last poll still listed the serial: adb's
    // registration is stale or the exit is racing the poll. That is the plain retryable
    // shutdown timeout, not a failed stop.
    throw softWindowTimeout;
  }
  throw failureForOutcome(outcome, serial, avdName, softAttempts);
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
): Promise<BootedDevice | undefined> {
  const { context } = input;
  try {
    return await waitForDeviceShutdown(
      {
        ...context,
        deadlineMs: Math.max(context.deadlineMs, context.timer.now() + FINAL_VERIFICATION_MS),
      },
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
      softAttempts,
      pid,
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
        softAttempts,
        outcome.pid,
      );
    case "identity-mismatch":
      return new EmulatorTeardownEscalationError(
        `Emulator '${serial}' now runs AVD '${outcome.runningAvdName}', not '${avdName}'; ` +
          "refusing to signal its replacement after the console kills failed.",
        "identity-mismatch",
        serial,
        softAttempts,
        outcome.pid,
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
        softAttempts,
      );
    }
  }
}

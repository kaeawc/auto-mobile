import type { Timer } from "./SystemTimer";
import { raceWithDeadline } from "./raceWithDeadline";

type PhaseTimer = Pick<Timer, "setTimeout" | "clearTimeout">;

/** Detect the runtime's unlabeled abort sentinel; explicit caller reasons retain their meaning. */
function isDefaultAbortReason(reason: unknown): boolean {
  return reason === undefined || (reason instanceof DOMException && reason.name === "AbortError");
}

interface PhaseOptions {
  timer: PhaseTimer;
  timeoutMs: number;
  signal?: AbortSignal;
  graceMs: number;
  label: string;
  timeoutError: () => unknown;
  defaultAbortError?: () => unknown;
  explicitAbortError?: (reason: unknown) => unknown;
  onRaceSettled?: () => void;
  awaitAbortSettlement?: boolean;
  awaitExternalAbortSettlement?: boolean;
  preferOperationFailureOnTimeout?: boolean;
}

function externalAbortReason(signal: AbortSignal, options: PhaseOptions): unknown {
  if (isDefaultAbortReason(signal.reason) && options.defaultAbortError) {
    return options.defaultAbortError();
  }
  return options.explicitAbortError ? options.explicitAbortError(signal.reason) : signal.reason;
}

async function awaitSettlement(operation: Promise<unknown>, options: PhaseOptions): Promise<void> {
  if (options.graceMs === 0) {
    // Give already-aborting operations a bounded microtask turn without advancing a
    // caller's deadline clock (used by pool allocation readiness).
    let settled = false;
    void operation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    for (let turn = 0; turn < 8 && !settled; turn += 1) {
      await Promise.resolve();
    }
    return;
  }
  const graceExpired = Symbol("phase settlement grace expired");
  try {
    await raceWithDeadline(
      operation.then(
        () => undefined,
        () => undefined,
      ),
      {
        timer: options.timer,
        timeoutMs: options.graceMs,
        label: `${options.label} settlement`,
        timeoutError: () => graceExpired,
      },
    );
  } catch (error) {
    if (error !== graceExpired) {
      throw error;
    }
  }
}

interface FailureState {
  timedOut: boolean;
  operationFailureRecorded: boolean;
  operationFailure: unknown;
  controller: AbortController;
}

function phaseFailure(error: unknown, options: PhaseOptions, state: FailureState): unknown {
  const signal = options.signal;
  const distinctOperationFailure =
    state.operationFailureRecorded && state.operationFailure !== state.controller.signal.reason;
  if (signal?.aborted) {
    return externalAbortReason(signal, options);
  }
  if (state.timedOut && options.preferOperationFailureOnTimeout && distinctOperationFailure) {
    return state.operationFailure;
  }
  return error;
}

function linkExternalAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!signal) {
    return () => {};
  }
  const onAbort = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return () => signal.removeEventListener("abort", onAbort);
}

function shouldAwaitSettlement(options: PhaseOptions, timedOut: boolean): boolean {
  return (
    options.awaitAbortSettlement !== false &&
    (timedOut ||
      (options.awaitExternalAbortSettlement !== false && options.signal?.aborted === true))
  );
}

/** Run an owned phase, cancel it on deadline or caller abort, and bound its cleanup wait. */
export async function runPhaseWithSettlement<T>(
  options: PhaseOptions,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { timer, timeoutMs, signal, label, timeoutError, onRaceSettled } = options;
  if (signal?.aborted) {
    throw externalAbortReason(signal, options);
  }

  const controller = new AbortController();
  const unlinkExternalAbort = linkExternalAbort(signal, controller);
  let timedOut = false;
  let operationFailureRecorded = false;
  let operationFailure: unknown;
  let operationPromise: Promise<T> | undefined;
  try {
    try {
      const result = await raceWithDeadline(
        () => {
          operationPromise = operation(controller.signal).catch((error: unknown) => {
            operationFailureRecorded = true;
            operationFailure = error;
            throw error;
          });
          return operationPromise;
        },
        {
          timer,
          timeoutMs,
          signal,
          label,
          timeoutError: () => {
            timedOut = true;
            const error = timeoutError();
            controller.abort(error);
            return error;
          },
        },
      );
      onRaceSettled?.();
      return result;
    } catch (error) {
      onRaceSettled?.();
      if (operationPromise && shouldAwaitSettlement(options, timedOut)) {
        await awaitSettlement(operationPromise, options);
      }
      throw phaseFailure(error, options, {
        timedOut,
        operationFailureRecorded,
        operationFailure,
        controller,
      });
    }
  } finally {
    unlinkExternalAbort();
  }
}

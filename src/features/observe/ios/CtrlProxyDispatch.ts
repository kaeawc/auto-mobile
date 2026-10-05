import { ActionableError } from "../../../models/ActionableError";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { sendCommand, type SendCommandOptions } from "../DeviceServiceUtils";
import type { BaseResult } from "../shared/types";
import type { CtrlProxyActionResult, DelegateContext } from "./types";

export type IOSDispatchResult<T> = T & Pick<CtrlProxyActionResult, "dispatched" | "acknowledged">;

/** VoiceOver's dispatch contract for iOS presses and multi-finger swipes. */
export async function sendIOSPressCommand(
  context: DelegateContext,
  options: SendCommandOptions<BaseResult>,
  idempotent: boolean = false,
): Promise<IOSDispatchResult<BaseResult>> {
  const signal = combineWithAmbientAbort(options.abortSignal);
  let dispatched = false;
  const unconfirmed = (error: string, totalTimeMs: number): IOSDispatchResult<BaseResult> => ({
    success: false,
    totalTimeMs,
    error,
    dispatched,
    acknowledged: false,
    ...(dispatched && !idempotent ? { retryable: false } : {}),
  });
  const startMs = context.timer.now();
  try {
    const result = await sendCommand<IOSDispatchResult<BaseResult>>(context, {
      ...options,
      abortSignal: signal,
      onDispatch: (requestId) => {
        dispatched = true;
        options.onDispatch?.(requestId);
      },
      notConnectedError: () => unconfirmed(options.notConnectedMessage ?? "Not connected", 0),
      timeoutError: (timeout) =>
        unconfirmed(`${options.errorLabel} timed out after ${timeout}ms`, timeout),
    });
    return {
      ...result,
      dispatched,
      acknowledged: result.acknowledged ?? dispatched,
    };
  } catch (error) {
    // A runner refusal acknowledges dispatch; the caller's abort reason does not.
    if (dispatched && error instanceof ActionableError && error !== signal?.reason) {
      throw error;
    }
    logger.warn(`[CtrlProxyDispatch] ${options.errorLabel} transport failed`, error);
    return unconfirmed(errorMessage(error), context.timer.now() - startMs);
  } finally {
    // Preserve cancellation even when connection/capability checks return a failure.
    if (!dispatched) {
      signal?.throwIfAborted();
    }
  }
}

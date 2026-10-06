import { ActionableError } from "../../../models/ActionableError";
import { combineWithAmbientAbort } from "../../../utils/AbortContext";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { raceWithDeadline } from "../../../utils/raceWithDeadline";
import { sendCommand, type SendCommandOptions } from "../DeviceServiceUtils";
import type { BaseResult } from "../shared/types";
import type { CtrlProxyActionResult, DelegateContext } from "./types";

export type IOSDispatchResult<T> = T & Pick<CtrlProxyActionResult, "dispatched" | "acknowledged">;

/**
 * Device-mutating runner commands that carry the host's wait budget as `timeoutMs` (#10084).
 * The runner will not start one that waited in its queue past that budget or whose connection
 * closed, so an action never lands after the host reported it failed. `request_swipe` already
 * sends its own `timeoutMs`. Read-only requests, storage and SQL commands are not listed.
 */
const IOS_WIRE_DEADLINE_REQUEST_TYPES: ReadonlySet<string> = new Set([
  "request_tap_coordinates",
  "request_two_finger_swipe",
  "request_multi_finger_swipe",
  "request_drag",
  "request_pinch",
  "request_set_text",
  "request_append_text",
  "request_clear_text",
  "request_ime_action",
  "request_select_all",
  "request_keyboard",
  "request_press_key",
  "request_press_button",
  "request_press_home",
  "request_press_back",
  "request_shake",
  "request_recent_apps",
  "request_action",
  "request_activate_accessibility_link",
  "request_launch_app",
  "request_reset_permissions",
  "request_rotate",
  "set_hinge_angle",
  "request_clipboard",
  "set_voiceover_state",
]);

/** The single place iOS requests learn their wire deadline; installed on the iOS delegate context. */
export function iosWireDeadlineParams(
  messageType: string,
  timeoutMs: number,
): Record<string, unknown> {
  if (!IOS_WIRE_DEADLINE_REQUEST_TYPES.has(messageType) || !(timeoutMs > 0)) {
    return {};
  }
  // The Swift request models read millisecond fields as integers.
  return { timeoutMs: Math.max(1, Math.round(timeoutMs)) };
}

/** VoiceOver's dispatch contract for iOS presses and multi-finger swipes. */
export async function sendIOSPressCommand(
  context: DelegateContext,
  options: SendCommandOptions<BaseResult>,
  idempotent: boolean = false,
): Promise<IOSDispatchResult<BaseResult>> {
  const signal = combineWithAmbientAbort(options.abortSignal);
  const preDispatch = new AbortController();
  const abortBeforeDispatch = () => preDispatch.abort(signal?.reason);
  const stopRacingAbort = () => signal?.removeEventListener("abort", abortBeforeDispatch);
  signal?.addEventListener("abort", abortBeforeDispatch, { once: true });
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
    signal?.throwIfAborted();
    const result = await raceWithDeadline(
      () =>
        sendCommand<IOSDispatchResult<BaseResult>>(context, {
          ...options,
          abortSignal: signal,
          onDispatch: (requestId) => {
            dispatched = true;
            // From this marker onward, only sendCommand settles the request so
            // cancellation retains the dispatched-but-unconfirmed contract.
            stopRacingAbort();
            options.onDispatch?.(requestId);
          },
          notConnectedError: () => unconfirmed(options.notConnectedMessage ?? "Not connected", 0),
          timeoutError: (timeout) =>
            unconfirmed(`${options.errorLabel} timed out after ${timeout}ms`, timeout),
        }),
      {
        timer: context.timer,
        signal: preDispatch.signal,
        label: "iOS CtrlProxy press dispatch",
      },
    );
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
    stopRacingAbort();
    // Preserve cancellation even when connection/capability checks return a failure.
    if (!dispatched) {
      signal?.throwIfAborted();
    }
  }
}

import { ActionableError } from "../models/ActionableError";
import { errorMessage } from "../utils/describeUnknownError";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import {
  CtrlProxyForwardingLeaseConflictError,
  recentForwardingLeaseConflict,
} from "../features/observe/shared/CtrlProxyForwardingLeaseConflictError";

/**
 * The CtrlProxy forwarding-lease conflict that explains a failed tool call, if
 * any (issue #10485). A tool whose CtrlProxy connection failed on the lease
 * often surfaces a downstream symptom — "Cannot perform action without view
 * hierarchy" or a device-loss outcome — that blames the device. When a
 * conflict was recorded for one of the call's devices, report it instead.
 */
export function forwardingLeaseConflictCause(
  error: unknown,
  deviceIds: Iterable<string> | undefined,
  timer: Timer = defaultTimer,
): ActionableError | undefined {
  const conflict =
    error instanceof CtrlProxyForwardingLeaseConflictError
      ? error
      : recentForwardingLeaseConflict(deviceIds, timer);
  if (!conflict) {
    return undefined;
  }
  if (error !== conflict && errorMessage(error).includes(conflict.message)) {
    // The failure already names the conflict (e.g. a readiness error); keep its context.
    return undefined;
  }
  return new ActionableError(conflict.message, { cause: error });
}

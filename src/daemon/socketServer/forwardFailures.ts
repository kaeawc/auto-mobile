import { InputKey } from "../../features/action/InputKey";
import { indeterminateTapError } from "../../features/action/coordinateTapDispatch";
import { ActionableError } from "../../models/ActionableError";
import { errorMessage } from "../../utils/describeUnknownError";

/** The indeterminate-outcome error for an input request that was dispatched before its caller aborted. */
export function indeterminateInputError(method: string, error: unknown): Error {
  const label =
    method === "input/key"
      ? "Key"
      : method === "input/tap"
        ? "Tap"
        : method === "input/swipe"
          ? "Swipe"
          : "Button press";
  if (
    error instanceof Error &&
    (("requestDispatched" in error && error.requestDispatched === true) ||
      error.message.startsWith(`${label} outcome is indeterminate:`))
  ) {
    return Object.assign(error, { requestDispatched: true });
  }
  const reason = errorMessage(error);
  const failure =
    method === "input/key"
      ? InputKey.indeterminateError(error)
      : method === "input/tap"
        ? indeterminateTapError(reason)
        : new ActionableError(
            `${method === "input/swipe" ? "Swipe" : "Button press"} outcome is indeterminate: the request was dispatched but no result was confirmed (${reason}). Do not retry automatically.`,
          );
  return Object.assign(failure, { requestDispatched: true });
}

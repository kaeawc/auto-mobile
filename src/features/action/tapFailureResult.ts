import { ActionableError, type Element, type TapOnElementResult } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import { errorMessage } from "../../utils/describeUnknownError";
import type { buildElementSearchDebugContext } from "../utility/ElementSearchDebugContext";
import { markFocusFailure, type TapOnFocusResult } from "./tapFocusResult";
import { tapHierarchyUnavailableFields } from "./tapHierarchyUnavailable";

/** The failed tapOn result for an error raised while resolving or tapping the target. */
export function tapFailureResult(
  requestedAction: NonNullable<TapOnElementOptions["action"]>,
  action: TapOnElementOptions["action"],
  error: unknown,
  {
    searchUntilStats,
    debugContext,
  }: {
    searchUntilStats?: TapOnElementResult["searchUntil"];
    debugContext: Awaited<ReturnType<typeof buildElementSearchDebugContext>>;
  },
): TapOnFocusResult {
  return markFocusFailure(
    requestedAction,
    {
      success: false,
      action,
      error: `Failed to perform tap on element: ${errorMessage(error)}`,
      element: {
        bounds: { left: 0, top: 0, right: 0, bottom: 0 },
      } as Element,
      ...(searchUntilStats ? { searchUntil: searchUntilStats } : {}),
      ...(error instanceof ActionableError && error.containerFailure
        ? { containerFailure: error.containerFailure }
        : {}),
      ...tapHierarchyUnavailableFields(error),
      ...(debugContext ? { debug: { elementSearch: debugContext } } : {}),
    },
    error,
  );
}

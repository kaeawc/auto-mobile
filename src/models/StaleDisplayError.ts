import { DispatchedObservationError } from "./DispatchedObservationError";
import { displayPinFailure, selectedDisplayPin } from "../features/observe/SessionDisplayContext";
import { PinnedDisplayUnavailableError } from "./PinnedDisplayError";
import { ActionableError } from "./ActionableError";
import type { BaseActionResult } from "./BaseActionResult";

export interface StaleDisplayDetails {
  observedGeneration: number;
  currentGeneration: number;
  currentDisplayKey?: string;
  retry: "observe";
}

/** One actionable refusal for coordinates crossing a display transition. */
export class StaleDisplayError extends ActionableError {
  constructor(readonly details: StaleDisplayDetails) {
    const pin = selectedDisplayPin();
    const pinGuidance =
      pin === undefined
        ? ""
        : ` If pinned display ${JSON.stringify(pin)} is unavailable, clear the pin with setActiveDevice {display: null} (include deviceId and sessionUuid), or change it with setActiveDevice {display: <available key or role>} before re-observing.`;
    super(
      `Display changed since these coordinates were chosen (observed generation ${details.observedGeneration}, current generation ${details.currentGeneration}).${pinGuidance} Re-observe ${details.currentDisplayKey === undefined ? "the active panel" : `display "${details.currentDisplayKey}"`} and choose the target again before retrying.`,
    );
    this.name = "StaleDisplayError";
  }
}

export function staleDisplayError(
  observedGeneration: number,
  currentGeneration: number,
  currentDisplayKey?: string,
): StaleDisplayError {
  return new StaleDisplayError({
    observedGeneration,
    currentGeneration,
    ...(currentDisplayKey === undefined ? {} : { currentDisplayKey }),
    retry: "observe",
  });
}

/** Preserve the canonical message and typed details in the action's existing result channel. */
export function withStaleDisplay<T extends BaseActionResult>(result: T, error: unknown): T {
  if (error instanceof DispatchedObservationError) {
    // Retain display guidance without replacing the completed-gesture warning.
    return { ...withStaleDisplay(result, error.cause), error: result.error ?? error.message };
  }
  const pinError = displayPinFailure(error);
  if (pinError instanceof PinnedDisplayUnavailableError) {
    return { ...result, error: pinError.message, pinnedDisplay: pinError.details };
  }
  return error instanceof StaleDisplayError
    ? { ...result, error: error.message, staleDisplay: error.details }
    : result;
}

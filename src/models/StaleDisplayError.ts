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
    super(
      `Display changed since these coordinates were chosen (observed generation ${details.observedGeneration}, current generation ${details.currentGeneration}). Re-observe ${details.currentDisplayKey === undefined ? "the active panel" : `display "${details.currentDisplayKey}"`} and choose the target again before retrying.`,
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
  return error instanceof StaleDisplayError
    ? { ...result, error: error.message, staleDisplay: error.details }
    : result;
}

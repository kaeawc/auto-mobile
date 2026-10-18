import type { ObserveResult } from "../../models";

import type { ObserveError, ObservePhase } from "../../models/ObserveError";

export type { ObserveError, ObservePhase };

export function appendObserveError(result: ObserveResult, err: ObserveError): void {
  if (!result.errors) {
    result.errors = [];
    // Preserve a pre-existing `error` string (set by legacy code paths or
    // direct assignment) so the derived `error` keeps concatenating instead
    // of overwriting it.
    if (result.error) {
      result.errors.push({ phase: "critical", message: result.error });
    }
  }
  result.errors.push(err);
  result.error = result.errors.map((e) => e.message).join("; ");
}

import type { ObserveResult } from "../../models";

export type ObservePhase =
  | "screenSize"
  | "systemInsets"
  | "rotation"
  | "wakefulness"
  | "backStack"
  | "viewHierarchy"
  | "rawViewHierarchy"
  | "intentChooser"
  | "activeWindow"
  | "screenshot"
  | "performanceAudit"
  | "accessibilityAudit"
  | "accessibilityState"
  | "predictiveUI"
  | "cache"
  | "critical";

export interface ObserveError {
  phase: ObservePhase;
  message: string;
  cause?: string;
}

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

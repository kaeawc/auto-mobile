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

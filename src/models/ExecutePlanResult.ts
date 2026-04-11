import type { FailureObservationSummary } from "./FailureObservation";

/**
 * When passed to plan execution, each successful `observe` step stores a
 * {@link FailureObservationSummary}-shaped payload in `debug.steps[n].details.stepObservation`.
 * `summary` omits `viewHierarchy` / `rawViewHierarchy` to keep `executePlan` responses smaller.
 */
export type CaptureObserveStepMode = "summary" | "full";

export interface PlanExecutionOptions {
  /**
   * When set, successful `observe` steps include `debug.steps[n].details.stepObservation`.
   * Ignored for multi-device (parallel) plans.
   */
  captureObserveSteps?: CaptureObserveStepMode;
}

export interface ExecutePlanStepDebugInfo {
  step: string;
  status: "completed" | "failed" | "skipped";
  durationMs: number;
  /**
   * Per-step metadata. Common fields:
   * - `params` — step arguments
   * - `stepObservation` — successful `observe` snapshots when `captureObserveSteps` is set
   * - `tapDebug` — Android `tapOn` tap diagnostics when the tool returned it (success or failure)
   */
  details?: any;
}

export interface ExecutePlanDebugInfo {
  executionTimeMs: number;
  steps: ExecutePlanStepDebugInfo[];
  deviceState?: {
    currentActivity?: string;
    focusedWindow?: string;
  };
}

export interface ExecutePlanResult {
  success: boolean;
  executedSteps: number;
  totalSteps: number;
  failedStep?: {
    stepIndex: number;
    tool: string;
    error: string;
    device?: string;
    failureObservation?: FailureObservationSummary;
  };
  error?: string;
  platform?: "android" | "ios";
  deviceId?: string; // The device ID that executed the plan (e.g., "emulator-5554" or "7B3A3792-DB53-4654-BA94-27A1D305C3B7")
  deviceMapping?: Record<string, string>; // Maps device labels to device IDs (e.g., {"A": "emulator-5554", "B": "emulator-5556"})
  debug?: ExecutePlanDebugInfo;
}

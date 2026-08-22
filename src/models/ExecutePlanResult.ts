import type { FailureObservationSummary } from "./FailureObservation";

/**
 * When passed to plan execution, each successful `observe` step stores a
 * {@link FailureObservationSummary}-shaped payload in `debug.steps[n].details.stepObservation`.
 * `summary` omits `viewHierarchy` / `rawViewHierarchy` to keep `executePlan` responses smaller.
 */
export type CaptureObserveStepMode = "summary" | "full";

/** Passed to {@link PlanExecutionOptions.onBeforePlanStep} before each step runs. */
export interface PlanStepLifecycleContext {
  stepIndex: number;
  totalSteps: number;
}

export interface PlanExecutionOptions {
  captureObserveSteps?: CaptureObserveStepMode;

  /**
   * Invoked at the start of each step (after abort checks), before the tool runs.
   * Used for cross-cutting concerns such as rotating Android screen recordings before the
   * 180s `screenrecord` cap. Ignored for multi-device (parallel) plans.
   */
  onBeforePlanStep?: (ctx: PlanStepLifecycleContext) => Promise<void>;
}

export interface ExecutePlanStepDebugInfo {
  step: string;
  status: "completed" | "failed" | "skipped";
  durationMs: number;
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
  /** Populated when automatic plan video used multiple Android segments (screenrecord limit). */
  videoFilePaths?: string[];
  videoRecordingIds?: string[];
}

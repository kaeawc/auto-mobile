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

/**
 * A successful step's best-effort-epilogue warnings (issue #6868), promoted to
 * the plan result. `debug` only reaches the `executePlan` response when the
 * unrelated `captureObserveSteps` option is set, so a warning kept solely in the
 * step trace never reaches an ordinary plan's caller (#6887 review).
 */
export interface PlanStepWarnings {
  /** 0-based index of the step in the plan. */
  stepIndex: number;
  tool: string;
  /** Device label, for multi-device plans only. */
  device?: string;
  warnings: string[];
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
  /** Best-effort warnings from steps that still succeeded (issue #6868). */
  warnings?: PlanStepWarnings[];
  /** Populated when automatic plan video used multiple Android segments (screenrecord limit). */
  videoFilePaths?: string[];
  videoRecordingIds?: string[];
}

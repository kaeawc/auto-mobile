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
  signal?: AbortSignal;
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

/** A failed optional step that was skipped while execution continued. */
export interface PlanSkippedStep {
  /** 0-based index of the step in the plan. */
  stepIndex: number;
  tool: string;
  error: string;
  /** Device label, for multi-device plans only. */
  device?: string;
}

/** A failing device track in a multi-device plan, including cancellation consequences. */
export interface PlanDeviceFailure {
  /** 0-based plan step index, or -1 for a track-level failure without a step. */
  stepIndex: number;
  tool: string;
  error: string;
  /** Device label from the plan. */
  device: string;
  /** Failure evidence captured for this device, when available. */
  failureObservation?: FailureObservationSummary;
}

/** Per-tool aggregate over the steps a plan run executed. */
export interface PlanToolHealth {
  tool: string;
  count: number;
  failed: number;
  skipped: number;
  totalMs: number;
  maxMs: number;
}

/** Compact end-of-run summary of what the plan path already observed. */
export interface PlanHealthSummary {
  success: boolean;
  totalSteps: number;
  executedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  warningCount: number;
  durationMs: number;
  slowestStep?: { stepIndex: number; tool: string; durationMs: number };
  tools: PlanToolHealth[];
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
  /** All failing tracks for plans with two or more devices, in reported-failure order. */
  deviceFailures?: PlanDeviceFailure[];
  error?: string;
  platform?: "android" | "ios";
  deviceId?: string; // The device ID that executed the plan (e.g., "emulator-5554" or "7B3A3792-DB53-4654-BA94-27A1D305C3B7")
  deviceMapping?: Record<string, string>; // Maps device labels to device IDs (e.g., {"A": "emulator-5554", "B": "emulator-5556"})
  debug?: ExecutePlanDebugInfo;
  /** Opt-in (AUTOMOBILE_PLAN_HEALTH_DIR set): compact end-of-run aggregate of step latency, failures and skips (#2306). */
  healthSummary?: PlanHealthSummary;
  /** Best-effort warnings from completed steps and sub-steps that ran before a failed or skipped step failed (issue #6868). */
  warnings?: PlanStepWarnings[];
  /** Failed optional steps, reported regardless of captureObserveSteps. */
  skippedSteps?: PlanSkippedStep[];
  /** Populated when automatic plan video used multiple Android segments (screenrecord limit). */
  videoFilePaths?: string[];
  videoRecordingIds?: string[];
  /** Capture gaps, truncation or failures, including when no video could be returned. */
  videoWarnings?: string[];
}

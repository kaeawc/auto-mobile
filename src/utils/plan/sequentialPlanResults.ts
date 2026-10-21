import { ActionableError } from "../../models";
import type { PlanStep, PlanExecutionResult } from "../../models/Plan";
import type {
  ExecutePlanStepDebugInfo,
  PlanStepWarnings,
  PlanSkippedStep,
  PlanExecutionOptions,
} from "../../models/ExecutePlanResult";
import type { StepExecutionResult } from "./PlanStepExecutor";
import { StepToolResultCollector } from "./stepToolResults";
import { logger } from "../logger";
import { throwIfAborted } from "../toolUtils";
import { redactToolSecrets } from "../redactToolSecrets";

export interface SequentialExecutionRecords {
  executedSteps: number;
  startTime: number;
  debugSteps: ExecutePlanStepDebugInfo[];
  warnings: PlanStepWarnings[];
  skippedSteps: PlanSkippedStep[];
  toolResults: StepToolResultCollector;
}

export function beforeSequentialStep(options: {
  executionOptions?: PlanExecutionOptions;
  stepIndex: number;
  totalSteps: number;
  signal?: AbortSignal;
}): Promise<void> {
  const { executionOptions, stepIndex, totalSteps, signal } = options;
  if (executionOptions?.onBeforePlanStep) {
    const beforeStep = executionOptions.onBeforePlanStep({
      stepIndex,
      totalSteps,
      ...(signal ? { signal } : {}),
    });
    return beforeStep.finally(() => throwIfAborted(signal));
  }
  return Promise.resolve();
}

export function recordSequentialStep(options: {
  records: SequentialExecutionRecords;
  step: PlanStep;
  stepIndex: number;
  result: StepExecutionResult;
  durationMs: number;
}): void {
  const { records, step, stepIndex, result, durationMs } = options;
  const stepNumber = stepIndex + 1;
  if (result.warnings) {
    records.warnings.push({ stepIndex, tool: step.tool, warnings: result.warnings });
  }
  if (result.status === "completed") {
    records.toolResults.add(stepIndex, step.tool, result.toolPayload);
  }
  if (result.status === "skipped") {
    const error = result.error ?? "Unknown error";
    logger.warn(
      `[PLAN_STEP_${stepNumber}] optional step ${step.tool} failed; skipping and continuing: ${error}`,
    );
    records.skippedSteps.push({ stepIndex, tool: step.tool, error });
    records.debugSteps.push({
      step: `Execute step ${stepNumber}: ${step.tool}`,
      status: "skipped",
      durationMs,
      details: { params: redactToolSecrets(step.tool, step.params), error, optional: true },
    });
    return;
  }
  if (result.status === "failed") {
    logger.error(`[PLAN_STEP_${stepNumber}] FAILED: ${step.tool} - ${result.error}`);
  }
  records.debugSteps.push({
    step: `Execute step ${stepNumber}: ${step.tool}`,
    status: result.status,
    durationMs,
    details: result.details,
  });
}

export function sequentialResult(options: {
  records: SequentialExecutionRecords;
  totalSteps: number;
  now: number;
  failedStep?: PlanExecutionResult["failedStep"];
}): PlanExecutionResult {
  const { records, totalSteps, now, failedStep } = options;
  return {
    success: failedStep === undefined,
    executedSteps: records.executedSteps,
    totalSteps,
    ...(failedStep ? { failedStep } : {}),
    debug: { executionTimeMs: now - records.startTime, steps: records.debugSteps },
    ...(records.warnings.length > 0 ? { warnings: records.warnings } : {}),
    ...(records.skippedSteps.length > 0 ? { skippedSteps: records.skippedSteps } : {}),
    ...records.toolResults.asField(),
  };
}

export function sequentialFailedStep(
  step: PlanStep,
  stepIndex: number,
  result: StepExecutionResult,
): NonNullable<PlanExecutionResult["failedStep"]> {
  return {
    stepIndex,
    tool: step.tool,
    error: result.error ?? "Unknown error",
    ...(result.failureObservation ? { failureObservation: result.failureObservation } : {}),
  };
}

export function planStepLabel(step: PlanStep): string {
  return step.label || step.params?.label || JSON.stringify(step.params).substring(0, 50);
}
export function normalizeSequentialStartStep(
  plan: { steps: PlanStep[] },
  startStep: number,
): number {
  if (startStep < 0) {
    return 0;
  }
  if (plan.steps.length > 0 && startStep >= plan.steps.length) {
    throw new ActionableError(
      `Start step index ${startStep} is out of bounds. Plan has ${plan.steps.length} steps (valid range: 0-${plan.steps.length - 1})`,
    );
  }
  return startStep;
}

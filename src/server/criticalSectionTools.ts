import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { DaemonState } from "../daemon/daemonState";
import { ToolRegistry, type RegisteredTool } from "./toolRegistry";
import { ActionableError, BootedDevice, toActionableError } from "../models/index";
import { logger } from "../utils/logger";
import { abortErrorFromSignal, createJSONToolResponse, throwIfAborted } from "../utils/toolUtils";
import { CriticalSectionCoordinator } from "./CriticalSectionCoordinator";
import { PlanNormalizer } from "../utils/plan/PlanNormalizer";
import { migratePlanStep } from "../utils/plan/PlanMigrator";
import {
  DefaultPlanStepExecutor,
  type PlanStepExecutor,
  type StepExecutionResult,
  PlanStepError as CriticalSectionStepError,
} from "../utils/plan/PlanStepExecutor";
import { type Timer, defaultTimer } from "../utils/SystemTimer";
import { addDeviceTargetingToSchema } from "./toolSchemaHelpers";
import { isDeviceLostError } from "./deviceLossOutcome";
import type { PlanStep } from "../models/Plan";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";

// Schema for steps inside critical section.
// Every sub-step MUST declare a `device` matching the section owner label.
// Sub-steps execute on that owner device; they never route to another label.
const criticalSectionStepSchema = z
  .object({
    tool: z.string().describe("Tool name"),
    params: z.record(z.string(), z.any()).describe("Tool params; must include device"),
    label: z.string().optional().describe("Step label"),
  })
  .passthrough()
  .superRefine((step, ctx) => {
    const device = step.params?.device;
    if (device === undefined || device === null || device === "") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["params", "device"],
        message: "Every step inside a criticalSection must declare a non-empty 'device' parameter",
      });
    }
  });

// Critical section tool schema
const criticalSectionSchema = addDeviceTargetingToSchema(
  z
    .object({
      lock: z.string().describe("Shared barrier lock name"),
      steps: z
        .array(criticalSectionStepSchema)
        .min(1)
        .describe("Serial steps; each needs params.device"),
      deviceCount: z.number().int().positive().describe("Devices required at barrier"),
      timeout: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Barrier timeout ms (default 30000)"),
      // Internal: the plan's base session UUID, injected by PlanExecutor
      // (buildEnhancedStepParams). Scopes the shared coordinator so two independent
      // plans that reuse the same lock name get isolated barriers instead of
      // colliding. Not authored by users; stripped from recordings via INTERNAL_PARAMS.
      __lockNamespace: z
        .string()
        .optional()
        .describe("Internal plan-scoped lock namespace (injected)"),
    })
    .strict(),
);

type CriticalSectionParams = z.infer<typeof criticalSectionSchema>;

function criticalSectionSuccess(
  lock: string,
  deviceId: string,
  executedSteps: number,
  totalSteps: number,
  warnings: string[],
): ReturnType<typeof createJSONToolResponse> {
  return createJSONToolResponse({
    success: true,
    lock,
    deviceId,
    executedSteps,
    totalSteps,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
}

function legacyStepError(result: StepExecutionResult): string {
  // Keep the existing section message for thrown Errors and missing tools. The
  // new failedStep.error carries the exact shared executor error for consumers.
  return result.sourceError && !(result.sourceError instanceof z.ZodError)
    ? errorMessage(result.sourceError)
    : (result.error ?? "Unknown error");
}

function throwCriticalSectionStepFailure(
  step: PlanStep,
  result: StepExecutionResult,
  errorMsg: string,
  context: {
    device: BootedDevice;
    params: CriticalSectionParams;
    index: number;
    warnings: string[];
    signal?: AbortSignal;
  },
): never {
  const { device, params, index, warnings, signal } = context;
  const stepNumber = index + 1;
  // Retain the section's existing cancellation and optional authoring-error
  // boundary messages. Neither is a skippable transient failure.
  if (step.optional && signal?.aborted) {
    throw result.sourceError ?? new ActionableError(errorMsg);
  }
  const message =
    step.optional && result.sourceError instanceof z.ZodError
      ? errorMsg
      : `Failed at step ${stepNumber}/${params.steps.length} (${step.tool}): ${errorMsg}`;
  logger.error(
    `Device ${device.deviceId} failed at step ${stepNumber}/${params.steps.length} in critical section "${params.lock}": ${errorMsg}`,
  );
  throw new CriticalSectionStepError(message, warnings, {
    stepIndex: index,
    tool: step.tool,
    error: result.error ?? "Unknown error",
    ...(result.failureObservation ? { failureObservation: result.failureObservation } : {}),
  });
}

async function executeCriticalSectionSteps(
  device: BootedDevice,
  normalizedSteps: PlanStep[],
  params: CriticalSectionParams,
  stepExecutor: PlanStepExecutor,
  signal?: AbortSignal,
): Promise<{ executedSteps: Array<{ tool: string; success: boolean }>; warnings: string[] }> {
  const executedSteps: Array<{ tool: string; success: boolean }> = [];
  const warnings: string[] = [];

  for (const [index, step] of normalizedSteps.entries()) {
    throwIfAborted(signal);
    const stepNumber = index + 1;
    const result = await stepExecutor.executeStep(step, {
      platform: device.platform,
      deviceId: device.deviceId,
      sessionUuid: getToolSelectionContext()?.routingSessionUuid ?? params.sessionUuid,
      targetDevice: device,
      signal,
      logPrefix: `[CRITICAL_SECTION][${device.deviceId}][${stepNumber}]`,
      debugLog: true,
    });
    warnings.push(
      ...(result.warnings ?? []).map((warning) => `step ${stepNumber} (${step.tool}): ${warning}`),
    );
    executedSteps.push({ tool: step.tool, success: result.status === "completed" });
    if (result.status === "completed") {
      continue;
    }

    const errorMsg = legacyStepError(result);
    if (result.status === "skipped") {
      warnings.push(
        `step ${stepNumber} (${step.tool}): optional step failed; skipped: ${errorMsg}`,
      );
      logger.warn(
        `Device ${device.deviceId} optional step ${step.tool} failed; skipping and continuing: ${errorMsg}`,
      );
      continue;
    }

    throwCriticalSectionStepFailure(step, result, errorMsg, {
      device,
      params,
      index,
      warnings,
      signal,
    });
  }

  // executedSteps has historically counted attempts, including optional skips.
  // Keep that public count while using the shared executor's skip policy.
  return { executedSteps, warnings };
}

function validateCriticalSectionSteps(
  normalizedSteps: PlanStep[],
  lock: string,
  ownerLabel?: string,
): void {
  // Validate steps to prevent nesting. A nested criticalSection or barrier
  // would deadlock: the device holding this section's mutex would wait for
  // peers that cannot enter until it releases.
  for (const [index, step] of normalizedSteps.entries()) {
    // Plan routing retains the owner label in params.device. A direct call
    // without that label keeps its existing pinned-device behavior.
    if (
      ownerLabel &&
      step.params?.device !== undefined &&
      step.params.device !== null &&
      step.params.device !== "" &&
      step.params.device !== ownerLabel
    ) {
      throw new ActionableError(
        `steps[${index}] (${step.tool}): device="${step.params.device}" differs from criticalSection owner device="${ownerLabel}". Put it in its own step for that device or use a separate criticalSection step.`,
      );
    }
    if (step.tool === "criticalSection" || step.tool === "barrier") {
      throw new ActionableError(
        `Nested critical sections are not supported. Found ${step.tool} step inside critical section "${lock}".`,
      );
    }
  }
}

/**
 * Critical section tool handler.
 * Coordinates multiple devices to execute steps serially at a synchronization point.
 */
const criticalSectionHandler = async (
  stepExecutor: PlanStepExecutor,
  device: BootedDevice,
  params: CriticalSectionParams,
  _progress?: unknown,
  signal?: AbortSignal,
): Promise<any> => {
  const { lock, steps, deviceCount, timeout, __lockNamespace: namespace } = params;
  // Sub-steps are not in `plan.steps`, so migratePlan never saw them; apply the
  // same legacy-shape migration here so `tapOn { text }` and friends behave as
  // they do at the top level (#9927).
  const migratedSteps = steps.map((step, index) =>
    migratePlanStep(step, index, { platform: device.platform }),
  );
  const normalizedSteps = PlanNormalizer.normalizeSteps(migratedSteps);
  const coordinator = CriticalSectionCoordinator.getInstance();

  logger.info(
    `Device ${device.deviceId} entering critical section "${lock}" (expecting ${deviceCount} devices)`,
  );

  // Preserve the caller's abort reason before entering coordination.
  throwIfAborted(signal, true);

  // Register expected device count
  try {
    coordinator.registerExpectedDevices(lock, deviceCount, namespace);
  } catch (error) {
    throw toActionableError(error, `Failed to register devices for critical section "${lock}"`);
  }

  let release: (() => void) | undefined;

  try {
    validateCriticalSectionSteps(normalizedSteps, lock, params.device);

    // Wait at barrier and acquire lock
    release = await coordinator.enterCriticalSection(
      lock,
      device.deviceId,
      timeout,
      namespace,
      signal,
    );

    logger.info(
      `Device ${device.deviceId} executing ${normalizedSteps.length} steps in critical section "${lock}"`,
    );

    // Execute steps serially
    const { executedSteps, warnings } = await executeCriticalSectionSteps(
      device,
      normalizedSteps,
      params,
      stepExecutor,
      signal,
    );

    logger.info(`Device ${device.deviceId} completed all steps in critical section "${lock}"`);

    return criticalSectionSuccess(
      lock,
      device.deviceId,
      executedSteps.length,
      normalizedSteps.length,
      warnings,
    );
  } catch (error) {
    // Force cleanup on error to prevent other devices from waiting forever
    coordinator.forceCleanup(lock, namespace);

    const errorMsg = errorMessage(error);
    logger.error(`Device ${device.deviceId} error in critical section "${lock}": ${errorMsg}`);

    if (
      isDeviceLostError(error) ||
      (signal?.aborted &&
        (signal.reason === undefined ||
          signal.reason === null ||
          error === abortErrorFromSignal(signal)))
    ) {
      throw error;
    }
    const message = `Critical section "${lock}" failed for device ${device.deviceId}: ${errorMsg}`;
    if (error instanceof CriticalSectionStepError) {
      throw new CriticalSectionStepError(message, error.warnings, error.failedStep);
    }
    throw new ActionableError(message);
  } finally {
    // Release the lock if we acquired it
    if (release) {
      release();
    }
  }
};

/**
 * Register the criticalSection tool.
 */
export function registerCriticalSectionTools(timer: Timer = defaultTimer): void {
  const stepExecutor = new DefaultPlanStepExecutor<RegisteredTool>(
    ToolRegistry,
    () => DaemonState.getInstance().isInitialized(),
    timer,
  );
  ToolRegistry.registerDeviceAware(
    "criticalSection",
    "Synchronize multiple devices at a barrier, then run steps serially.",
    criticalSectionSchema,
    (device, params, progress, signal) =>
      criticalSectionHandler(stepExecutor, device, params, progress, signal),
    // Plan-only: a multi-device coordination primitive that only makes sense as
    // a plan step (a single direct call would just block). Hidden from tools/list
    // discovery, still runnable in plans via getToolForPlan.
    { defaultEnabled: false, planOnly: true, planExecutable: true, acceptsPlanLockNamespace: true },
  );

  logger.info("Critical section tools registered");
}

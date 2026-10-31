import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { BootedDevice } from "../models";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { Platform } from "../models";
import { DEVICE_LABEL_DESCRIPTION } from "../utils/schemaHelpers";
import { registerDeviceGestureRecordingTools } from "./deviceGestureRecordingTools";
import { registerToolCallRecordingTools } from "./toolCallRecordingTools";
import { PlanExecutionOrchestrator, PlanExecutionRequest } from "./planExecutionOrchestrator";
import { failedPlanSessionHoldable, planLifecycleSessionUuid } from "./deviceLabelMapping";
import type { ExecutePlanResult } from "../models/ExecutePlanResult";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../features/toolSelection/toolSelectionContext";
import { holdTaskDeviceLeases } from "./tasks/runAsTask";
import { planCallerContext } from "./planCallerIdentity";
import {
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
} from "../daemon/wire/constants";

const testMetadataSchema = z.object({
  testClass: z.string(),
  testMethod: z.string(),
  appVersion: z.string().optional(),
  gitCommit: z.string().optional(),
  targetSdk: z.coerce.number().int().positive().optional(),
  jdkVersion: z.string().optional(),
  jvmTarget: z.string().optional(),
  gradleVersion: z.string().optional(),
  isCi: z.boolean().optional(),
});

// Execute plan tool schema
const executePlanSchema = z
  .object({
    planContent: z.string().describe("YAML plan content"),
    startStep: z.number().default(0).describe("Start step index"),
    platform: z.enum(["android", "ios"]),
    sessionUuid: z.string().optional().describe("Session"),
    keepScreenAwake: z.boolean().optional(),
    deviceId: z.string().optional(),
    device: z.string().optional().describe(DEVICE_LABEL_DESCRIPTION),
    devices: z.array(z.string()).optional().describe("Device labels"),
    deviceAllocationTimeoutMs: z.number().default(300000).describe("Allocation timeout ms"),
    abortStrategy: z
      .enum(["immediate", "finish-current-step"])
      .default("immediate")
      .describe("Abort strategy"),
    testMetadata: testMetadataSchema.optional().describe("Test metadata"),
    cleanupAppId: z.string().optional().describe("Cleanup app ID"),
    cleanupClearAppData: z.boolean().optional().describe("Clear app data"),
    holdSessionOnFailure: z
      .boolean()
      .optional()
      .describe("Keep session and device after a failed run (caller recovers, then releases)"),
    captureObserveSteps: z
      .enum(["summary", "full"])
      .optional()
      .describe("Attach observe snapshots"),
  })
  .strict();

const executePlanDebugStepSchema = z.object({
  step: z.string(),
  status: z.enum(["completed", "failed", "skipped"]),
  durationMs: z.number().int(),
  details: z.any().optional(),
});

const executePlanDebugSchema = z.object({
  executionTimeMs: z.number().int(),
  steps: z.array(executePlanDebugStepSchema),
  deviceState: z
    .object({
      currentActivity: z.string().optional(),
      focusedWindow: z.string().optional(),
    })
    .optional(),
});

const executePlanHealthSummarySchema = z
  .object({
    success: z.boolean(),
    totalSteps: z.number().int(),
    executedSteps: z.number().int(),
    failedSteps: z.number().int(),
    skippedSteps: z.number().int(),
    warningCount: z.number().int(),
    durationMs: z.number().int(),
    slowestStep: z
      .object({ stepIndex: z.number().int(), tool: z.string(), durationMs: z.number().int() })
      .optional(),
    tools: z.array(
      z.object({
        tool: z.string(),
        count: z.number().int(),
        failed: z.number().int(),
        skipped: z.number().int(),
        totalMs: z.number().int(),
        maxMs: z.number().int(),
      }),
    ),
  })
  .describe("End-of-run aggregate of per-tool step latency, failures and skips");

const executePlanResultSchema = z
  .object({
    success: z.boolean(),
    executedSteps: z.number().int(),
    totalSteps: z.number().int(),
    failedStep: z
      .object({
        stepIndex: z.number().int(),
        tool: z.string(),
        error: z.string(),
        device: z.string().optional(),
        failureObservation: z.any().optional(),
      })
      .optional(),
    deviceFailures: z
      .array(
        z.object({
          stepIndex: z.number().int(),
          tool: z.string(),
          error: z.string(),
          device: z.string(),
          failureObservation: z.any().optional(),
        }),
      )
      .optional()
      .describe(
        "All failing device tracks for multi-device plans, including abort consequences; ordered by cause, plan step index (-1 last), then plan device order. The first entry is the same failure as failedStep and omits failureObservation (see failedStep); abort consequences never carry failureObservation.",
      ),
    error: z.string().optional(),
    platform: z.enum(["android", "ios"]).optional(),
    deviceId: z.string().optional(),
    deviceMapping: z.record(z.string(), z.string()).optional(),
    debug: executePlanDebugSchema.optional(),
    healthSummary: executePlanHealthSummarySchema.optional(),
    videoFilePaths: z.array(z.string()).optional(),
    videoRecordingIds: z.array(z.string()).optional(),
    videoWarnings: z
      .array(z.string())
      .optional()
      .describe("Video capture gaps, truncation or failures"),
    warnings: z
      .array(
        z.object({
          stepIndex: z.number().int(),
          tool: z.string(),
          device: z.string().optional(),
          warnings: z.array(z.string()),
        }),
      )
      .optional()
      .describe(
        "Best-effort warnings from completed steps and sub-steps that ran before a failed or skipped step failed",
      ),
    skippedSteps: z
      .array(
        z.object({
          stepIndex: z.number().int(),
          tool: z.string(),
          error: z.string(),
          device: z.string().optional(),
        }),
      )
      .optional()
      .describe("Failed optional steps that were skipped while execution continued"),
    toolResults: z
      .array(
        z.object({
          stepIndex: z.number().int(),
          tool: z.string(),
          device: z.string().optional(),
          result: z.record(z.string(), z.unknown()),
          truncated: z.boolean().optional(),
        }),
      )
      .optional()
      .describe(
        "Completed steps' tool payloads in plan step order (stepIndex is the plan step index), without bulky fields (observation, view hierarchies, screenshots, tap diagnostics, warnings); capped per step and, across all device tracks, per plan, with truncated:true when a payload was narrowed. Once the plan budget is spent later steps get no entry and toolResultsTruncated counts them. Executed only; failed and skipped steps are in failedStep/skippedSteps.",
      ),
    toolResultsTruncated: z
      .object({ omittedSteps: z.number().int() })
      .optional()
      .describe(
        "Present only when the plan-wide toolResults budget ran out: omittedSteps is how many completed steps with a payload have no toolResults entry.",
      ),
    sessionHeld: z
      .boolean()
      .optional()
      .describe(
        "Present only on a failed run with holdSessionOnFailure: true when the session and device were kept for recovery, false when they were released (plans with derived label sessions are always released).",
      ),
    code: z
      .string()
      .optional()
      .describe(
        "Present only when a typed refusal failed the plan before it produced a result (e.g. capacity_exhausted from device allocation): its wire code.",
      ),
    retryable: z
      .boolean()
      .optional()
      .describe("With code: whether retrying the same plan can succeed."),
    retryAfterMs: z.number().optional().describe("With code: suggested wait before retrying."),
    nextAction: z.string().optional().describe("With code: what to do instead of retrying."),
    details: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("With code: the refusal's structured details (e.g. limit, booted)."),
  })
  .passthrough();

/**
 * The plan lifecycle decides whether a failed plan keeps its session after this response is
 * finalized, from the same predicate, so the result reports that decision here: a runner must not
 * recover on a session the daemon released (#11091). Only a failed run that asked to hold carries it.
 */
export const withReportedSessionHold = (
  result: ExecutePlanResult,
  params: { holdSessionOnFailure?: boolean; sessionUuid?: string },
): ExecutePlanResult =>
  params.holdSessionOnFailure === true && !result.success && params.sessionUuid
    ? {
        ...result,
        sessionHeld: failedPlanSessionHoldable(planLifecycleSessionUuid(params.sessionUuid)),
      }
    : result;

const executePlanTool = async (
  device: BootedDevice,
  params: {
    planContent: string;
    startStep: number;
    platform: Platform;
    sessionUuid?: string;
    keepScreenAwake?: boolean;
    deviceId?: string;
    device?: string;
    devices?: string[];
    deviceAllocationTimeoutMs: number;
    abortStrategy?: "immediate" | "finish-current-step";
    testMetadata?: PlanExecutionRequest["testMetadata"];
    cleanupAppId?: string;
    cleanupClearAppData?: boolean;
    holdSessionOnFailure?: boolean;
    captureObserveSteps?: "summary" | "full";
  },
  progress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<any> => {
  // As an MCP task (#13088) the plan outlives its request: hold the base session it names and
  // the session it was routed to until the task settles. A multi-device plan's label sessions
  // are held once allocated (registerDeviceLabelMap).
  holdTaskDeviceLeases([params.sessionUuid, getToolSelectionContext()?.routingSessionUuid]);
  const orchestrator = new PlanExecutionOrchestrator({
    device,
    request: params,
    progress,
    signal,
  });
  // These fields come from the enclosing MCP call, never from step params.
  // Preserve the live registry key rather than freezing its current deadline.
  const internalParams = params as Record<string, unknown>;
  const result = await runWithToolSelectionContext(
    {
      // #11469: steps run for the connection that called executePlan.
      ...planCallerContext(internalParams),
      planRequest: {
        deadlineMs: internalParams[INTERNAL_MCP_REQUEST_DEADLINE_PARAM],
        timeoutMs: internalParams[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM],
        startTime: internalParams[INTERNAL_EXECUTION_START_TIME_PARAM],
        liveDeadlineKey: internalParams[INTERNAL_LIVE_DEADLINE_KEY_PARAM],
        progress,
      },
    },
    () => orchestrator.execute(),
  );
  const reported = withReportedSessionHold(result, params);
  return withIsErrorOnFailure(createStructuredToolResponse(reported), reported.success);
};

// Register plan tools for daemon-backed MCP servers and CLI usage.
export const registerPlanTools = () => {
  ToolRegistry.registerDeviceAware(
    "executePlan",
    "Execute YAML plan steps; stops on first failed step.",
    executePlanSchema,
    {
      handler: executePlanTool,
      defaultEnabled: false,
      supportsProgress: true,
      outputSchema: executePlanResultSchema,
    },
  );

  registerDeviceGestureRecordingTools();

  registerToolCallRecordingTools();
};

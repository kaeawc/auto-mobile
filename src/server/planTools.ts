import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { Platform } from "../models";
import { addSessionUuidToSchema, DEVICE_LABEL_DESCRIPTION } from "./toolSchemaHelpers";
import {
  startTestRecording,
  stopTestRecording,
  getTestRecordingStatus,
} from "./testRecordingManager";
import { startMcpRecording, stopMcpRecording, getMcpRecordingStatus } from "./mcpRecordingManager";
import { serverConfig } from "../utils/ServerConfig";
import { PlanExecutionOrchestrator, PlanExecutionRequest } from "./planExecutionOrchestrator";
import { runWithToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import {
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
} from "../daemon/constants";

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
  })
  .passthrough();

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
    captureObserveSteps?: "summary" | "full";
  },
  progress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<any> => {
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
  return withIsErrorOnFailure(createStructuredToolResponse(result), result.success);
};

// Start test recording tool schema (empty - uses active device)
const startTestRecordingSchema = addSessionUuidToSchema(z.object({}).strict());

const startTestRecordingResultSchema = z.object({
  success: z.boolean(),
  recordingId: z.string().optional(),
  startedAt: z.string().optional(),
  deviceId: z.string().optional(),
  platform: z.string().optional(),
  error: z.string().optional(),
});

// Start test recording tool handler
const startTestRecordingTool = async (device: BootedDevice): Promise<any> => {
  try {
    const result = await startTestRecording(device);

    return createStructuredToolResponse({
      success: true,
      recordingId: result.recordingId,
      startedAt: result.startedAt,
      deviceId: result.deviceId,
      platform: result.platform,
    });
  } catch (error) {
    logger.error(`[startTestRecording] Failed to start recording: ${error}`);
    return createStructuredToolResponse({
      success: false,
      error: errorMessage(error),
    });
  }
};

// Export plan tool schema
const exportPlanSchema = addSessionUuidToSchema(
  z
    .object({
      recordingId: z.string().optional().describe("Recording ID"),
      planName: z.string().optional().describe("Plan name"),
    })
    .strict(),
);

const exportPlanResultSchema = z.object({
  success: z.boolean(),
  recordingId: z.string().optional(),
  planName: z.string().optional(),
  planContent: z.string().optional(),
  stepCount: z.number().int().optional(),
  durationMs: z.number().int().optional(),
  error: z.string().optional(),
});

// Export plan tool handler
const exportPlanTool = async (params: {
  recordingId?: string;
  planName?: string;
}): Promise<any> => {
  try {
    // Check if there's an active recording
    const status = getTestRecordingStatus();
    if (!status) {
      return withIsErrorOnFailure(
        createStructuredToolResponse({
          success: false,
          error: "No active recording. Start a recording before exporting.",
        }),
        false,
      );
    }

    // Validate recording ID if provided
    if (params.recordingId && params.recordingId !== status.recordingId) {
      return withIsErrorOnFailure(
        createStructuredToolResponse({
          success: false,
          error: `Recording ID ${params.recordingId} does not match active recording ${status.recordingId}.`,
        }),
        false,
      );
    }

    // Stop the recording and get the plan
    const result = await stopTestRecording(params.recordingId, params.planName);

    return createStructuredToolResponse({
      success: true,
      recordingId: result.recordingId,
      planName: result.planName,
      planContent: result.planContent,
      stepCount: result.stepCount,
      durationMs: result.durationMs,
      ...(result.error ? { error: result.error } : {}),
    });
  } catch (error) {
    logger.error(`[exportPlan] Failed to export plan: ${error}`);
    return withIsErrorOnFailure(
      createStructuredToolResponse({
        success: false,
        error: errorMessage(error),
      }),
      false,
    );
  }
};

// ============================================================================
// MCP Call Recording — "recordSteps" tool
// begin/end are gated by the "mcp-recording" feature flag.
// status bypasses the flag so agents can always probe recording state
// (e.g., after context compaction when the agent may have lost awareness).
// ============================================================================

const recordStepsSchema = addSessionUuidToSchema(
  z
    .object({
      action: z.enum(["begin", "end", "status"]),
      planName: z.string().optional().describe("Plan name for action=end"),
    })
    .strict(),
);

const recordStepsResultSchema = z.object({
  success: z.boolean(),
  action: z.enum(["begin", "end", "status"]).optional(),
  recording: z.boolean().optional(),
  startedAt: z.string().optional(),
  alreadyActive: z.boolean().optional(),
  currentStepCount: z.number().optional(),
  planName: z.string().optional(),
  planContent: z.string().optional(),
  stepCount: z.number().optional(),
  durationMs: z.number().optional(),
  warnings: z
    .array(z.string())
    .optional()
    .describe(
      "action=end only, present when non-empty: calls that were skipped (host-file sourcePath, oversized param) or recorded in a weakened form (resetKeychain with confirm:false), each with the reason",
    ),
  error: z.string().optional(),
});

const recordStepsTool = async (params: {
  action: "begin" | "end" | "status";
  planName?: string;
  [INTERNAL_MCP_SESSION_PARAM]?: string;
}): Promise<any> => {
  const connectionId = params[INTERNAL_MCP_SESSION_PARAM];
  // Status is always allowed — lets agents probe recording state even when the flag is off.
  if (params.action === "status") {
    const status = getMcpRecordingStatus({ connectionId });
    return createStructuredToolResponse({
      success: true,
      action: "status",
      recording: status?.recording ?? false,
      ...(status && {
        startedAt: status.startedAt,
        stepCount: status.stepCount,
        durationMs: status.durationMs,
      }),
    });
  }

  if (!serverConfig.isMcpRecordingEnabled()) {
    return withIsErrorOnFailure(
      createStructuredToolResponse({
        success: false,
        error: "MCP recording is disabled. Enable the 'mcp-recording' feature flag first.",
      }),
      false,
    );
  }

  try {
    if (params.action === "begin") {
      const result = startMcpRecording({ connectionId });
      return createStructuredToolResponse({
        success: true,
        action: "begin",
        recording: result.recording,
        startedAt: result.startedAt,
        ...(result.alreadyActive && {
          alreadyActive: true,
          currentStepCount: result.currentStepCount,
        }),
      });
    }

    const result = stopMcpRecording({ connectionId, planName: params.planName });
    return createStructuredToolResponse({
      success: true,
      action: "end",
      planName: result.planName,
      planContent: result.planContent,
      stepCount: result.stepCount,
      durationMs: result.durationMs,
      ...(result.warnings.length > 0 && { warnings: result.warnings }),
    });
  } catch (error) {
    logger.error(`[recordSteps] Failed: ${errorMessage(error)}`);
    return withIsErrorOnFailure(
      createStructuredToolResponse({
        success: false,
        action: params.action,
        error: errorMessage(error),
      }),
      false,
    );
  }
};

// Register plan tools for daemon-backed MCP servers and CLI usage.
export const registerPlanTools = () => {
  ToolRegistry.registerDeviceAware(
    "executePlan",
    "Execute YAML plan steps; stops on first failed step.",
    executePlanSchema,
    executePlanTool,
    { defaultEnabled: false, supportsProgress: true, outputSchema: executePlanResultSchema },
  );

  ToolRegistry.registerDeviceAware(
    "startTestRecording",
    "Start recording user interactions for exportPlan.",
    startTestRecordingSchema,
    startTestRecordingTool,
    { defaultEnabled: false, outputSchema: startTestRecordingResultSchema },
  );

  ToolRegistry.register(
    "exportPlan",
    "Stop active recording and export a YAML plan.",
    exportPlanSchema,
    exportPlanTool,
    { defaultEnabled: false, outputSchema: exportPlanResultSchema },
  );

  // MCP call recording — begin/end gated by "mcp-recording" feature flag; status always available.
  ToolRegistry.register(
    "recordSteps",
    "Record MCP tool calls to YAML. begin/end require mcp-recording; status always works.",
    recordStepsSchema,
    recordStepsTool,
    { defaultEnabled: false, outputSchema: recordStepsResultSchema },
  );
};

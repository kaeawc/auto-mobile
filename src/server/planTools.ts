import { z } from "zod";
import { ToolRegistry, ProgressCallback } from "./toolRegistry";
import { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { Platform } from "../models";
import { DEVICE_LABEL_DESCRIPTION } from "./toolSchemaHelpers";
import { startTestRecording, stopTestRecording, getTestRecordingStatus } from "./testRecordingManager";
import { startMcpRecording, stopMcpRecording, getMcpRecordingStatus } from "./mcpRecordingManager";
import { serverConfig } from "../utils/ServerConfig";
import { PlanExecutionOrchestrator, PlanExecutionRequest } from "./planExecutionOrchestrator";

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
const executePlanSchema = z.object({
  planContent: z.string().describe("YAML plan content"),
  startStep: z.number().default(0).describe("Start step index (0-based, default: 0)"),
  platform: z.enum(["android", "ios"]).describe("Target platform"),
  sessionUuid: z.string().optional().describe("Session UUID for parallel execution"),
  keepScreenAwake: z.boolean().optional().describe("Keep device awake"),
  deviceId: z.string().optional().describe("Device ID"),
  device: z.string().optional().describe(DEVICE_LABEL_DESCRIPTION),
  devices: z.array(z.string()).optional().describe("Device labels for multi-device plans"),
  deviceAllocationTimeoutMs: z.number().default(300000).describe("Timeout in milliseconds for allocating all devices (default: 300000 = 5 minutes)"),
  abortStrategy: z.enum(["immediate", "finish-current-step"]).default("immediate").describe("Abort strategy: immediate (default) or finish-current-step"),
  testMetadata: testMetadataSchema.optional().describe("Test metadata for timing history"),
  cleanupAppId: z.string().optional().describe("App ID to terminate after execution"),
  cleanupClearAppData: z.boolean().optional().describe("Clear app data on cleanup"),
  captureObserveSteps: z
    .enum(["summary", "full"])
    .optional()
    .describe(
      "Single-device plans only: attach each successful observe step snapshot to executePlan result `debug.steps[n].details.stepObservation` " +
        "(`summary` = metadata + element samples; `full` = includes viewHierarchy). Ignored for multi-device plans."
    )
});

const executePlanDebugStepSchema = z.object({
  step: z.string(),
  status: z.enum(["completed", "failed", "skipped"]),
  durationMs: z.number().int(),
  details: z.any().optional()
});

const executePlanDebugSchema = z.object({
  executionTimeMs: z.number().int(),
  steps: z.array(executePlanDebugStepSchema),
  deviceState: z.object({
    currentActivity: z.string().optional(),
    focusedWindow: z.string().optional()
  }).optional()
});

const executePlanResultSchema = z.object({
  success: z.boolean(),
  executedSteps: z.number().int(),
  totalSteps: z.number().int(),
  failedStep: z.object({
    stepIndex: z.number().int(),
    tool: z.string(),
    error: z.string(),
    device: z.string().optional(),
    failureObservation: z.any().optional()
  }).optional(),
  error: z.string().optional(),
  platform: z.enum(["android", "ios"]).describe("Target platform").optional(),
  deviceId: z.string().optional(),
  deviceMapping: z.record(z.string(), z.string()).optional(),
  debug: executePlanDebugSchema.optional()
}).passthrough();


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
  signal?: AbortSignal
): Promise<any> => {
  const orchestrator = new PlanExecutionOrchestrator({
    device,
    request: params,
    progress,
    signal,
  });
  const result = await orchestrator.execute();
  return createStructuredToolResponse(result);
};


// Start test recording tool schema (empty - uses active device)
const startTestRecordingSchema = z.object({});

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
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Export plan tool schema
const exportPlanSchema = z.object({
  recordingId: z.string().optional().describe("Recording ID to export (uses active recording if not specified)"),
  planName: z.string().optional().describe("Name for the exported plan (auto-generated if not specified)"),
});

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
      return createStructuredToolResponse({
        success: false,
        error: "No active recording. Start a recording before exporting.",
      });
    }

    // Validate recording ID if provided
    if (params.recordingId && params.recordingId !== status.recordingId) {
      return createStructuredToolResponse({
        success: false,
        error: `Recording ID ${params.recordingId} does not match active recording ${status.recordingId}.`,
      });
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
    });
  } catch (error) {
    logger.error(`[exportPlan] Failed to export plan: ${error}`);
    return createStructuredToolResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// ============================================================================
// MCP Call Recording — "recordSteps" tool
// begin/end are gated by the "mcp-recording" feature flag.
// status bypasses the flag so agents can always probe recording state
// (e.g., after context compaction when the agent may have lost awareness).
// ============================================================================

const recordStepsSchema = z.object({
  action: z.enum(["begin", "end", "status"]).describe("begin: start capturing tool calls. end: stop and export the recorded plan as YAML. status: check if a recording session is active."),
  planName: z.string().optional().describe("Name for the exported plan (kebab-case recommended, auto-generated if not specified). Only used with action 'end'."),
});

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
  error: z.string().optional(),
});

const recordStepsTool = async (params: { action: "begin" | "end" | "status"; planName?: string }): Promise<any> => {
  // Status is always allowed — lets agents probe recording state even when the flag is off.
  if (params.action === "status") {
    const status = getMcpRecordingStatus();
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
    return createStructuredToolResponse({
      success: false,
      error: "MCP recording is disabled. Enable the 'mcp-recording' feature flag first.",
    });
  }

  try {
    if (params.action === "begin") {
      const result = startMcpRecording();
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

    const result = stopMcpRecording(params.planName);
    return createStructuredToolResponse({
      success: true,
      action: "end",
      planName: result.planName,
      planContent: result.planContent,
      stepCount: result.stepCount,
      durationMs: result.durationMs,
    });
  } catch (error) {
    logger.error(`[recordSteps] Failed: ${error instanceof Error ? error.message : String(error)}`);
    return createStructuredToolResponse({
      success: false,
      action: params.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Register plan tools for daemon-backed MCP servers and CLI usage.
export const registerPlanTools = () => {
  ToolRegistry.registerDeviceAware(
    "executePlan",
    "Execute a series of tool calls from a YAML plan content. Stops execution if any step fails (success: false). Optionally can resume execution from a specific step index.",
    executePlanSchema,
    executePlanTool,
    true,
    false,
    { outputSchema: executePlanResultSchema }
  );

  ToolRegistry.registerDeviceAware(
    "startTestRecording",
    "Start test recording mode on the active device. Records user interactions for later export as a test plan. Returns the session ID which can be used with exportPlan.",
    startTestRecordingSchema,
    startTestRecordingTool,
    false,
    false,
    { outputSchema: startTestRecordingResultSchema }
  );

  ToolRegistry.register(
    "exportPlan",
    "Stop the active test recording and export recorded interactions as a YAML plan. Returns the plan content.",
    exportPlanSchema,
    exportPlanTool,
    false,
    false,
    exportPlanResultSchema
  );

  // MCP call recording — begin/end gated by "mcp-recording" feature flag; status always available.
  ToolRegistry.register(
    "recordSteps",
    "Record MCP tool calls as a replayable YAML test plan. Actions: 'begin' starts capturing plan-relevant tool calls, 'end' stops and exports the plan as YAML (both require the 'mcp-recording' feature flag), 'status' checks if a recording session is active (always available, even when the flag is off).",
    recordStepsSchema,
    recordStepsTool,
    false,
    false,
    recordStepsResultSchema
  );
};

import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { logger } from "../utils/logger";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { addSessionUuidToSchema } from "../utils/schemaHelpers";
import {
  startToolCallRecording,
  stopToolCallRecording,
  getToolCallRecordingStatus,
} from "../daemon/toolCallRecordingManager";
import { serverConfig } from "../utils/ServerConfig";
import { featureFlagDisabledMessage } from "../features/featureFlags/featureFlagDisabledMessage";
import { currentAutolockMcpSessionId } from "../features/toolSelection/toolSelectionContext";

// ============================================================================
// Tool Call Recording — "recordToolCalls" tool
// begin/end are gated by the "tool-call-recording" feature flag, which is on by
// default so an MCP-only client can record once it enables the tool (#16891).
// status bypasses the flag so agents can always probe recording state
// (e.g., after context compaction when the agent may have lost awareness).
// ============================================================================

export const TOOL_CALL_RECORDING_DISABLED_ERROR = featureFlagDisabledMessage(
  "tool-call-recording",
  "recordToolCalls",
);

const recordToolCallsSchema = addSessionUuidToSchema(
  z
    .object({
      action: z
        .enum(["begin", "end", "status"])
        .describe(
          "begin starts recording this connection's tool calls; end stops and returns the YAML plan; status reports state",
        ),
      planName: z
        .string()
        .optional()
        .describe(
          "Plan name: on begin, the exported plan's name; on end, overrides the begin name",
        ),
    })
    .strict(),
);

const recordToolCallsResultSchema = z.object({
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
  platform: z
    .enum(["android", "ios", "tvos", "visionos", "watchos"])
    .optional()
    .describe("action=end only: the platform written at the top of the plan"),
  platformNote: z
    .string()
    .optional()
    .describe(
      "action=end only: why the plan has no top-level platform (recorded calls on mixed or unknown platforms)",
    ),
  error: z.string().optional(),
});

type RecordingConnectionId = ReturnType<typeof currentAutolockMcpSessionId>;

const recordingStatusResponse = (connectionId: RecordingConnectionId) => {
  const status = getToolCallRecordingStatus({ connectionId });
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
};

const recordingBeginResponse = (connectionId: RecordingConnectionId, planName?: string) => {
  const result = startToolCallRecording({ connectionId, planName });
  return createStructuredToolResponse({
    success: true,
    action: "begin",
    recording: result.recording,
    startedAt: result.startedAt,
    ...(result.planName && { planName: result.planName }),
    ...(result.alreadyActive && {
      alreadyActive: true,
      currentStepCount: result.currentStepCount,
    }),
  });
};

const recordingEndResponse = (connectionId: RecordingConnectionId, planName?: string) => {
  const result = stopToolCallRecording({ connectionId, planName });
  return createStructuredToolResponse({
    success: true,
    action: "end",
    planName: result.planName,
    planContent: result.planContent,
    stepCount: result.stepCount,
    durationMs: result.durationMs,
    ...(result.warnings.length > 0 && { warnings: result.warnings }),
    ...(result.platform && { platform: result.platform }),
    ...(result.platformNote && { platformNote: result.platformNote }),
  });
};

const recordToolCallsTool = async (params: {
  action: "begin" | "end" | "status";
  planName?: string;
}): Promise<any> => {
  const connectionId = currentAutolockMcpSessionId();
  // Status is always allowed — lets agents probe recording state even when the flag is off.
  if (params.action === "status") {
    return recordingStatusResponse(connectionId);
  }

  if (!serverConfig.isToolCallRecordingEnabled()) {
    return withIsErrorOnFailure(
      createStructuredToolResponse({
        success: false,
        error: TOOL_CALL_RECORDING_DISABLED_ERROR,
      }),
      false,
    );
  }

  try {
    if (params.action === "begin") {
      return recordingBeginResponse(connectionId, params.planName);
    }
    return recordingEndResponse(connectionId, params.planName);
  } catch (error) {
    logger.error(`[recordToolCalls] Failed: ${errorMessage(error)}`);
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

export const registerToolCallRecordingTools = () => {
  // tool call recording — begin/end gated by "tool-call-recording" feature flag; status always available.
  ToolRegistry.register(
    "recordToolCalls",
    "Record MCP tool calls to a YAML plan: action begin, end (returns the plan; exportPlan also ends it), or status.",
    recordToolCallsSchema,
    {
      handler: recordToolCallsTool,
      defaultEnabled: false,
      outputSchema: recordToolCallsResultSchema,
      // `status` only reports the recording; begin/end change it (#11107).
      readOnly: (args: { action?: unknown }) => args?.action === "status",
    },
  );
};

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
import { INTERNAL_MCP_SESSION_PARAM } from "../daemon/wire/constants";

// ============================================================================
// Tool Call Recording — "recordToolCalls" tool
// begin/end are gated by the "tool-call-recording" feature flag.
// status bypasses the flag so agents can always probe recording state
// (e.g., after context compaction when the agent may have lost awareness).
// ============================================================================

const recordToolCallsSchema = addSessionUuidToSchema(
  z
    .object({
      action: z.enum(["begin", "end", "status"]),
      planName: z.string().optional().describe("Plan name for action=end"),
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
  error: z.string().optional(),
});

const recordToolCallsTool = async (params: {
  action: "begin" | "end" | "status";
  planName?: string;
  [INTERNAL_MCP_SESSION_PARAM]?: string;
}): Promise<any> => {
  const connectionId = params[INTERNAL_MCP_SESSION_PARAM];
  // Status is always allowed — lets agents probe recording state even when the flag is off.
  if (params.action === "status") {
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
  }

  if (!serverConfig.isToolCallRecordingEnabled()) {
    return withIsErrorOnFailure(
      createStructuredToolResponse({
        success: false,
        error:
          "Tool call recording is disabled. Enable the 'tool-call-recording' feature flag first.",
      }),
      false,
    );
  }

  try {
    if (params.action === "begin") {
      const result = startToolCallRecording({ connectionId });
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

    const result = stopToolCallRecording({ connectionId, planName: params.planName });
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
    "Record MCP tool calls to YAML. begin/end require tool-call-recording; status always works.",
    recordToolCallsSchema,
    recordToolCallsTool,
    {
      defaultEnabled: false,
      outputSchema: recordToolCallsResultSchema,
      // `status` only reports the recording; begin/end change it (#11107).
      readOnly: (args: { action?: unknown }) => args?.action === "status",
    },
  );
};

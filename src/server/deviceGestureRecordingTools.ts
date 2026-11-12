import { errorMessage } from "../utils/describeUnknownError";
import { z } from "zod/v4";
import { ToolRegistry } from "./toolRegistry";
import { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import { createStructuredToolResponse, withIsErrorOnFailure } from "../utils/toolUtils";
import { addSessionUuidToSchema, resourceLinkField } from "../utils/schemaHelpers";
import {
  startDeviceGestureRecording,
  getStoppedDeviceGestureRecording,
  joinInFlightDeviceGestureRecordingStop,
  stopDeviceGestureRecording,
  getDeviceGestureRecordingStatus,
  type DeviceGestureRecordingStatus,
  NoUserInputCapturedError,
} from "../daemon/deviceGestureRecordingManager";
import {
  assertLifecycleCallerHoldsDevice,
  assertLifecycleCallerNotOnForeignBinding,
} from "./lifecycleDeviceOwnership";
import {
  lifecycleRequester,
  type LifecycleRequester,
} from "../features/deviceLifecycle/lifecycleRequester";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { InputDeviceOwnedError } from "../daemon/inputDeviceOwnership";
import { assertDeviceGestureRecordingStartHeldDevice } from "../daemon/deviceGestureRecordingStartAdmission";
import {
  currentAutolockMcpSessionId,
  getToolSelectionContext,
} from "../features/toolSelection/toolSelectionContext";
import { getToolCallRecorder, stopToolCallRecording } from "../daemon/toolCallRecordingManager";
import { serverConfig } from "../utils/ServerConfig";
import {
  planExportFormatField,
  xcTestScaffoldField,
  xcTestScaffoldSchema,
  type PlanExportFormat,
} from "../features/record/swiftTestScaffold";

// Start device gesture recording tool schema (empty - uses active device)
const recordDeviceGesturesSchema = addSessionUuidToSchema(z.object({}).strict());

const recordDeviceGesturesResultSchema = z.object({
  success: z.boolean(),
  recordingId: z.string().optional(),
  startedAt: z.string().optional(),
  deviceId: z.string().optional(),
  platform: z.string().optional(),
  error: z.string().optional(),
});

// Start device gesture recording tool handler
const recordDeviceGesturesTool = async (
  device: BootedDevice,
  params?: { sessionUuid?: string },
): Promise<any> => {
  try {
    // The owning session is recorded so releasing it stops the recording instead of leaving it
    // to capture the device's next owner.
    const result = await startDeviceGestureRecording(device, undefined, undefined, {
      ownerSessionUuid: params?.sessionUuid,
    });

    return createStructuredToolResponse({
      success: true,
      recordingId: result.recordingId,
      startedAt: result.startedAt,
      deviceId: result.deviceId,
      platform: result.platform,
    });
  } catch (error) {
    logger.error(`[recordDeviceGestures] Failed to start recording: ${error}`);
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
      recordingId: z
        .string()
        .optional()
        .describe(
          "recordDeviceGestures recordingId; defaults to the active recording. Omit it to end this connection's recordToolCalls recording",
        ),
      planName: z.string().optional().describe("Plan name"),
      format: planExportFormatField(),
      resourceLink: resourceLinkField(),
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
  warnings: z
    .array(z.string())
    .optional()
    .describe(
      "recordToolCalls recordings only, present when non-empty: calls skipped or recorded in a weakened form",
    ),
  xctest: xcTestScaffoldSchema,
  error: z.string().optional(),
  reason: z.string().optional(),
});

const NO_ACTIVE_RECORDING_ERROR =
  "No active recording on this MCP connection. Start one with recordDeviceGestures or " +
  'recordToolCalls action: "begin" before exporting.';

/**
 * Ends this connection's recordToolCalls recording, as `recordToolCalls end` does, so exportPlan
 * exports either recorder (#17950). A recordingId names a device gesture recording, so a call
 * that passes one never ends tool calls; with no recording to export it is the no-recording error.
 */
function exportToolCallRecording(params: {
  recordingId?: string;
  planName?: string;
  format?: PlanExportFormat;
}) {
  const connectionId = currentAutolockMcpSessionId();
  if (
    params.recordingId ||
    !serverConfig.isToolCallRecordingEnabled() ||
    !getToolCallRecorder({ connectionId })
  ) {
    return withIsErrorOnFailure(
      createStructuredToolResponse({ success: false, error: NO_ACTIVE_RECORDING_ERROR }),
      false,
    );
  }
  const result = stopToolCallRecording({ connectionId, planName: params.planName });
  return createStructuredToolResponse({
    success: true,
    planName: result.planName,
    planContent: result.planContent,
    stepCount: result.stepCount,
    durationMs: result.durationMs,
    ...(result.warnings.length > 0 && { warnings: result.warnings }),
    ...xcTestScaffoldField(params.format, result.planName),
  });
}

/**
 * exportPlan stops the daemon's one live device gesture recording, so it is a control call on that
 * recording's device (#11647). It is a plain tool: device-aware ownership never sees it and the
 * ingress only judges a session the call names. The handler therefore asks the question the
 * device-gesture-recording socket's `stop` asks, in the shape killDevice uses: a device a live session holds
 * is exported only by its holder, and a broker binding's device only by that binding's execution.
 * An unheld device's recording (owned or not) stays exportable by anyone, as on the socket.
 *
 * Returns the recording to stop. The holder check runs after this function's last await, against
 * the recording it returns; the caller stops that recording by id. Throws the typed
 * `device_owned_by_other_session` / `device_assigned_to_binding` refusal, which the caller
 * must not swallow.
 */
async function activeRecordingForExport(
  params: object,
): Promise<DeviceGestureRecordingStatus | null> {
  const seen = getDeviceGestureRecordingStatus();
  if (!seen) {
    return null;
  }
  const requester = exportRequester(params, seen.deviceId);
  await assertLifecycleCallerNotOnForeignBinding({
    toolName: "exportPlan",
    device: seen,
    requester,
  });
  const status = getDeviceGestureRecordingStatus();
  if (!status) {
    return null;
  }
  const holder = exportRequester(params, status.deviceId);
  try {
    assertLifecycleCallerHoldsDevice({
      toolName: "exportPlan",
      device: status,
      requester: holder,
      // A recording has no forced stop: only the holder exports it.
      force: false,
    });
  } catch (error) {
    if (error instanceof InputDeviceOwnedError) {
      // Same typed refusal, without the lifecycle remedy's offer of `force`.
      throw new InputDeviceOwnedError("exportPlan", error.deviceId, holder.sessionUuid, {
        remedy: EXPORT_PLAN_REMEDY,
      });
    }
    throw error;
  }
  return status;
}

const EXPORT_PLAN_REMEDY =
  "call exportPlan with the holding session's sessionUuid, or wait for the holder to release the device.";

/**
 * Who is exporting. The connection that acquired the session holding the recording's device is
 * that session, whether the call named it, another of its sessions, or none (as a deviceId-only
 * device call is, #10994).
 */
function exportRequester(params: object, deviceId: string): LifecycleRequester {
  const requester = lifecycleRequester(params);
  const mcpSessionId = requester.mcpSessionId ?? getToolSelectionContext()?.callerMcpSessionId;
  const held = mcpSessionId
    ? defaultDaemonContext
        .devicePool()
        ?.resolveOwnedDeviceSessionForMcpSession(mcpSessionId, deviceId)
    : undefined;
  return held ? { ...requester, sessionUuid: held } : requester;
}

function exportedDeviceGestureRecordingResponse(
  result: Awaited<ReturnType<typeof stopDeviceGestureRecording>>,
  format: PlanExportFormat | undefined,
) {
  return createStructuredToolResponse({
    success: true,
    recordingId: result.recordingId,
    planName: result.planName,
    planContent: result.planContent,
    stepCount: result.stepCount,
    durationMs: result.durationMs,
    ...xcTestScaffoldField(format, result.planName),
    ...(result.error ? { error: result.error } : {}),
  });
}

// Export plan tool handler
const exportPlanTool = async (params: {
  recordingId?: string;
  planName?: string;
  format?: PlanExportFormat;
  sessionUuid?: string;
}): Promise<any> => {
  const failedResponse = (error: unknown) =>
    withIsErrorOnFailure(
      createStructuredToolResponse({
        success: false,
        error: errorMessage(error),
        ...(error instanceof NoUserInputCapturedError ? { reason: error.reason } : {}),
      }),
      false,
    );
  // An announced id may still be finalizing after its owner's session ended.
  try {
    if (params.recordingId) {
      const joined = await joinInFlightDeviceGestureRecordingStop(
        params.recordingId,
        params.sessionUuid,
      );
      if (joined) {
        return exportedDeviceGestureRecordingResponse(joined, params.format);
      }
    }
  } catch (error) {
    logger.error(`[exportPlan] Failed to join recording stop: ${errorMessage(error)}`, error);
    return failedResponse(error);
  }
  // Outside the try: a holder refusal reaches the client typed, never as a generic failure.
  const status = await activeRecordingForExport(params);
  try {
    // After a release-time stop the owner fetches the retained plan by id (#10958).
    const retained =
      !status && params.recordingId
        ? getStoppedDeviceGestureRecording(params.recordingId, params.sessionUuid)
        : undefined;
    if (retained) {
      return exportedDeviceGestureRecordingResponse(retained, params.format);
    }
    if (!status) {
      return exportToolCallRecording(params);
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

    // Stop the recording the holder check judged, and get the plan
    const result = await stopDeviceGestureRecording(status.recordingId, params.planName);

    return exportedDeviceGestureRecordingResponse(result, params.format);
  } catch (error) {
    logger.error(`[exportPlan] Failed to export plan: ${error}`);
    return failedResponse(error);
  }
};

export const registerDeviceGestureRecordingTools = () => {
  ToolRegistry.registerDeviceAware(
    "recordDeviceGestures",
    "Start recording on-device user input (not tool calls) for exportPlan.",
    recordDeviceGesturesSchema,
    {
      handler: recordDeviceGesturesTool,
      defaultEnabled: false,
      outputSchema: recordDeviceGesturesResultSchema,
      assertHeldDeviceStart: assertDeviceGestureRecordingStartHeldDevice,
    },
  );

  ToolRegistry.register(
    "exportPlan",
    "Stop the active recordDeviceGestures or recordToolCalls recording and export a YAML plan.",
    exportPlanSchema,
    {
      handler: exportPlanTool,
      defaultEnabled: false,
      outputSchema: exportPlanResultSchema,
    },
  );
};

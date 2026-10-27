import { defaultDaemonContext, type DevicePoolReads } from "../../../daemon/daemonContext";
import { daemonShuttingDownMcpOutcome } from "../../../daemon/daemonShutdownOutcome";
import { SessionReleasedDuringCreationError } from "../../../models/deviceAcquisitionRefusals";
import {
  DaemonSessionCreationRejectedError,
  TerminalSessionError,
  type SessionManager,
} from "../../../daemon/sessionManager";
import type { TextRequestState } from "../../../features/action/textTransportTimeout";
import { defaultTimer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import {
  deviceLossOutcomeFromError,
  deviceLostErrorFromAbortSignal,
  enrichDeviceLossOutcome,
  enrichDeviceLossOutcomeFromSession,
  remainingDeviceLossIncidentWaitMs,
  type DeviceLossOutcome,
} from "../../../utils/deviceLossOutcome";
import {
  sessionOwnershipLostPayload,
  sessionReleasedDuringCallPayload,
} from "../../../daemon/deviceSessionResult";
import { executionTracker } from "../../../daemon/executionTracker";
import { forwardingLeaseConflictCause } from "../../forwardingLeaseConflictOutcome";
import { shapeToolCallError } from "../../../daemon/shapeToolCallError";
import {
  stripToolResultStructuredContent,
  structuredContentOmissionReason,
} from "../../stripToolResultStructuredContent";
import type { McpToolCallResult } from "../../toolCallDispatch";
import { toolHasOutputSchema, type RegisteredTool } from "../../toolRegistry";

export interface DeviceLossDaemonContext {
  devicePool(): Pick<DevicePoolReads, "waitForEmulatorLossIncident"> | undefined;
  sessionManager(): Pick<SessionManager, "peekSession"> | undefined;
}

export async function resolveDeviceLossOutcome(
  deviceLoss: DeviceLossOutcome,
  timeoutMs?: number,
  daemon: DeviceLossDaemonContext = defaultDaemonContext,
): Promise<DeviceLossOutcome> {
  let outcome = deviceLoss;
  try {
    const devicePool = deviceLoss.incidentId ? daemon.devicePool() : undefined;
    if (deviceLoss.incidentId && devicePool) {
      const incident = await devicePool.waitForEmulatorLossIncident(
        deviceLoss.incidentId,
        timeoutMs,
      );
      outcome = enrichDeviceLossOutcome(deviceLoss, incident);
    }
  } catch (incidentError) {
    logger.warn(
      `[MCP] Failed to resolve device-loss incident ${deviceLoss.incidentId}`,
      incidentError,
    );
  }
  try {
    const session = outcome.sessionUuid
      ? daemon.sessionManager()?.peekSession(outcome.sessionUuid)
      : undefined;
    return enrichDeviceLossOutcomeFromSession(outcome, session);
  } catch (error) {
    logger.warn("[MCP] Failed to read session for device-loss continuity", error);
    return outcome;
  }
}

export interface CallFailureContext {
  readonly toolName: string;
  readonly tool: Pick<RegisteredTool, "outputSchema">;
  readonly daemonMode: boolean;
  readonly execution: ReturnType<typeof executionTracker.startExecution>;
  readonly executionSessionUuid: string | undefined;
  readonly requestTimeoutMs: number | undefined;
  readonly toolResultsNoStructuredContent: boolean;
  readonly textState: TextRequestState;
  /** Echo the routed session on a result that used it. */
  readonly withRoutedSession: (result: McpToolCallResult) => McpToolCallResult;
  readonly endExecutionOnce: () => void;
}

function textErrorResult(payload: unknown): McpToolCallResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    isError: true,
  };
}

/**
 * Shape whatever the invoke stage threw into the call's result. Typed
 * terminal outcomes (shutdown, session ownership lost, released mid-call,
 * device loss) keep their dedicated wire payloads; everything else goes
 * through the shared error shaper and still counts as use of an admitted
 * session (#10824).
 */
export async function shapeCallFailure(
  error: unknown,
  ctx: CallFailureContext,
): Promise<McpToolCallResult> {
  const { toolName: name, execution } = ctx;
  if (error instanceof DaemonSessionCreationRejectedError) {
    const shutdown = daemonShuttingDownMcpOutcome();
    const result = {
      content: [{ type: "text" as const, text: JSON.stringify(shutdown) }],
      structuredContent: shutdown,
      isError: true,
    };
    // The private daemon loopback needs this marker to classify the
    // shutdown outcome before it reaches the public proxy boundary.
    return ctx.daemonMode
      ? result
      : stripToolResultStructuredContent(
          result,
          structuredContentOmissionReason(
            toolHasOutputSchema(ctx.tool),
            ctx.toolResultsNoStructuredContent,
          ),
        );
  }
  if (error instanceof TerminalSessionError) {
    return textErrorResult(
      sessionOwnershipLostPayload({
        message: error.message,
        sessionUuid: error.sessionUuid,
        reason: error.release.releaseReason,
        release: error.release,
      }),
    );
  }
  if (error instanceof SessionReleasedDuringCreationError) {
    // Creation never published a session: the admission mark is not session use (#11351).
    executionTracker.unmarkSessionAdmitted(execution.id);
  }
  // The heartbeat monitor released this call's session under it and cancelled the call
  // (#11322): the same terminal refusal a call arriving after the release gets.
  const releasedDuringCall = sessionReleasedDuringCallPayload(execution.cancelReason);
  if (releasedDuringCall) {
    return textErrorResult(releasedDuringCall);
  }
  if (error instanceof SessionReleasedDuringCreationError) {
    return shapeToolCallError(error, { toolName: name, source: "MCP" }) as McpToolCallResult;
  }
  const leaseConflict = forwardingLeaseConflictCause(error, execution.deviceIds);
  if (leaseConflict) {
    // The device is fine; another AutoMobile process kept its CtrlProxy
    // forwarding. Report that instead of a missing hierarchy or device loss (#10485).
    return shapeToolCallError(leaseConflict, {
      toolName: name,
      source: "MCP",
    }) as McpToolCallResult;
  }
  const deviceLoss =
    deviceLossOutcomeFromError(error, ctx.executionSessionUuid) ??
    deviceLossOutcomeFromError(
      deviceLostErrorFromAbortSignal(execution.abortController.signal),
      ctx.executionSessionUuid,
    );
  if (deviceLoss) {
    // Recovery drains cancelled executions before rebooting. This handler's
    // remaining work only enriches the response from that same recovery, so
    // stop tracking it first to avoid making recovery wait on itself.
    ctx.endExecutionOnce();
    const elapsedMs = Math.max(0, defaultTimer.now() - execution.startTime);
    const incidentWaitTimeoutMs = remainingDeviceLossIncidentWaitMs(
      ctx.requestTimeoutMs,
      elapsedMs,
    );
    return textErrorResult(await resolveDeviceLossOutcome(deviceLoss, incidentWaitTimeoutMs));
  }
  // The SDK's request-handler result alias is narrower than its exported
  // CallToolResult type, though this text-only error result satisfies the
  // protocol schema. An admitted call that then failed still used its session (#10824).
  return ctx.withRoutedSession(
    shapeToolCallError(ctx.textState.timeoutError(error) ?? error, {
      toolName: name,
      source: "MCP",
    }) as McpToolCallResult,
  );
}

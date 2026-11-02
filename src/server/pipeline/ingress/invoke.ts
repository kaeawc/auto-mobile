import type { ToolHandlerResult } from "../../toolRegistryTypes";
import {
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_MCP_SESSION_PARAM,
  INTERNAL_ONE_SHOT_CLI_PARAM,
} from "../../../daemon/wire/constants";
import { getSessionToolSelectionService } from "../../../features/toolSelection/SessionToolSelectionService";
import { runWithToolSelectionContext } from "../../../features/toolSelection/toolSelectionContext";
import { runWithTextRequestContext } from "../../../features/action/textTransportTimeout";
import type { TextRequestState } from "../../../features/action/textTransportTimeout";
import { runWithAbortSignal } from "../../../utils/AbortContext";
import { executionTracker, sessionExecutionMetadataOf } from "../../../daemon/executionTracker";
import type { McpServerOptions } from "../../index";
import type { SessionToolBinding } from "../../SessionToolBinding";
import type { ToolCallProgress } from "../../toolCallDispatch";
import type { CallContext } from "./callContext";
import type { ResolvedTool } from "./routing";

type Execution = ReturnType<typeof executionTracker.startExecution>;

/** Everything the invoke stage needs, already resolved by the earlier stages. */
export interface InvocationPlan {
  readonly name: string;
  readonly tool: ResolvedTool;
  readonly toolParams: Record<string, unknown>;
  readonly parsedParams: Record<string, unknown>;
  readonly sessionId: string | undefined;
  readonly bindingKey: string | undefined;
  readonly context: CallContext;
  readonly options: McpServerOptions;
  readonly sessionToolBinding: SessionToolBinding;
  readonly execution: Execution;
  readonly implicitAutolockMcpSessionId: string | undefined;
  readonly routingSessionUuid: string | undefined;
  readonly handlerRoutingSessionUuid: string | undefined;
  readonly routingBaseSessionUuid: string | undefined;
  readonly labelSessionUuids: string[];
  readonly connectionProfileUuid: string | undefined;
  readonly actionsCompactMetadata: boolean;
  readonly providedSessionUuid: string | undefined;
  /** The session the call executes under: a label's session, the named one, or the routed one. */
  readonly executionSessionUuid: string | undefined;
  readonly textState: TextRequestState;
  readonly getRequestDeadlineMs: () => number | undefined;
  readonly requestSignal: AbortSignal | undefined;
  readonly progress: ToolCallProgress | undefined;
}

/**
 * The handler's arguments: the validated parameters plus the call context the
 * handler needs, re-attached under the internal `__*` keys. This is the only
 * place a parsed {@link CallContext} is written back in-band.
 */
export function buildHandlerParams(plan: InvocationPlan): Record<string, unknown> {
  const { parsedParams, context, execution } = plan;
  return {
    ...parsedParams,
    ...(plan.tool.selectsActiveDevice === true && plan.routingSessionUuid
      ? { sessionUuid: plan.routingSessionUuid }
      : {}),
    ...(plan.implicitAutolockMcpSessionId
      ? { [INTERNAL_MCP_SESSION_PARAM]: plan.implicitAutolockMcpSessionId }
      : {}),
    ...(context.requestOneShotCli ? { [INTERNAL_ONE_SHOT_CLI_PARAM]: true } : {}),
    [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
    // Forwarded back onto the handler params (rather than only used locally)
    // so a handler that needs the ACTUAL transport deadline, not a fresh
    // internal budget, can recover it: this value plus `execution.startTime` is
    // the absolute wall-clock deadline of the current request. Only present on
    // a daemon-forwarded call; absent on a direct call, which a handler must
    // treat as "no transport deadline known" (issue #6222 P1; the handler
    // built by `createSetUIStateHandler` is the first consumer).
    ...(context.requestTimeoutMs !== undefined
      ? { [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: context.requestTimeoutMs }
      : {}),
    // The daemon's own capture-time-anchored absolute deadline, when present.
    // Forwarded unchanged so a handler can prefer it over recomputing
    // `execution.startTime + requestTimeoutMs`, which would re-grant whatever
    // time this dispatch/admission step itself consumed (issue #6222 review).
    ...(context.requestDeadlineMs !== undefined
      ? { [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: context.requestDeadlineMs }
      : {}),
    // Same daemon-only provenance as `requestTimeoutMs`: lets the
    // `createSetUIStateHandler` handler resolve the LIVE (possibly progress-extended) deadline via
    // `liveDeadlineRegistry` instead of only this frozen snapshot (issue #6222).
    ...(context.requestLiveDeadlineKey !== undefined
      ? { [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: context.requestLiveDeadlineKey }
      : {}),
    ...(context.requestAcceptanceDiscoveryOrder !== undefined
      ? { [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: context.requestAcceptanceDiscoveryOrder }
      : {}),
  };
}

/** Run the tool handler under the call's selection, text-deadline and abort contexts. */
export async function invokeHandler(plan: InvocationPlan): Promise<ToolHandlerResult> {
  const { name, tool, toolParams, execution, sessionId, sessionToolBinding, options } = plan;
  const handlerParams = buildHandlerParams(plan);
  // `progress` echoes the client's own token and is undefined when the client
  // did not ask for progress (issue #6118); only tools that report progress
  // receive it.
  const progressCallback = tool.supportsProgress ? plan.progress : undefined;
  const runToolHandler = () =>
    runWithToolSelectionContext(
      {
        explicitObserveDeviceRead:
          name === "observe" &&
          Object.hasOwn(toolParams, "deviceId") &&
          !plan.providedSessionUuid &&
          !plan.handlerRoutingSessionUuid,
        // A bound derived session may still target a sibling label. Resolve
        // that label from the base map; unlabeled calls retain the derived
        // ambient session.
        routingSessionUuid: plan.handlerRoutingSessionUuid,
        // #11469: nested internal calls and plan steps run for this daemon connection.
        callerMcpSessionId: plan.context.requestMcpSessionId,
        deviceConnectionKey: plan.bindingKey,
        ownsDeviceSession: (sessionUuid) => sessionToolBinding.ownsSession(sessionId, sessionUuid),
        execution: {
          deviceBinding: {
            bindDeviceExecution: (deviceId) =>
              executionTracker.bindDeviceExecution(execution.id, deviceId),
          },
          ...sessionExecutionMetadataOf(execution),
        },
        // A routing session already carries its own base/label union in
        // ToolRegistry. Carry only a distinct connection profile so it
        // cannot suppress that derived-label resolution.
        toolSelectionProfileUuid: plan.connectionProfileUuid,
        actionsCompactMetadata: plan.actionsCompactMetadata,
        labelSessionUuids: plan.labelSessionUuids,
        routingBaseSessionUuid: plan.routingBaseSessionUuid,
        // Keep profile persistence lazy for ordinary core-tool calls while
        // giving an admitted plan its service instance for release cleanup.
        sessionToolSelectionService:
          options.sessionToolSelectionService ??
          (name === "executePlan" ? getSessionToolSelectionService() : undefined),
      },
      () => tool.handler(handlerParams, progressCallback, plan.requestSignal),
    );
  const result = await runWithTextRequestContext(
    { textState: plan.textState, getDeadlineMs: plan.getRequestDeadlineMs },
    () => runWithAbortSignal(plan.requestSignal, runToolHandler),
  );
  // The registry stores handlers by wire shape (resolving to `unknown`); every registered handler
  // resolves to an MCP tool result, which is what the rest of the pipeline reads.
  return result as ToolHandlerResult;
}

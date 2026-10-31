import { ZodError } from "zod/v4";
import {
  getLiveDeadlineMs,
  getLiveTextRequestState,
  subscribeLiveDeadline,
} from "../../../daemon/liveDeadlineRegistry";
import { defaultDaemonContext } from "../../../daemon/daemonContext";
import {
  DaemonRestartPendingError,
  daemonRestartPendingToolResult,
} from "../../../daemon/daemonRestartPending";
import { TextRequestState } from "../../../features/action/textTransportTimeout";
import { ActionableError } from "../../../models";
import { logger } from "../../../utils/logger";
import { combineRequestAbortSignals } from "../../../utils/AbortContext";
import { stripUndeclaredSessionUuid } from "../../../utils/toolParams";
import { isDeviceInventoryTool } from "../../../daemon/daemonMcpProxy";
import { assertBrokerConnectionPlainToolCall } from "../../brokerConnectionToolGate";
import { holdsOwnerHeartbeatLease } from "../../../daemon/sessionBroker/provisioning/executionLiveness";
import {
  getDeviceSessionIdFromResult,
  isDeviceSessionAcquisitionTool,
} from "../../../daemon/deviceSessionResult";
import { executionTracker, subscribeRequestCancellation } from "../../../daemon/executionTracker";
import {
  isControlCallOnNamedSession,
  refuseControlOnForeignOwnedSession,
} from "../../foreignOwnedSessionRefusal";
import { InvalidToolParamsError } from "../../invalidToolParamsError";
import { stripInternalToolParams } from "../../internalToolParams";
import { PlanExecutionInProgressError } from "../../../daemon/planExecutionInProgressRefusal";
import type { PlanExecutionLock } from "../../PlanExecutionLock";
import { withAdmittedSessionEcho } from "../../routedSessionEcho";
import { withForeignOwnedSessionMeta } from "../../../daemon/routedSessionMeta";
import { isTypedToolRefusal, shapeToolCallError } from "../../../daemon/shapeToolCallError";
import {
  responseCarriesStructuredContent,
  stripToolResultStructuredContent,
  structuredContentOmissionReason,
} from "../../stripToolResultStructuredContent";
import type { McpToolCallExtra, McpToolCallResult, ToolCall } from "../../toolCallDispatch";
import { formatToolParamError } from "../../toolParamError";
import { ToolRegistry, toolHasOutputSchema } from "../../toolRegistry";
import type { ToolSelectionProfileRegistry } from "../../../daemon/toolSelectionProfileRegistry";
import type { McpServerOptions } from "../../index";
import type { SessionToolBinding } from "../../SessionToolBinding";
import {
  enrichAcquiredSession,
  enrichProvisionDeviceResult,
  resolveRequestedEnableTools,
} from "./acquisition";
import {
  admitNamedSession,
  bindActiveDeviceResult,
  bindNamedSession,
  trackAcquisitionReleases,
} from "./bindSession";
import { parseCallContext, type CallContext } from "./callContext";
import { invokeHandler, type InvocationPlan } from "./invoke";
import {
  enforceConnectionOwnership,
  resolveSelectionRouting,
  resolveTool,
  routeDeviceSession,
  type ResolvedTool,
  type RoutingScope,
  type SelectionRouting,
} from "./routing";
import { shapeCallFailure } from "./shapeResult";

/** What the `tools/call` ingress needs from the server that owns it. */
export interface ToolCallIngressDeps {
  readonly options: McpServerOptions;
  readonly daemonMode: boolean;
  /**
   * The key this server binds a keyless call under: the request's session key
   * header, else the stateful transport's own session id (#4678).
   */
  readonly serverBindingKey: string | undefined;
  readonly sessionToolBinding: SessionToolBinding;
  readonly planExecutionLock: PlanExecutionLock;
  readonly toolSelectionProfileRegistry: ToolSelectionProfileRegistry;
  /** The `tools/list` result for a routing session, reused for acquisition enrichment. */
  readonly listSessionTools: (
    routingSessionUuid?: string,
  ) => Promise<{ tools: Array<{ name: string }> }>;
}

type Execution = ReturnType<typeof executionTracker.startExecution>;

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Block a call while an `executePlan` holds its session (or the whole connection). */
function assertNoActivePlan(
  deps: ToolCallIngressDeps,
  call: {
    readonly name: string;
    readonly tool: ResolvedTool;
    readonly toolParams: Record<string, unknown>;
    readonly sessionId: string | undefined;
    readonly executionSessionUuid: string | undefined;
    readonly routingSessionUuid: string | undefined;
  },
): void {
  const decision = deps.planExecutionLock.evaluate({
    toolName: call.name,
    sessionId: call.sessionId,
    sessionUuid: call.executionSessionUuid,
    readOnly: call.tool.isDeviceReadOnlyCall?.(call.toolParams) === true,
  });
  if (decision.blocked) {
    logger.warn(
      `[MCP] Rejecting tool ${call.name} due to active executePlan (scope=${decision.scope}, sessionId=${call.sessionId ?? "none"}, sessionUuid=${call.routingSessionUuid ?? "none"})`,
    );
    throw new PlanExecutionInProgressError(decision.scope, decision.reason);
  }
}

/** Parse the arguments against the tool's schema, then apply the managed-connection gate. */
function validateInput(
  tool: ResolvedTool,
  name: string,
  toolParams: Record<string, unknown>,
  gate: {
    readonly daemonMode: boolean;
    readonly mcpSessionId: string | undefined;
    readonly providedSessionUuid: string | undefined;
  },
): Record<string, unknown> {
  let parsedParams;
  const strippedToolParams = stripUndeclaredSessionUuid(
    stripInternalToolParams(toolParams),
    tool.schema,
  );
  try {
    parsedParams = tool.schema.parse(strippedToolParams);
  } catch (error) {
    const ParamsError = error instanceof ZodError ? InvalidToolParamsError : ActionableError;
    throw new ParamsError(
      `Invalid parameters for tool ${name}: ${formatToolParamError(name, error, strippedToolParams, tool.schema)}`,
    );
  }
  // A managed connection controls only its own bindings (#11178).
  assertBrokerConnectionPlainToolCall({
    daemonMode: gate.daemonMode,
    requiresDevice: tool.requiresDevice === true,
    toolName: name,
    mcpSessionId: gate.mcpSessionId,
    args: parsedParams,
    sessionUuid: gate.providedSessionUuid,
  });
  return parsedParams;
}

/**
 * #11344: a control call never runs on a session another connected client owns.
 * Refused before the execution starts, so naming the session neither extends nor
 * binds it. A plain control tool (killDevice, recordToolCalls) is admitted on the
 * session it names, so it is judged like a device call (#11542); nested internal
 * calls are judged by the same predicate (#11555).
 */
function refuseForeignOwnedControl(input: {
  readonly name: string;
  readonly tool: ResolvedTool;
  readonly parsedParams: Record<string, unknown>;
  readonly providedSessionUuid: string | undefined;
  readonly derivedLabelSessionUuid: string | undefined;
  readonly requestMcpSessionId: string | undefined;
}): void {
  const { tool, parsedParams } = input;
  if (!isControlCallOnNamedSession(tool, parsedParams)) {
    return;
  }
  // The session the call names, and the one a `device` label resolves to, which is the one
  // the call runs on (#11542). The implicit routing session of a call that names none is not
  // judged: a connection's bound session reaches here unnamed, and whether a binding another
  // connection merely declares may drive the session is an open owner question (#11555,
  // pinned in test/daemon/implicitRoutingForeignOwnedSession.test.ts).
  for (const sessionUuid of new Set([input.providedSessionUuid, input.derivedLabelSessionUuid])) {
    refuseControlOnForeignOwnedSession(
      input.name,
      sessionUuid,
      input.requestMcpSessionId,
      parsedParams,
    );
  }
}

/**
 * Whether another connection owns the session this call explicitly names:
 * #11235, #11344, with autolock on or off. Naming a UUID is not proof of
 * ownership (#11164): a read may still watch that session, but this connection
 * must never bind it for later sessionless calls. Read at bind time so an
 * ownership change during the handler is honored.
 */
function foreignOwnedExplicitSessionUuid(input: {
  readonly daemonMode: boolean;
  readonly tool: ResolvedTool;
  readonly parsedParams: unknown;
  readonly providedSessionUuid: string | undefined;
  readonly implicitAutolockMcpSessionId: string | undefined;
}): string | undefined {
  const { providedSessionUuid, implicitAutolockMcpSessionId } = input;
  const pool = providedSessionUuid ? defaultDaemonContext.devicePool() : undefined;
  if (!providedSessionUuid || !pool) {
    return undefined;
  }
  if (pool.isSessionOwnedByOtherConnection(providedSessionUuid, implicitAutolockMcpSessionId)) {
    return providedSessionUuid;
  }
  // A read never adopts an ownerless session or starts the proxy's owner heartbeat (#11557).
  const session =
    input.daemonMode &&
    input.tool.isDeviceReadOnlyCall?.(input.parsedParams) === true &&
    implicitAutolockMcpSessionId
      ? defaultDaemonContext.requireSessionManager().getSession(providedSessionUuid)
      : undefined;
  return session &&
    holdsOwnerHeartbeatLease(session.livenessPolicy) &&
    !pool.isSessionOwnedByConnection(providedSessionUuid, implicitAutolockMcpSessionId)
    ? providedSessionUuid
    : undefined;
}

function startExecution(input: {
  readonly name: string;
  readonly tool: ResolvedTool;
  readonly toolParams: Record<string, unknown>;
  readonly executionSessionId: string | undefined;
  readonly executionSessionUuid: string | undefined;
  readonly sessionId: string | undefined;
  readonly implicitAutolockMcpSessionId: string | undefined;
}): Execution {
  const { toolParams } = input;
  const untargetedDeviceCall =
    input.tool.requiresDevice &&
    !input.executionSessionUuid &&
    !("deviceId" in toolParams) &&
    !("platform" in toolParams) &&
    !("device" in toolParams) &&
    !("sessionUuid" in toolParams);
  return executionTracker.startExecution(
    input.name,
    input.executionSessionId,
    input.executionSessionUuid,
    {
      transportSessionId: input.sessionId,
      unresolvedAutolockMcpSessionId: untargetedDeviceCall
        ? input.implicitAutolockMcpSessionId
        : undefined,
    },
  );
}

/**
 * Wire-boundary output policy: strip the duplicated `structuredContent` tree
 * for no-schema tools unconditionally (issue #2759) and for schema tools when
 * the `--tool-results-no-structured-content` flag is on (issue #2899). Applied
 * here, not inside a tool handler, so internal handler callers keep reading
 * `structuredContent`, and plain-registered tools are covered. A dropped tree
 * leaves one debug trace naming the tool and why (issue #2962, structured per
 * #3216). The live-acceptance harness authenticates a private presentation
 * request at the daemon boundary and consumes the structured payload directly,
 * so that accepted request keeps its envelope intact.
 */
function applyOutputPolicy<T>(
  result: T,
  input: {
    readonly name: string;
    readonly tool: ResolvedTool;
    readonly toolResultsNoStructuredContent: boolean;
    readonly acceptanceDiscoveryRequested: boolean;
  },
): T {
  const omissionReason = input.acceptanceDiscoveryRequested
    ? null
    : structuredContentOmissionReason(
        toolHasOutputSchema(input.tool),
        input.toolResultsNoStructuredContent,
      );
  if (omissionReason !== null && responseCarriesStructuredContent(result)) {
    logger.debug("[MCP] Omitted structuredContent", { tool: input.name, reason: omissionReason });
  }
  return stripToolResultStructuredContent(result, omissionReason) as T;
}

interface AdmittedCall {
  readonly plan: InvocationPlan;
  readonly toolResultsNoStructuredContent: boolean;
  readonly requestedEnableTools: readonly string[];
  readonly plainReadCall: boolean;
  readonly readOutsideBoundSession: boolean;
  readonly withRoutedSession: <T>(result: T) => T;
  readonly endExecutionOnce: () => void;
  readonly endExplicitSessionBindClaim: (() => void) | undefined;
}

/** Everything between the admitted execution and the shaped result, including cleanup. */
async function runAdmittedCall(deps: ToolCallIngressDeps, call: AdmittedCall) {
  const { plan } = call;
  const { name, tool, execution, sessionId, sessionToolBinding, options } = plan;
  let releaseTracking: ReturnType<typeof trackAcquisitionReleases> | undefined;
  try {
    releaseTracking = trackAcquisitionReleases(name);
    await admitNamedSession(plan, {
      daemonMode: deps.daemonMode,
      plainReadCall: call.plainReadCall,
      toolSelectionProfileRegistry: deps.toolSelectionProfileRegistry,
    });
    let result = await invokeHandler(plan);
    const acquiredSessionUuid = isDeviceSessionAcquisitionTool(name)
      ? getDeviceSessionIdFromResult(result)
      : undefined;
    result = await enrichAcquiredSession({
      toolName: name,
      result,
      acquiredSessionUuid,
      requestedEnableTools: call.requestedEnableTools,
      sessionToolSelectionService: options.sessionToolSelectionService,
      listSessionTools: deps.listSessionTools,
      requestSignal: plan.requestSignal,
    });
    // #6869: a no-op for every tool but provisionDevice (guard inside).
    result = await enrichProvisionDeviceResult(
      name,
      result,
      acquiredSessionUuid,
      options.sessionToolSelectionService,
      { enableTools: call.requestedEnableTools, connectionProfileUuid: plan.connectionProfileUuid },
    );
    bindActiveDeviceResult(plan, result);
    await bindNamedSession(plan, { result, readOutsideBoundSession: call.readOutsideBoundSession });
    const response = applyOutputPolicy(result, {
      name,
      tool,
      toolResultsNoStructuredContent: call.toolResultsNoStructuredContent,
      acceptanceDiscoveryRequested: plan.context.requestAcceptanceDiscoveryOrder !== undefined,
    });
    // Publish only after all asynchronous enrichment finishes, so concurrent
    // direct acquisitions bind in response order. Keep this path synchronous.
    if (acquiredSessionUuid && releaseTracking.released.has(acquiredSessionUuid)) {
      throw new ActionableError(
        `Device session ${acquiredSessionUuid} was released during acquisition. Call ${name} again to acquire a device.`,
      );
    }
    if (acquiredSessionUuid && sessionToolBinding.bind(sessionId, acquiredSessionUuid)) {
      ToolRegistry.notifyToolSelectionChanged();
    }
    return call.withRoutedSession(response);
  } catch (error) {
    return await shapeCallFailure(error, {
      toolName: name,
      tool,
      daemonMode: deps.daemonMode,
      execution,
      executionSessionUuid: plan.executionSessionUuid,
      requestTimeoutMs: plan.context.requestTimeoutMs,
      toolResultsNoStructuredContent: call.toolResultsNoStructuredContent,
      textState: plan.textState,
      withRoutedSession: call.withRoutedSession,
      endExecutionOnce: call.endExecutionOnce,
    });
  } finally {
    call.endExplicitSessionBindClaim?.();
    try {
      releaseTracking?.cleanup?.();
    } finally {
      call.endExecutionOnce();
    }
  }
}

interface RoutedCall {
  readonly name: string;
  readonly tool: ResolvedTool;
  readonly toolParams: Record<string, unknown>;
  readonly sessionId: string | undefined;
  /** The session key this call's bindings are read and recorded under (#4678). */
  readonly bindingKey: string | undefined;
  readonly context: CallContext;
  readonly implicitAutolockMcpSessionId: string | undefined;
  readonly routingSessionUuid: string | undefined;
  readonly resolvedImplicitAutolockSessionUuid: string | undefined;
  readonly readOutsideBoundSession: boolean;
  readonly selection: SelectionRouting;
  readonly providedSessionUuid: string | undefined;
  readonly executionSessionUuid: string | undefined;
}

/** Resolve the tool, the session the call routes to, and the selection context it runs under. */
function routeCall(
  deps: ToolCallIngressDeps,
  call: ToolCall<McpToolCallExtra>,
  context: CallContext,
): RoutedCall | { readonly failure: McpToolCallResult } {
  const { name, args: toolParams } = call;
  const { options, daemonMode, sessionToolBinding } = deps;
  const sessionId = options.sessionContext?.sessionId;
  const implicitAutolockMcpSessionId =
    context.requestMcpSessionId ?? (!daemonMode ? sessionId : undefined);
  // The one session key (#4678, #13315): `context.requestMcpSessionId` already applies the
  // precedence (the session-key header wins over an in-band `__mcpSessionId`, except on the
  // daemon's own trusted forward, whose in-band id names the originating client); else the
  // stateful transport's own id. Every binding read and write below goes through it, never
  // the transport id directly.
  const bindingKey = context.requestMcpSessionId ?? deps.serverBindingKey;
  let routingSessionUuid: string | undefined;
  let readOutsideBoundSession = false;
  try {
    routingSessionUuid = sessionToolBinding.effectiveSessionUuid(bindingKey, toolParams, {
      readOnly: ToolRegistry.getTool(name)?.isDeviceReadOnlyCall?.(toolParams) === true,
      onReadOutsideBoundSession: () => {
        readOutsideBoundSession = true;
      },
    });
  } catch (error) {
    // Match the existing tool-error boundary below: the SDK handler alias
    // is narrower than the protocol's text-only tool error result.
    return {
      failure: shapeToolCallError(error, { toolName: name, source: "MCP" }) as McpToolCallResult,
    };
  }
  const initialConnectionProfileUuid =
    sessionToolBinding.connectionToolSelectionProfileUuid(bindingKey);
  const tool = resolveTool(name, toolParams);
  const scope: RoutingScope = {
    name,
    tool,
    toolParams,
    // The routing stages read `sessionId` only as the binding key.
    sessionId: bindingKey,
    daemonMode,
    context,
    sessionToolBinding,
    implicitAutolockMcpSessionId,
  };
  const routed = routeDeviceSession(
    scope,
    routingSessionUuid,
    Boolean(options.sessionContext?.initialSessionToolBinding),
  );
  readOutsideBoundSession = enforceConnectionOwnership(scope) || readOutsideBoundSession;
  const selection = resolveSelectionRouting({
    scope,
    options,
    toolSelectionProfileRegistry: deps.toolSelectionProfileRegistry,
    routingSessionUuid: routed.routingSessionUuid,
    initialConnectionProfileUuid,
  });
  const providedSessionUuid = nonBlank(toolParams.sessionUuid);
  return {
    name,
    tool,
    toolParams,
    sessionId,
    bindingKey,
    context,
    implicitAutolockMcpSessionId,
    routingSessionUuid: routed.routingSessionUuid,
    resolvedImplicitAutolockSessionUuid: routed.resolvedImplicitAutolockSessionUuid,
    readOutsideBoundSession,
    selection,
    providedSessionUuid,
    executionSessionUuid:
      selection.derivedLabelSessionUuid ?? providedSessionUuid ?? routed.routingSessionUuid,
  };
}

interface ValidatedCall {
  readonly parsedParams: Record<string, unknown>;
  readonly plainReadCall: boolean;
  readonly requestedEnableTools: readonly string[];
  readonly handlerRoutingSessionUuid: string | undefined;
}

/** Admission checks that need no execution yet: plan lock, schema, ownership of the named session. */
function validateCall(deps: ToolCallIngressDeps, routed: RoutedCall): ValidatedCall {
  const { name, tool, toolParams, sessionId, context, providedSessionUuid, selection } = routed;
  assertNoActivePlan(deps, {
    name,
    tool,
    toolParams,
    sessionId,
    executionSessionUuid: routed.executionSessionUuid,
    routingSessionUuid: routed.routingSessionUuid,
  });
  const parsedParams = validateInput(tool, name, toolParams, {
    daemonMode: deps.daemonMode,
    mcpSessionId: context.requestMcpSessionId,
    providedSessionUuid,
  });
  if (deps.daemonMode) {
    refuseForeignOwnedControl({
      name,
      tool,
      parsedParams,
      providedSessionUuid,
      derivedLabelSessionUuid: selection.derivedLabelSessionUuid,
      requestMcpSessionId: context.requestMcpSessionId,
    });
  }
  return {
    parsedParams,
    // A plain read (inventory, diagnostics, status) names a session only to watch it: it is
    // admitted read-only (no activity refresh), so neither its start nor its end is use (#11107).
    plainReadCall:
      !tool.requiresDevice &&
      (isDeviceInventoryTool(name) || tool.isDeviceReadOnlyCall?.(parsedParams) === true),
    // #6869: the capabilities this acquisition declares, validated up front.
    requestedEnableTools: resolveRequestedEnableTools(name, parsedParams),
    handlerRoutingSessionUuid:
      tool.requiresDevice && selection.requestedDeviceLabel && selection.routingBaseSessionUuid
        ? selection.routingBaseSessionUuid
        : routed.routingSessionUuid,
  };
}

interface TrackedExecution {
  readonly execution: Execution;
  readonly textState: TextRequestState;
  readonly getRequestDeadlineMs: () => number | undefined;
  readonly requestSignal: AbortSignal | undefined;
  readonly withRoutedSession: <T>(result: T) => T;
  readonly endExecutionOnce: () => void;
}

function trackExecution(
  deps: ToolCallIngressDeps,
  routed: RoutedCall,
  validated: ValidatedCall,
  extra: McpToolCallExtra,
): TrackedExecution {
  const { name, tool, toolParams, sessionId, context, implicitAutolockMcpSessionId } = routed;
  const execution = startExecution({
    name,
    tool,
    toolParams,
    // Registered under the request's session key (in-band, else header, else the
    // transport id), so `cancelSessionExecutions(key)` on a socket disconnect
    // reaches it even when the key arrived only as a header (#4678).
    executionSessionId: routed.bindingKey,
    executionSessionUuid: routed.executionSessionUuid,
    // A task's work outlives its request, so it registers under the task's own scope
    // rather than the one-off request scope the endpoint cancels on close (#4668).
    sessionId: extra.executionScopeId ?? sessionId,
    implicitAutolockMcpSessionId,
  });
  if (validated.plainReadCall) {
    executionTracker.markReadOnlySessionAccess(execution.id);
  }
  if (routed.resolvedImplicitAutolockSessionUuid) {
    // Routing resolved before ToolRegistry, so retain its implicit-session
    // tracking here without following later changes to the socket's default.
    executionTracker.setResolvedAutolockSessionUuid(
      execution.id,
      routed.resolvedImplicitAutolockSessionUuid,
    );
  }
  const { requestLiveDeadlineKey, requestDeadlineMs } = context;
  const textState =
    (requestLiveDeadlineKey ? getLiveTextRequestState(requestLiveDeadlineKey) : undefined) ??
    new TextRequestState();
  const getRequestDeadlineMs = () =>
    (requestLiveDeadlineKey ? getLiveDeadlineMs(requestLiveDeadlineKey) : undefined) ??
    requestDeadlineMs;
  // A release vetoed by this call is bounded by the call's own deadline (#10712).
  executionTracker.setExecutionDeadline(
    execution.id,
    getRequestDeadlineMs,
    requestLiveDeadlineKey
      ? (onExtended) => subscribeLiveDeadline(requestLiveDeadlineKey, onExtended)
      : undefined,
  );
  // The daemon echoes the session it routed an admitted, non-read call to, so a proxy credits
  // exactly that session instead of guessing it from a selector (#10974). Read before the
  // execution ends. The proxy learns from the marker not to remember a foreign-owned session
  // it named.
  const withRoutedSession = <T>(result: T): T =>
    deps.daemonMode
      ? withForeignOwnedSessionMeta(
          withAdmittedSessionEcho(result, execution.id),
          foreignOwnedExplicitSessionUuid({
            daemonMode: deps.daemonMode,
            tool,
            parsedParams: validated.parsedParams,
            providedSessionUuid: routed.providedSessionUuid,
            implicitAutolockMcpSessionId,
          }),
        )
      : result;
  let executionEnded = false;
  const endExecutionOnce = (): void => {
    if (!executionEnded) {
      executionEnded = true;
      unsubscribeRequestCancellation();
      executionTracker.endExecution(execution.id);
    }
  };
  const requestSignal = combineRequestAbortSignals(execution.abortController.signal, extra.signal);
  const unsubscribeRequestCancellation = subscribeRequestCancellation(
    executionTracker,
    execution.id,
    extra.signal,
  );
  return {
    execution,
    textState,
    getRequestDeadlineMs,
    requestSignal,
    withRoutedSession,
    endExecutionOnce,
  };
}

/**
 * The explicit-UUID attach after the handler runs later. Claim the bind for the whole call, so
 * a connection that closes mid-handler is refused as owner instead of recorded dead (#11348).
 */
function claimExplicitSessionBind(
  routed: RoutedCall,
  validated: ValidatedCall,
): (() => void) | undefined {
  const { tool, providedSessionUuid, implicitAutolockMcpSessionId } = routed;
  return providedSessionUuid &&
    tool.requiresDevice &&
    tool.isDeviceReadOnlyCall?.(validated.parsedParams) !== true &&
    implicitAutolockMcpSessionId
    ? defaultDaemonContext.devicePoolWrites()?.beginMcpBind(implicitAutolockMcpSessionId)
    : undefined;
}

async function executeToolCallBody(
  deps: ToolCallIngressDeps,
  call: ToolCall<McpToolCallExtra>,
): Promise<McpToolCallResult> {
  // Forwarded identity is trusted only on the daemon's internal transport.
  // Direct callers cannot override their connection's autolock ownership.
  const context = parseCallContext(call.args, {
    daemonMode: deps.daemonMode,
    acceptanceDiscoveryCapability: deps.options.acceptanceDiscoveryCapability,
    sessionKey: deps.options.requestMcpSessionId,
    trustForwardedSessionId: deps.options.trustForwardedMcpSessionId === true,
  });
  const routed = routeCall(deps, call, context);
  if ("failure" in routed) {
    return routed.failure;
  }
  const validated = validateCall(deps, routed);
  let tracked: TrackedExecution;
  try {
    tracked = trackExecution(deps, routed, validated, call.extra);
  } catch (error) {
    if (error instanceof DaemonRestartPendingError) {
      return daemonRestartPendingToolResult(error);
    }
    throw error;
  }
  const endExplicitSessionBindClaim = claimExplicitSessionBind(routed, validated);
  return runAdmittedCall(deps, {
    plan: {
      name: routed.name,
      tool: routed.tool,
      toolParams: routed.toolParams,
      parsedParams: validated.parsedParams,
      // The invoke and bind stages read `sessionId` only as the binding key.
      sessionId: routed.bindingKey,
      bindingKey: routed.bindingKey,
      context,
      options: deps.options,
      sessionToolBinding: deps.sessionToolBinding,
      execution: tracked.execution,
      implicitAutolockMcpSessionId: routed.implicitAutolockMcpSessionId,
      routingSessionUuid: routed.routingSessionUuid,
      handlerRoutingSessionUuid: validated.handlerRoutingSessionUuid,
      routingBaseSessionUuid: routed.selection.routingBaseSessionUuid,
      labelSessionUuids: routed.selection.labelSessionUuids,
      connectionProfileUuid: routed.selection.connectionProfileUuid,
      actionsCompactMetadata: routed.selection.actionsCompactMetadata,
      providedSessionUuid: routed.providedSessionUuid,
      executionSessionUuid: routed.executionSessionUuid,
      textState: tracked.textState,
      getRequestDeadlineMs: tracked.getRequestDeadlineMs,
      requestSignal: tracked.requestSignal,
      progress: call.progress,
    },
    toolResultsNoStructuredContent: routed.selection.toolResultsNoStructuredContent,
    requestedEnableTools: validated.requestedEnableTools,
    plainReadCall: validated.plainReadCall,
    readOutsideBoundSession: routed.readOutsideBoundSession,
    withRoutedSession: tracked.withRoutedSession,
    endExecutionOnce: tracked.endExecutionOnce,
    endExplicitSessionBindClaim,
  });
}

/**
 * The device ids a call names, as the pool's canonical ids, before anything
 * routes, judges or queues it (#11618). The socket server resolves a forwarded
 * call's ids from the pool's cached fold only, and a client on the daemon's
 * HTTP endpoint reaches this server with the ids as sent. Synchronous unless a
 * control call names a transport the pool has never seen.
 */
function withCanonicalDeviceIds(
  daemonMode: boolean,
  call: ToolCall<McpToolCallExtra>,
): ToolCall<McpToolCallExtra> | Promise<ToolCall<McpToolCallExtra>> {
  const tool = daemonMode ? ToolRegistry.getTool(call.name) : undefined;
  if (!tool) {
    return call;
  }
  const args = ToolRegistry.resolveToolCallDeviceIds(tool, call.args, call.extra.signal);
  return args instanceof Promise
    ? args.then((resolved) => ({ ...call, args: resolved }))
    : args === call.args
      ? call
      : { ...call, args };
}

/**
 * Build the `tools/call` executor for one MCP server. A typed refusal thrown
 * while routing, before the body's own `try`, would otherwise escape into the
 * SDK as an untyped -32603 error. It is shaped here so every typed refusal
 * reaches the client in the same result shape; untyped pre-`try` failures
 * (unknown tool, ...) still throw (#11292).
 */
export function createToolCallExecutor(
  deps: ToolCallIngressDeps,
): (call: ToolCall<McpToolCallExtra>) => Promise<McpToolCallResult> {
  return async (call) => {
    try {
      const canonical = withCanonicalDeviceIds(deps.daemonMode, call);
      return await executeToolCallBody(
        deps,
        canonical instanceof Promise ? await canonical : canonical,
      );
    } catch (error) {
      if (!isTypedToolRefusal(error)) {
        throw error;
      }
      return shapeToolCallError(error, { toolName: call.name, source: "MCP" }) as McpToolCallResult;
    }
  };
}

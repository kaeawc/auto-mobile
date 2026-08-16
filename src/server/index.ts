import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError, type ZodIssue } from "zod";
import { ActionableError } from "../models";
import { logger } from "../utils/logger";
import { defaultTimer } from "../utils/SystemTimer";
import { executionTracker } from "./executionTracker";
import { runWithAbortSignal } from "../utils/AbortContext";
import { createDefaultPlanExecutionLock, type PlanExecutionLock } from "./PlanExecutionLock";
import { SessionToolBinding } from "./SessionToolBinding";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import { deviceLostErrorFromAbortSignal, deviceLossOutcomeFromError } from "./deviceLossOutcome";

// Import the tool registry
import { ToolRegistry, toolHasOutputSchema } from "./toolRegistry";
import { stripToolResultStructuredContent, structuredContentOmissionReason, responseCarriesStructuredContent } from "./stripToolResultStructuredContent";

// Import the resource registry
import { ResourceRegistry } from "./resourceRegistry";

// Import all tool registration functions
import { registerObserveTools } from "./observeTools";
import { registerInteractionTools } from "./interactionTools";
import { registerAppTools } from "./appTools";
import { registerUtilityTools } from "./utilityTools";
import { registerDeviceTools } from "./deviceTools";
import { registerDeepLinkTools } from "./deepLinkTools";
import { registerDebugTools } from "./debugTools";
import { registerNavigationTools } from "./navigationTools";
import { registerNotificationTools } from "./notificationTools";
import { registerPlanTools } from "./planTools";
import { registerCriticalSectionTools } from "./criticalSectionTools";
import { registerBarrierTools } from "./barrierTools";
import { registerVideoRecordingTools } from "./videoRecordingTools";
import { registerSnapshotTools } from "./snapshotTools";
import { registerBiometricTools } from "./biometricTools";
import { registerTelephonyTools } from "./telephonyTools";
import { registerHighlightTools } from "./highlightTools";
import { registerDatabaseTools } from "./databaseTools";
import { registerStorageTools } from "./storageTools";
import { registerPreferenceTools } from "./preferenceTools";
import { registerAppFileTools } from "./appFileTools";
import { registerFormTools } from "./formTools";
import { registerAccessibilityTools } from "./accessibilityTools";
import { registerAccessibilityFocusTools } from "./accessibilityFocusTools";
import { registerNetworkTools } from "./networkTools";
import { registerToolCapabilityTools, SET_TOOL_CAPABILITY_TOOL_NAME } from "./toolCapabilityTools";
import { getMcpServerVersion } from "../utils/mcpVersion";

// Import resource registration functions
import { registerObservationResources } from "./observationResources";
import { registerObserveAppResource } from "./observeAppResource";
import { registerBootedDeviceResources } from "./bootedDeviceResources";
import { registerDeviceImageResources } from "./deviceImageResources";
import { registerAppResources } from "./appResources";
import { registerNavigationResources } from "./navigationResources";
import { registerTestTimingResources } from "./testTimingResources";
import { registerTestRunResources } from "./testRunResources";
import { registerPerformanceResources } from "./performanceResources";
import { registerVideoRecordingResources } from "./videoRecordingResources";
import { registerLocalizationResources } from "./localizationResources";
import { registerDeviceSnapshotResources } from "./deviceSnapshotResources";
import { registerDatabaseResources } from "./databaseResources";
import { registerFailuresResources } from "./failuresResources";
import { registerStorageResources } from "./storageResources";
import { registerAppFileResources } from "./appFileResources";
import { registerFeatureFlagResources } from "./featureFlagResources";
import { registerNetworkResources } from "./networkResources";
import { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import { startupBenchmark } from "../utils/startupBenchmark";
import {
  getSessionToolProfileService,
  type SessionToolProfileService,
} from "../features/toolCapabilities/SessionToolProfileService";
import {
  assertToolEnabledForAnySession,
  isToolEnabledForAnySession,
} from "../features/toolCapabilities/toolCapabilityPolicy";
import { getDeviceLabelMap } from "./deviceLabelMapping";
import { runWithToolCapabilityContext } from "../features/toolCapabilities/toolCapabilityContext";

export interface McpServerOptions {
  debug?: boolean;
  sessionContext?: {
    sessionId?: string;
    initialSessionToolBinding?: string;
    initialCapabilityToolProfile?: string;
  };
  planExecutionLock?: PlanExecutionLock;
  daemonMode?: boolean;
  sessionToolProfileService?: Pick<SessionToolProfileService, "isEnabled"> &
    Partial<Pick<SessionToolProfileService, "setEnabled" | "deleteSession">>;
}

const INTERNAL_MCP_SESSION_PARAM = "__mcpSessionId";
const INTERNAL_EXECUTION_ID_PARAM = "__executionId";
const INTERNAL_EXECUTION_START_TIME_PARAM = "__executionStartTime";
function extractInternalMcpSessionId(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  const value = (params as Record<string, unknown>)[INTERNAL_MCP_SESSION_PARAM];
  return typeof value === "string" ? value : undefined;
}

function stripInternalToolParams(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }

  if (!(INTERNAL_MCP_SESSION_PARAM in params)
    && !(INTERNAL_EXECUTION_ID_PARAM in params)
    && !(INTERNAL_EXECUTION_START_TIME_PARAM in params)) {
    return params;
  }

  const rest = { ...(params as Record<string, unknown>) };
  delete rest[INTERNAL_MCP_SESSION_PARAM];
  delete rest[INTERNAL_EXECUTION_ID_PARAM];
  delete rest[INTERNAL_EXECUTION_START_TIME_PARAM];
  return rest;
}

function flattenZodIssues(issues: ZodIssue[]): ZodIssue[] {
  const flattened: ZodIssue[] = [];

  const visit = (issue: ZodIssue) => {
    if (issue.code === "invalid_union" && Array.isArray(issue.errors) && issue.errors.length) {
      issue.errors.forEach(unionIssues => {
        unionIssues.forEach(unionIssue => {
          const normalizedIssue = issue.path.length
            ? { ...unionIssue, path: [...issue.path, ...unionIssue.path] }
            : unionIssue;
          visit(normalizedIssue as ZodIssue);
        });
      });
      return;
    }
    flattened.push(issue);
  };

  issues.forEach(visit);
  return flattened;
}

// Exported for direct unit testing of the container-hint branch (issue #4181,
// rank 7). The hint is only appended for tapOn/swipeOn container issues.
export function formatToolParamError(toolName: string, error: unknown): string {
  if (!(error instanceof ZodError)) {
    return String(error);
  }

  const flattenedIssues = flattenZodIssues(error.issues);
  const issues = flattenedIssues.map(issue => {
    const path = issue.path.length ? issue.path.join(".") : "parameters";
    if (issue.code === "invalid_type") {
      // zod v4 issues carry no runtime `received` field; the default message
      // already reads "Invalid input: expected X, received Y", so reuse it
      // minus the prefix to keep the historical "<path> expected X" format.
      return `${path} ${issue.message.replace(/^Invalid input: /, "")}`;
    }
    return `${path} ${issue.message}`;
  });

  const hints: string[] = [];
  if (toolName === "swipeOn" || toolName === "tapOn") {
    const containerIssue = flattenedIssues.find(issue => issue.path[0] === "container");
    if (containerIssue) {
      hints.push("container must be an object like { \"elementId\": \"<id>\" } or { \"text\": \"<text>\" }");
    }
  }

  const issueSummary = issues.join("; ");
  const hintSummary = hints.length > 0 ? ` Hint: ${hints.join(" ")}` : "";
  return `${issueSummary}${hintSummary}`;
}

export const createMcpServer = (options: McpServerOptions = {}): McpServer => {
  const sessionToolBinding = new SessionToolBinding(
    options.sessionContext?.initialSessionToolBinding,
    options.sessionContext?.initialCapabilityToolProfile,
  );
  // Plan execution lock with per-session scope to prevent interference during executePlan
  // Each test thread gets its own sessionUuid, enabling parallel execution on different devices
  const planExecutionLock = options.planExecutionLock ?? createDefaultPlanExecutionLock();
  const daemonMode = options.daemonMode ?? false;
  void FeatureFlagService.getInstance()
    .initialize()
    .catch(error => {
      logger.warn(`Failed to initialize feature flags: ${error}`);
    });
  // Get configuration and device session managers

  // Register all tool categories
  startupBenchmark.startPhase("toolRegistration");
  registerObserveTools();
  registerInteractionTools();
  registerAppTools();
  registerUtilityTools();
  registerDeviceTools();
  registerToolCapabilityTools();
  registerDeepLinkTools();
  registerNavigationTools();
  registerNotificationTools();
  // Plan tools (executePlan, recordSteps, startTestRecording, exportPlan)
  // registered outside the daemonMode gate so MCP recording works in stdio mode
  // (the standard MCP transport agents use). executePlan multi-device allocation
  // still requires daemon and throws a clear error without it.
  // Critical section tools remain daemon-only (DaemonState lock manager).
  registerPlanTools();
  if (daemonMode) {
    registerCriticalSectionTools();
    registerBarrierTools();
  }
  registerVideoRecordingTools();
  registerSnapshotTools();
  registerBiometricTools();
  registerTelephonyTools();
  registerHighlightTools();
  registerDatabaseTools();
  registerStorageTools();
  registerPreferenceTools();
  registerAppFileTools();
  registerFormTools();
  registerAccessibilityTools();
  registerAccessibilityFocusTools();
  registerNetworkTools();
  registerDebugTools();
  startupBenchmark.endPhase("toolRegistration");

  // Register all resources
  startupBenchmark.startPhase("resourceRegistration");
  registerObservationResources();
  registerObserveAppResource();
  registerBootedDeviceResources();
  registerDeviceImageResources();
  registerAppResources();
  registerNavigationResources();
  registerTestTimingResources();
  registerTestRunResources();
  registerPerformanceResources();
  registerVideoRecordingResources();
  registerLocalizationResources();
  registerDeviceSnapshotResources();
  registerDatabaseResources();
  registerFailuresResources();
  registerStorageResources();
  registerAppFileResources();
  registerFeatureFlagResources();
  registerNetworkResources();
  startupBenchmark.endPhase("resourceRegistration");

  // Create a new MCP server
  startupBenchmark.startPhase("sdkInitialization");
  const server = new McpServer({
    name: "AutoMobile",
    version: getMcpServerVersion()
  }, {
    capabilities: {
      resources: {},
      tools: {},
      prompts: {}
    }
  });
  startupBenchmark.endPhase("sdkInitialization");

  // Register all tools with the server
  startupBenchmark.startPhase("serverHandlerRegistration");
  ToolRegistry.registerWithServer(server);

  // Emit notifications/tools/list_changed when a runtime feature-flag toggle
  // changes tool definitions (outputSchema advertisement or tool availability),
  // so caching clients re-fetch tools/list (issue #2963). The emit itself lives on
  // ToolRegistry (which tracks every live session's server), mirroring
  // ResourceRegistry's resources/list_changed; this only routes the feature-flag
  // singleton to it. Wired here because the singleton is constructed before the
  // server exists.
  //
  // In the default proxy topology (external client -> proxy -> daemon) the
  // notification also reaches proxy-mode clients (issue #3223): ToolRegistry
  // fans out to all live daemon sessions AND emits on the ListChangedBroadcaster,
  // which the daemon's Unix socket server pushes to subscribed DaemonMcpProxy
  // clients; each proxy invalidates its tool cache and re-emits to its client.
  FeatureFlagService.getInstance().setToolListChangedNotifier({
    notifyToolListChanged: () => ToolRegistry.notifyToolListChanged(),
  });

  // Register all resources with the server
  ResourceRegistry.registerWithServer(server);

  // Tear down this transport's server-side SessionToolBinding when the daemon
  // actually releases a session (issue #4611 Gap D). Two release sources funnel
  // through the same idempotent `unbindSession`:
  //   - the plan-release path, via ToolRegistry's injected teardown handler
  //     (executePlan auto-release, deterministic, works in stdio mode too); and
  //   - heartbeat/idle/explicit releases, via the process-wide
  //     SessionReleaseBroadcaster (issue #4610), active in daemon mode.
  // Clearing the binding stops a later sessionless tools/list or tools/call on
  // this same MCP transport from enforcing the released session's stale profile.
  // A list-changed notification is emitted only when a binding actually changed,
  // so a duplicate release signal for the same session is a no-op.
  const clearReleasedSessionBinding = (sessionUuid: string): void => {
    if (sessionToolBinding.unbindSession(sessionUuid)) {
      ToolRegistry.notifyToolListChanged();
    }
  };
  const unregisterSessionBindingRelease = ToolRegistry.registerSessionBindingReleaseHandler({
    onSessionReleased: clearReleasedSessionBinding,
  });
  const unsubscribeSessionReleaseBroadcast = SessionReleaseBroadcaster.subscribe(clearReleasedSessionBinding);
  // Chain onto the existing onclose (set by ToolRegistry.registerWithServer's
  // server tracking) so the per-transport teardown subscriptions are dropped when
  // the transport closes, and no other lifecycle hook is clobbered.
  const existingServerOnClose = server.server.onclose;
  server.server.onclose = () => {
    unregisterSessionBindingRelease();
    unsubscribeSessionReleaseBroadcast();
    existingServerOnClose?.();
  };

  // Register tool definitions using the lower-level interface
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const sessionId = options.sessionContext?.sessionId;
    const routingSessionUuid = sessionToolBinding.effectiveSessionUuid(sessionId);
    const connectionProfileUuid = sessionToolBinding.connectionCapabilityProfileUuid(sessionId);
    const definitions = ToolRegistry.getToolDefinitions();
    // Advertise a tool when EITHER the bound base session OR any of its derived
    // `${base}:${label}` device-label sessions enables it — the same UNION the
    // `tools/call` gate applies (issue #4611). The call-gate accepts a
    // `{ sessionUuid: base, device: label }` call whenever a label re-enables a
    // tool the base narrowed away; filtering discovery on the base alone would
    // then leave that tool callable but never discovered. The base's label map is
    // a read-only lookup (no device allocation); a session with no labels collapses
    // to the base, preserving prior single-session filtering.
    //
    // The union is per-tool and DEVICE-AWARE only, mirroring the call gate: a
    // plain (non-`requiresDevice`) tool runs under the base session regardless of
    // any `device` argument, so its discovery must be base-only. Advertising a
    // plain tool that only a label enables would leave it listed but rejected by
    // the base-only call gate — a label-only grant must not surface a plain tool.
    const labelSessionUuids = routingSessionUuid
      ? Object.values(getDeviceLabelMap(routingSessionUuid) ?? {})
      : [];
    return {
      tools: (await Promise.all(definitions.map(async definition => {
        const deviceAware = ToolRegistry.getTool(definition.name)?.requiresDevice ?? false;
        const candidateSessions = deviceAware
          ? [connectionProfileUuid, routingSessionUuid, ...labelSessionUuids]
          : [connectionProfileUuid, routingSessionUuid];
        return await isToolEnabledForAnySession(
          definition.name,
          candidateSessions,
          options.sessionToolProfileService,
          connectionProfileUuid,
        ) ? definition : undefined;
      }))).filter((definition): definition is typeof definitions[number] => definition !== undefined)
    };
  });

  // Add ping handler as per MCP specification
  // Note: Using runtime access since TypeScript import has issues
  const PingRequestSchema = require("@modelcontextprotocol/sdk/types.js").PingRequestSchema;
  server.server.setRequestHandler(PingRequestSchema, async () => {
    return {};
  });

  // Register prompts list handler (currently returns empty list since no prompts are implemented)
  // Note: Using runtime access since TypeScript import has issues
  const ListPromptsRequestSchema = require("@modelcontextprotocol/sdk/types.js").ListPromptsRequestSchema;
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: []
    };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    logger.info("Request: ", request);

    // Extract tool name and arguments from the request
    const name = request.params.name;
    const toolParams = request.params.arguments || {};

    // Check if name is undefined
    if (!name) {
      throw new ActionableError("Tool name is missing in the request");
    }

    const sessionId = options.sessionContext?.sessionId;
    const routingSessionUuid = sessionToolBinding.effectiveSessionUuid(sessionId, toolParams);
    let connectionProfileUuid = sessionToolBinding.connectionCapabilityProfileUuid(sessionId);
    let capabilitySessionUuid = connectionProfileUuid ?? routingSessionUuid;
    const rawRequestedCapabilityProfileUuid = (toolParams as Record<string, unknown>).sessionUuid;
    const requestedCapabilityProfileUuid = typeof rawRequestedCapabilityProfileUuid === "string"
      ? rawRequestedCapabilityProfileUuid
      : undefined;

    // Get the registered tool
    const tool = ToolRegistry.getTool(name);
    if (!tool) {
      throw new ActionableError(`Unknown tool: ${name}`);
    }
    // Capability management must be callable before an agent has chosen a
    // device. Establish a transport-local profile that the control tool can
    // persist and that later tools/list calls use for discovery.
    if (name === SET_TOOL_CAPABILITY_TOOL_NAME && !capabilitySessionUuid) {
      capabilitySessionUuid = sessionToolBinding.createAndBindCapabilityProfile(sessionId);
      connectionProfileUuid = capabilitySessionUuid;
    }
    if (
      name === SET_TOOL_CAPABILITY_TOOL_NAME
      && !connectionProfileUuid
      && requestedCapabilityProfileUuid?.trim().length
    ) {
      connectionProfileUuid = requestedCapabilityProfileUuid;
      sessionToolBinding.bindCapabilityProfile(sessionId, connectionProfileUuid);
    }
    // Capability enforcement honors the UNION of the base and the derived
    // `${base}:${label}` device-label sessions (issue #4611): a tool is enabled
    // when EITHER grants it. This public MCP boundary is an EARLIER gate than the
    // authoritative union in `registerDeviceAware` (which rejects a
    // capability-denied tool before allocating a device), so it must apply the
    // same union — otherwise a base session that narrowed a tool away would
    // reject a `{ sessionUuid: base, device: label }` call here before the deeper
    // gate could observe that `base:label` re-enables it. Resolve the derived
    // label candidate from the base session's label map (a read-only lookup, no
    // device allocation). Non-labeled and non-device-aware calls collapse to the
    // base, preserving prior single-session behavior and `tools/list` filtering.
    //
    // Gate the derived-label candidate to DEVICE-AWARE tools only. A plain tool
    // (registered via `register`, not `registerDeviceAware`) strips the `device`
    // field via its `z.object` schema and always executes under the base session,
    // so it never runs on the labeled device — consulting `base:label`'s profile
    // would let a caller borrow the label's grants for a base-disabled plain tool
    // with `{ sessionUuid: base, device: label }`. For a plain tool, enforcement
    // is base-only; only a `requiresDevice` tool actually uses the device field.
    const requestedDeviceLabel = typeof (toolParams as Record<string, unknown>).device === "string"
      ? (toolParams as Record<string, unknown>).device as string
      : undefined;
    const derivedLabelSessionUuid = tool.requiresDevice && requestedDeviceLabel && routingSessionUuid
      ? getDeviceLabelMap(routingSessionUuid)?.[requestedDeviceLabel]
      : undefined;
    await assertToolEnabledForAnySession(
      name,
      [connectionProfileUuid, routingSessionUuid, derivedLabelSessionUuid],
      options.sessionToolProfileService,
    );

    const requestMcpSessionId = extractInternalMcpSessionId(toolParams);
    const implicitAutolockMcpSessionId = requestMcpSessionId ?? (!daemonMode ? sessionId : undefined);
    const rawSessionUuid =
      toolParams &&
      typeof toolParams === "object" &&
      "sessionUuid" in toolParams
        ? (toolParams as { sessionUuid?: string }).sessionUuid
        : undefined;
    const providedSessionUuid = typeof rawSessionUuid === "string" && rawSessionUuid.trim().length > 0
      ? rawSessionUuid
      : undefined;
    if (sessionToolBinding.bind(sessionId, providedSessionUuid)) {
      ToolRegistry.notifyToolListChanged();
    }

    // Check if tool call should be blocked due to active executePlan in this session
    const decision = planExecutionLock.evaluate({
      toolName: name,
      sessionId,
      sessionUuid: providedSessionUuid ?? routingSessionUuid,
    });
    if (decision.blocked) {
      logger.warn(
        `[MCP] Rejecting tool ${name} due to active executePlan (scope=${decision.scope}, sessionId=${sessionId ?? "none"}, sessionUuid=${routingSessionUuid ?? "none"})`
      );
      throw new ActionableError(decision.reason ?? "plan execution in progress");
    }

    // Parse and validate the parameters
    let parsedParams;
    try {
      parsedParams = tool.schema.parse(stripInternalToolParams(toolParams));
    } catch (error) {
      throw new ActionableError(`Invalid parameters for tool ${name}: ${formatToolParamError(name, error)}`);
    }

    const executionSessionUuid = derivedLabelSessionUuid ?? providedSessionUuid ?? routingSessionUuid;
    const executionSessionId = requestMcpSessionId ?? sessionId;
    const execution = executionTracker.startExecution(
      name,
      executionSessionId,
      executionSessionUuid,
      sessionId,
    );
    const handlerParams = parsedParams && typeof parsedParams === "object"
      ? {
        ...parsedParams,
        ...(implicitAutolockMcpSessionId ? { [INTERNAL_MCP_SESSION_PARAM]: implicitAutolockMcpSessionId } : {}),
        [INTERNAL_EXECUTION_ID_PARAM]: execution.id,
        [INTERNAL_EXECUTION_START_TIME_PARAM]: execution.startTime,
      }
      : parsedParams;

    // Create progress callback if tool supports progress
    const progressCallback = tool.supportsProgress
      ? async (progress: number, total?: number, message?: string) => {
        try {
          await server.server.notification({
            method: "notifications/progress",
            params: {
              progressToken: `${name}-${defaultTimer.now()}`,
              progress,
              total,
              ...(message && { message })
            }
          });
        } catch (error) {
          // Log progress notification errors but don't fail the tool execution
          logger.warn(`Failed to send progress notification: ${error}`);
        }
      }
      : undefined;

    try {
      const result = await runWithAbortSignal(
        execution.abortController.signal,
        () => runWithToolCapabilityContext(
          {
            routingSessionUuid,
            // A routing session already carries its own base/label union in
            // ToolRegistry. Carry only a distinct connection profile so it
            // cannot suppress that derived-label resolution.
            capabilitySessionUuid: connectionProfileUuid,
            // Keep profile persistence lazy for ordinary core-tool calls while
            // giving an admitted plan its service instance for release cleanup.
            sessionToolProfileService: options.sessionToolProfileService
              ?? (name === "executePlan" ? getSessionToolProfileService() : undefined),
          },
          () => tool.handler(handlerParams, progressCallback, execution.abortController.signal)
        )
      );
      // Wire-boundary output policy: strip the duplicated `structuredContent`
      // tree for no-schema tools unconditionally (issue #2759) and for schema
      // tools when the `--tool-results-no-structured-content` flag is on (issue
      // #2899). Applied here — not inside a tool handler — so internal handler
      // callers keep reading `structuredContent`, and so plain-registered tools
      // are covered.
      // Field-debuggability trace (issue #2962): when the wire boundary actually
      // drops a `structuredContent` tree, emit one debug trace naming the tool and
      // WHY, so a client that reads both paths can tell an intentional omission
      // from an accidental miss. The reason is resolved once here and passed into
      // the strip (single source of truth), and the trace is gated on the same
      // "a field is actually present" condition as the strip, so it never
      // over-reports on non-envelope responses. Debug level → dropped at the
      // default INFO level, so no per-call noise beyond the guard. Aligns with the
      // "log-and-continue with a why" convention. The tool/reason ride as a
      // structured second argument (issue #3216) so field extraction is stable
      // (grep `"tool":"..."`) without coupling consumers to the message text.
      const omissionReason = structuredContentOmissionReason(toolHasOutputSchema(tool));
      if (omissionReason !== null && responseCarriesStructuredContent(result)) {
        logger.debug("[MCP] Omitted structuredContent", { tool: name, reason: omissionReason });
      }
      return stripToolResultStructuredContent(result, omissionReason);
    } catch (error) {
      const deviceLoss = deviceLossOutcomeFromError(error, executionSessionUuid)
        ?? deviceLossOutcomeFromError(
          deviceLostErrorFromAbortSignal(execution.abortController.signal),
          executionSessionUuid,
        );
      if (deviceLoss) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(deviceLoss) }],
          isError: true,
        };
      }
      throw error;
    } finally {
      executionTracker.endExecution(execution.id);
    }
  });
  startupBenchmark.endPhase("serverHandlerRegistration");

  return server;
};

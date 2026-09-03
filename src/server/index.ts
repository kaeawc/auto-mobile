import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ActionableError } from "../models";
import { formatToolParamError } from "./toolParamError";
import { reviveNonFiniteArguments } from "../utils/nonFiniteJson";
import { logger } from "../utils/logger";
import { defaultTimer } from "../utils/SystemTimer";
import { executionTracker } from "./executionTracker";
import { combineAbortSignals, runWithAbortSignal } from "../utils/AbortContext";
import { createDefaultPlanExecutionLock, type PlanExecutionLock } from "./PlanExecutionLock";
import { SessionToolBinding } from "./SessionToolBinding";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import { TerminalSessionError } from "../daemon/sessionManager";
import { resolveDirectSessionDevice } from "./directSessionDeviceRegistry";
import {
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  DAEMON_NON_FINITE_ENCODED_PARAM,
} from "../daemon/constants";
import {
  deviceLostErrorFromAbortSignal,
  deviceLossOutcomeFromError,
  enrichDeviceLossOutcome,
  remainingDeviceLossIncidentWaitMs,
  type DeviceLossOutcome,
} from "./deviceLossOutcome";

// Import the tool registry
import { ToolRegistry, toolHasOutputSchema } from "./toolRegistry";
import {
  stripToolResultStructuredContent,
  structuredContentOmissionReason,
  responseCarriesStructuredContent,
} from "./stripToolResultStructuredContent";

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
import { registerSharedStorageTools } from "./sharedStorageTools";
import { registerFormTools } from "./formTools";
import { registerAccessibilityTools } from "./accessibilityTools";
import { registerAccessibilityFocusTools } from "./accessibilityFocusTools";
import { registerNetworkTools } from "./networkTools";
import { registerToolSelectionTools, SET_TOOL_ENABLED_TOOL_NAME } from "./toolSelectionTools";
import {
  getDeviceSessionIdFromResult,
  isDeviceSessionAcquisitionTool,
} from "./deviceSessionResult";
import { getMcpServerVersion } from "../utils/mcpVersion";

// Import resource registration functions
import { registerObservationResources } from "./observationResources";
import { registerToolOutputResources } from "./toolOutputResources";
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
import { registerStorageCapabilityResources } from "./storageCapabilityResources";
import { registerDataStoreResources } from "./dataStoreResources";
import { registerAppFileResources } from "./appFileResources";
import { registerSharedStorageResources } from "./sharedStorageResources";
import { registerFeatureFlagResources } from "./featureFlagResources";
import { registerNetworkResources } from "./networkResources";
import { registerEmulatorLossIncidentResources } from "./emulatorLossIncidentResources";
import { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import { startupBenchmark } from "../utils/startupBenchmark";
import {
  getSessionToolSelectionService,
  type SessionToolSelectionService,
  validateConfiguredToolSelectionDefaults,
} from "../features/toolSelection/SessionToolSelectionService";
import {
  assertToolEnabledForAnySession,
  isToolEnabledForAnyRoute,
} from "../features/toolSelection/toolSelectionPolicy";
import { runWithToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import {
  resolveToolSelectionBaseSessionUuid,
  type ToolSelectionSessionManager,
} from "../features/toolSelection/selectionSessionResolver";
import { DaemonState } from "../daemon/daemonState";

export interface McpServerOptions {
  debug?: boolean;
  sessionContext?: {
    sessionId?: string;
    initialSessionToolBinding?: string;
    initialReleasedSession?: string;
    initialToolSelectionProfile?: string;
  };
  planExecutionLock?: PlanExecutionLock;
  daemonMode?: boolean;
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled"> &
    Partial<Pick<SessionToolSelectionService, "setEnabled" | "deleteSession" | "getOverride">>;
  toolSelectionSessionManager?: ToolSelectionSessionManager;
}

const INTERNAL_MCP_SESSION_PARAM = "__mcpSessionId";
const INTERNAL_EXECUTION_ID_PARAM = "__executionId";
const INTERNAL_EXECUTION_START_TIME_PARAM = "__executionStartTime";

async function resolveDeviceLossOutcome(
  deviceLoss: DeviceLossOutcome,
  timeoutMs?: number,
): Promise<DeviceLossOutcome> {
  const daemonState = DaemonState.getInstance();
  if (!deviceLoss.incidentId || !daemonState.isInitialized()) {
    return deviceLoss;
  }
  try {
    const incident = await daemonState
      .getDevicePool()
      .waitForEmulatorLossIncident(deviceLoss.incidentId, timeoutMs);
    return enrichDeviceLossOutcome(deviceLoss, incident);
  } catch (incidentError) {
    logger.warn(
      `[MCP] Failed to resolve device-loss incident ${deviceLoss.incidentId}: ${incidentError}`,
      incidentError,
    );
    return deviceLoss;
  }
}

function extractInternalMcpSessionId(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  const value = (params as Record<string, unknown>)[INTERNAL_MCP_SESSION_PARAM];
  return typeof value === "string" ? value : undefined;
}

function extractInternalMcpRequestTimeoutMs(params: unknown): number | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const value = (params as Record<string, unknown>)[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stripInternalToolParams(params: unknown): unknown {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return params;
  }

  if (
    !(INTERNAL_MCP_SESSION_PARAM in params) &&
    !(INTERNAL_EXECUTION_ID_PARAM in params) &&
    !(INTERNAL_EXECUTION_START_TIME_PARAM in params) &&
    !(DAEMON_NON_FINITE_ENCODED_PARAM in params)
  ) {
    return params;
  }

  const rest = { ...(params as Record<string, unknown>) };
  delete rest[INTERNAL_MCP_SESSION_PARAM];
  delete rest[INTERNAL_EXECUTION_ID_PARAM];
  delete rest[INTERNAL_EXECUTION_START_TIME_PARAM];
  delete rest[INTERNAL_MCP_REQUEST_TIMEOUT_PARAM];
  // Safety net: revival already strips this transport-provenance flag (#5863), but
  // guard the tool boundary against any future path that sets it without reviving.
  delete rest[DAEMON_NON_FINITE_ENCODED_PARAM];
  return rest;
}

// `formatToolParamError` lives in its own module so non-server callers (e.g.
// PlanExecutor, #5854 §3) can share the exact MCP-boundary rendering without
// importing the whole server entrypoint (which would be circular). Re-exported
// here to preserve the historical import path used by existing tests.
export { formatToolParamError };

/**
 * Populate the canonical production registry and validate exact-tool startup
 * defaults. The process entrypoint calls this before opening daemon listeners;
 * createMcpServer calls it again because tests and embedded consumers may create
 * a server directly. Registration is idempotent because the registry is keyed
 * by exact tool name.
 */
export function registerMcpTools(daemonMode: boolean): void {
  registerObserveTools();
  registerInteractionTools();
  registerAppTools();
  registerUtilityTools();
  registerDeviceTools();
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
  registerSharedStorageTools();
  registerFormTools();
  registerAccessibilityTools();
  registerAccessibilityFocusTools();
  registerNetworkTools();
  registerDebugTools();
  registerToolSelectionTools();
  validateConfiguredToolSelectionDefaults(new Set(ToolRegistry.getConfigurableToolNames()));
}

export const createMcpServer = (options: McpServerOptions = {}): McpServer => {
  const sessionToolBinding = new SessionToolBinding(
    options.sessionContext?.initialSessionToolBinding,
    options.sessionContext?.initialToolSelectionProfile,
    undefined,
    options.sessionContext?.initialReleasedSession,
  );
  // Plan execution lock with per-session scope to prevent interference during executePlan
  // Each test thread gets its own sessionUuid, enabling parallel execution on different devices
  const planExecutionLock = options.planExecutionLock ?? createDefaultPlanExecutionLock();
  const daemonMode = options.daemonMode ?? false;
  void FeatureFlagService.getInstance()
    .initialize()
    .catch((error) => {
      logger.warn(`Failed to initialize feature flags: ${error}`);
    });
  // Get configuration and device session managers

  // Register all tool categories
  startupBenchmark.startPhase("toolRegistration");
  registerMcpTools(daemonMode);
  startupBenchmark.endPhase("toolRegistration");

  // Register all resources
  startupBenchmark.startPhase("resourceRegistration");
  registerObservationResources();
  registerToolOutputResources();
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
  registerStorageCapabilityResources();
  registerDataStoreResources();
  registerAppFileResources();
  registerSharedStorageResources();
  registerFeatureFlagResources();
  registerNetworkResources();
  registerEmulatorLossIncidentResources();
  startupBenchmark.endPhase("resourceRegistration");

  // Create a new MCP server
  startupBenchmark.startPhase("sdkInitialization");
  const server = new McpServer(
    {
      name: "AutoMobile",
      version: getMcpServerVersion(),
    },
    {
      capabilities: {
        resources: {},
        tools: {},
        prompts: {},
      },
    },
  );
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
  ResourceRegistry.registerWithServer(server, (signal) => ({
    sessionUuid: sessionToolBinding.effectiveSessionUuid(options.sessionContext?.sessionId),
    releasedSessionUuid: sessionToolBinding.releasedResourceSessionUuid(
      options.sessionContext?.sessionId,
    ),
    signal,
  }));

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
  const unsubscribeSessionReleaseBroadcast = SessionReleaseBroadcaster.subscribe(
    clearReleasedSessionBinding,
  );
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
    const connectionProfileUuid = sessionToolBinding.connectionToolSelectionProfileUuid(sessionId);
    const selectionSessionManager =
      options.toolSelectionSessionManager ??
      (DaemonState.getInstance().isInitialized()
        ? DaemonState.getInstance().getSessionManager()
        : undefined);
    const routingBaseSessionUuid = resolveToolSelectionBaseSessionUuid(
      routingSessionUuid,
      selectionSessionManager,
    );
    const definitions = ToolRegistry.getToolDefinitions();
    // Advertise a tool when EITHER the bound base session OR any of its derived
    // `${base}:${label}` device-label sessions enables it — the same UNION the
    // `tools/call` gate applies (issue #4611). The call-gate accepts a
    // `{ sessionUuid: base, device: label }` call whenever a label re-enables a
    // tool the base narrowed away; filtering discovery on the base alone would
    // then leave that tool callable but never discovered. Each label remains an
    // independent `[base, label]` route before those route results are unioned;
    // flattening every label into one override set would let one label's explicit
    // disable hide a tool that is still callable through a sibling. The base's
    // label map is a read-only lookup (no device allocation); a session with no
    // labels collapses to the base, preserving prior single-session filtering.
    //
    // The union is per-tool and DEVICE-AWARE only, mirroring the call gate: a
    // plain (non-`requiresDevice`) tool ignores any `device` argument, so its
    // discovery only evaluates the bound routing session. Advertising a plain
    // tool that only a sibling label enables would leave it listed but rejected
    // by the call gate — a label-only grant must not surface a plain tool.
    const labelSessionUuids = routingBaseSessionUuid
      ? Array.from(
          new Set(
            Object.values(selectionSessionManager?.getDeviceLabels(routingBaseSessionUuid) ?? {}),
          ),
        )
      : [];
    return {
      tools: (
        await Promise.all(
          definitions.map(async (definition) => {
            const registeredTool = ToolRegistry.getTool(definition.name);
            const deviceAware = registeredTool?.requiresDevice ?? false;
            const candidateRoutes =
              deviceAware && labelSessionUuids.length > 0
                ? labelSessionUuids.map((labelSessionUuid) => [
                    routingBaseSessionUuid,
                    labelSessionUuid,
                  ])
                : [[routingBaseSessionUuid, routingSessionUuid]];
            return (await isToolEnabledForAnyRoute(
              definition.name,
              registeredTool?.defaultEnabled ?? true,
              candidateRoutes,
              options.sessionToolSelectionService,
              connectionProfileUuid,
            ))
              ? definition
              : undefined;
          }),
        )
      ).filter(
        (definition): definition is (typeof definitions)[number] => definition !== undefined,
      ),
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
  const ListPromptsRequestSchema =
    require("@modelcontextprotocol/sdk/types.js").ListPromptsRequestSchema;
  server.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [],
    };
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Revive non-finite arguments the daemon client encoded as sentinels so they
    // survive the socket + loopback-HTTP hops (#5854 §2). Done BEFORE logging and
    // validation so the request trace shows the real Infinity/-Infinity/NaN
    // instead of `null`, and the schema rejects it with "must be a finite number".
    // Scoped by transport provenance (#5863, hardened #5919): revival runs only for
    // daemon-forwarded requests. `daemonMode` is a server-CONSTRUCTION boundary the
    // tool caller cannot influence, so a direct in-memory / stdio client
    // (`daemonMode: false`) can never assert daemon transport provenance by forging
    // the in-arguments flag — its arguments are left untouched regardless. Sentinel
    // encoding is only ever performed by the daemon client (`daemon/client.ts`),
    // whose requests always terminate at this `daemonMode: true` loopback server, so
    // gating reverts nothing legitimate. `reviveNonFiniteArguments` still strips the
    // flag when present; a forged flag on a direct server is stripped instead by
    // `stripInternalToolParams` before the tool runs.
    if (daemonMode && request.params && request.params.arguments) {
      request.params.arguments = reviveNonFiniteArguments(request.params.arguments) as Record<
        string,
        unknown
      >;
    }
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
    let connectionProfileUuid = sessionToolBinding.connectionToolSelectionProfileUuid(sessionId);
    const rawRequestedToolSelectionProfileUuid = (toolParams as Record<string, unknown>)
      .sessionUuid;
    const requestedToolSelectionProfileUuid =
      typeof rawRequestedToolSelectionProfileUuid === "string"
        ? rawRequestedToolSelectionProfileUuid
        : undefined;

    // Get the registered tool
    const tool = ToolRegistry.getTool(name);
    if (!tool) {
      throw new ActionableError(`Unknown tool: ${name}`);
    }
    // An omitted selection target always belongs to an independent
    // transport-local profile, even after device routing binds. Device-session
    // release must not erase choices for a still-open MCP connection.
    if (
      name === SET_TOOL_ENABLED_TOOL_NAME &&
      !connectionProfileUuid &&
      !requestedToolSelectionProfileUuid?.trim().length
    ) {
      connectionProfileUuid = sessionToolBinding.createAndBindToolSelectionProfile(sessionId);
    }
    // Tool selection honors the UNION of the base and the derived
    // `${base}:${label}` device-label sessions (issue #4611): a tool is enabled
    // when EITHER grants it. This public MCP boundary is an EARLIER gate than the
    // only public-call enforcement boundary. Resolve the derived
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
    const rawRequestedDeviceLabel = (toolParams as Record<string, unknown>).device;
    const requestedDeviceLabel =
      typeof rawRequestedDeviceLabel === "string" && rawRequestedDeviceLabel.trim().length > 0
        ? rawRequestedDeviceLabel
        : undefined;
    const selectionSessionManager =
      options.toolSelectionSessionManager ??
      (DaemonState.getInstance().isInitialized()
        ? DaemonState.getInstance().getSessionManager()
        : undefined);
    const routingBaseSessionUuid = resolveToolSelectionBaseSessionUuid(
      routingSessionUuid,
      selectionSessionManager,
    );
    const derivedLabelSessionUuid =
      tool.requiresDevice && requestedDeviceLabel && routingBaseSessionUuid
        ? selectionSessionManager?.getDeviceLabels(routingBaseSessionUuid)?.[requestedDeviceLabel]
        : undefined;
    // Tool selection follows the connection's routing profile. A raw deviceId is
    // only an execution target and must not borrow an unrelated owning session's
    // grants (which discovery cannot advertise). When both fields are present,
    // ToolRegistry intentionally ignores deviceId in favor of the label.
    await assertToolEnabledForAnySession(
      name,
      tool.defaultEnabled,
      [
        connectionProfileUuid,
        routingBaseSessionUuid,
        ...(requestedDeviceLabel
          ? [derivedLabelSessionUuid]
          : [routingSessionUuid, derivedLabelSessionUuid]),
      ],
      options.sessionToolSelectionService,
      connectionProfileUuid,
    );

    const requestMcpSessionId = extractInternalMcpSessionId(toolParams);
    const requestTimeoutMs = extractInternalMcpRequestTimeoutMs(toolParams);
    const implicitAutolockMcpSessionId =
      requestMcpSessionId ?? (!daemonMode ? sessionId : undefined);
    const rawSessionUuid =
      toolParams && typeof toolParams === "object" && "sessionUuid" in toolParams
        ? (toolParams as { sessionUuid?: string }).sessionUuid
        : undefined;
    const providedSessionUuid =
      typeof rawSessionUuid === "string" && rawSessionUuid.trim().length > 0
        ? rawSessionUuid
        : undefined;

    // Check if tool call should be blocked due to active executePlan in this session
    const decision = planExecutionLock.evaluate({
      toolName: name,
      sessionId,
      sessionUuid: providedSessionUuid ?? routingSessionUuid,
    });
    if (decision.blocked) {
      logger.warn(
        `[MCP] Rejecting tool ${name} due to active executePlan (scope=${decision.scope}, sessionId=${sessionId ?? "none"}, sessionUuid=${routingSessionUuid ?? "none"})`,
      );
      throw new ActionableError(decision.reason ?? "plan execution in progress");
    }

    // Parse and validate the parameters
    let parsedParams;
    const strippedToolParams = stripInternalToolParams(toolParams);
    try {
      parsedParams = tool.schema.parse(strippedToolParams);
    } catch (error) {
      throw new ActionableError(
        `Invalid parameters for tool ${name}: ${formatToolParamError(name, error, strippedToolParams)}`,
      );
    }

    const executionSessionUuid =
      derivedLabelSessionUuid ?? providedSessionUuid ?? routingSessionUuid;
    const handlerRoutingSessionUuid =
      tool.requiresDevice && requestedDeviceLabel && routingBaseSessionUuid
        ? routingBaseSessionUuid
        : routingSessionUuid;
    const executionSessionId = requestMcpSessionId ?? sessionId;
    const execution = executionTracker.startExecution(
      name,
      executionSessionId,
      executionSessionUuid,
      sessionId,
    );
    const requestSignal = combineAbortSignals(execution.abortController.signal, extra.signal);
    const handlerParams =
      parsedParams && typeof parsedParams === "object"
        ? {
            ...parsedParams,
            ...(implicitAutolockMcpSessionId
              ? { [INTERNAL_MCP_SESSION_PARAM]: implicitAutolockMcpSessionId }
              : {}),
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
                ...(message && { message }),
              },
            });
          } catch (error) {
            // Log progress notification errors but don't fail the tool execution
            logger.warn(`Failed to send progress notification: ${error}`);
          }
        }
      : undefined;

    try {
      if (
        daemonMode &&
        providedSessionUuid &&
        !isDeviceSessionAcquisitionTool(name) &&
        name !== SET_TOOL_ENABLED_TOOL_NAME
      ) {
        // Plain tools can strip or ignore sessionUuid themselves. Admit it here so
        // an unissued UUID cannot be treated as a successful proxy binding.
        await DaemonState.getInstance()
          .getSessionManager()
          .admitIssuedSessionForAutomation(providedSessionUuid, {
            executionId: execution.id,
            startTime: execution.startTime,
          });
      }
      const result = await runWithAbortSignal(requestSignal, () =>
        runWithToolSelectionContext(
          {
            // A bound derived session may still target a sibling label. Resolve
            // that label from the base map; unlabeled calls retain the derived
            // ambient session.
            routingSessionUuid: handlerRoutingSessionUuid,
            execution: {
              executionId: execution.id,
              startTime: execution.startTime,
            },
            // A routing session already carries its own base/label union in
            // ToolRegistry. Carry only a distinct connection profile so it
            // cannot suppress that derived-label resolution.
            toolSelectionProfileUuid: connectionProfileUuid,
            // Keep profile persistence lazy for ordinary core-tool calls while
            // giving an admitted plan its service instance for release cleanup.
            sessionToolSelectionService:
              options.sessionToolSelectionService ??
              (name === "executePlan" ? getSessionToolSelectionService() : undefined),
          },
          () => tool.handler(handlerParams, progressCallback, requestSignal),
        ),
      );
      if (
        isDeviceSessionAcquisitionTool(name) &&
        sessionToolBinding.bind(sessionId, getDeviceSessionIdFromResult(result))
      ) {
        ToolRegistry.notifyToolListChanged();
      }
      if (
        !isDeviceSessionAcquisitionTool(name) &&
        name !== SET_TOOL_ENABLED_TOOL_NAME &&
        !result?.isError &&
        providedSessionUuid &&
        (DaemonState.getInstance().isInitialized()
          ? DaemonState.getInstance()
              .getSessionManager()
              .getSessionForNewExecution(providedSessionUuid, {
                executionId: execution.id,
                startTime: execution.startTime,
              }) !== null
          : resolveDirectSessionDevice(providedSessionUuid) !== undefined) &&
        sessionToolBinding.bind(sessionId, providedSessionUuid)
      ) {
        ToolRegistry.notifyToolListChanged();
      }
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
      if (error instanceof TerminalSessionError) {
        const sessionOwnershipLost = {
          error: {
            code: "session_ownership_lost",
            message: `Session ownership lost for ${error.sessionUuid}: ${error.release.releaseReason}`,
            sessionUuid: error.sessionUuid,
            reason: error.release.releaseReason,
            release: error.release,
          },
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(sessionOwnershipLost) }],
          isError: true,
        };
      }
      const deviceLoss =
        deviceLossOutcomeFromError(error, executionSessionUuid) ??
        deviceLossOutcomeFromError(
          deviceLostErrorFromAbortSignal(execution.abortController.signal),
          executionSessionUuid,
        );
      if (deviceLoss) {
        // Recovery drains cancelled executions before rebooting. This handler's
        // remaining work only enriches the response from that same recovery, so
        // stop tracking it first to avoid making recovery wait on itself.
        executionTracker.endExecution(execution.id);
        const elapsedMs = Math.max(0, defaultTimer.now() - execution.startTime);
        const incidentWaitTimeoutMs = remainingDeviceLossIncidentWaitMs(
          requestTimeoutMs,
          elapsedMs,
        );
        const outcome = await resolveDeviceLossOutcome(deviceLoss, incidentWaitTimeoutMs);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
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

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
  type SessionToolProfileService,
} from "../features/toolCapabilities/SessionToolProfileService";
import {
  assertToolEnabledForSession,
  isToolEnabledForSession,
} from "../features/toolCapabilities/toolCapabilityPolicy";
import { runWithToolCapabilityContext } from "../features/toolCapabilities/toolCapabilityContext";

export interface McpServerOptions {
  debug?: boolean;
  sessionContext?: { sessionId?: string };
  planExecutionLock?: PlanExecutionLock;
  daemonMode?: boolean;
  sessionToolProfileService?: Pick<SessionToolProfileService, "isEnabled">;
}

const INTERNAL_MCP_SESSION_PARAM = "__mcpSessionId";
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

  if (!(INTERNAL_MCP_SESSION_PARAM in params)) {
    return params;
  }

  const rest = { ...(params as Record<string, unknown>) };
  delete rest[INTERNAL_MCP_SESSION_PARAM];
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
  const sessionToolBinding = new SessionToolBinding();
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

  // Register tool definitions using the lower-level interface
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    const sessionUuid = sessionToolBinding.effectiveSessionUuid(options.sessionContext?.sessionId);
    const definitions = ToolRegistry.getToolDefinitions();
    return {
      tools: (await Promise.all(definitions.map(async definition =>
        await isToolEnabledForSession(definition.name, sessionUuid, options.sessionToolProfileService) ? definition : undefined
      ))).filter((definition): definition is typeof definitions[number] => definition !== undefined)
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
    const sessionUuid = sessionToolBinding.effectiveSessionUuid(sessionId, toolParams);

    // Get the registered tool
    const tool = ToolRegistry.getTool(name);
    if (!tool) {
      throw new ActionableError(`Unknown tool: ${name}`);
    }
    await assertToolEnabledForSession(name, sessionUuid, options.sessionToolProfileService);

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
      sessionUuid: providedSessionUuid ?? sessionUuid,
    });
    if (decision.blocked) {
      logger.warn(
        `[MCP] Rejecting tool ${name} due to active executePlan (scope=${decision.scope}, sessionId=${sessionId ?? "none"}, sessionUuid=${sessionUuid ?? "none"})`
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

    const execution = executionTracker.startExecution(name, sessionId, providedSessionUuid ?? sessionUuid);
    const handlerParams = implicitAutolockMcpSessionId && parsedParams && typeof parsedParams === "object"
      ? { ...parsedParams, [INTERNAL_MCP_SESSION_PARAM]: implicitAutolockMcpSessionId }
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
          { sessionUuid, sessionToolProfileService: options.sessionToolProfileService },
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
    } finally {
      executionTracker.endExecution(execution.id);
    }
  });
  startupBenchmark.endPhase("serverHandlerRegistration");

  return server;
};

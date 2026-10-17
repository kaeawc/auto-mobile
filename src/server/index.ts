import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { installDefaultProvisionedDeviceTransportFence } from "../db/createDefaultProvisionedDeviceTransportFence";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { installToolCallDispatcher, type ToolCallRequest } from "./toolCallDispatch";

import { formatToolParamError } from "./toolParamError";
import { reviveNonFiniteArguments } from "../utils/nonFiniteJson";

import { logger } from "../utils/logger";

import { createDefaultPlanExecutionLock, type PlanExecutionLock } from "./PlanExecutionLock";
import { SessionToolBinding } from "./SessionToolBinding";
import { dropToolCallRecording } from "./toolCallRecordingManager";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";

import { stripInternalToolParams } from "./internalToolParams";
export { stripInternalToolParams } from "./internalToolParams";
export { enrichAcquisitionResult } from "./pipeline/ingress/acquisition";
import { createListSessionTools } from "./pipeline/ingress/listSessionTools";
import { createToolCallExecutor } from "./pipeline/ingress/executeToolCall";
import { namesLiveSessionOfBoundPlan } from "./pipeline/ingress/namesLiveSessionOfBoundPlan";

// Import the tool registry
import { ToolRegistry } from "./toolRegistry";

// Import the resource registry
import { ResourceRegistry } from "./resourceRegistry";

import { registerAllTools } from "./registerAllTools";

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
import { registerSdkCapabilityResources } from "./sdkCapabilityResources";
import { registerDataStoreResources } from "./dataStoreResources";
import { registerAppFileResources } from "./appFileResources";
import { registerSessionLogResources } from "./sessionLogResources";
import { registerSharedStorageResources } from "./sharedStorageResources";
import { registerFeatureFlagResources } from "./featureFlagResources";
import { registerPrototypeResources } from "./prototypeResources";
import { createIosDoctorDependencies, type IosDoctorDependencies } from "../doctor/checks/ios";
import { createProductionCoreDeviceProbe } from "../utils/ios-cmdline-tools/CoreDeviceProbeHolder";
import { registerHostToolchainResources } from "./hostToolchainResources";
import { registerToolCatalogResources } from "./toolCatalogResource";
import { registerNetworkResources } from "./networkResources";
import { registerEmulatorLossIncidentResources } from "./emulatorLossIncidentResources";
import { FeatureFlagService } from "../features/featureFlags/FeatureFlagService";
import { startupBenchmark } from "../utils/startupBenchmark";
import {
  type SessionToolSelectionService,
  validateConfiguredToolSelectionDefaults,
} from "../features/toolSelection/SessionToolSelectionService";

import { type ToolSelectionSessionManager } from "../features/toolSelection/selectionSessionResolver";

import { redactTypedTextArguments } from "../utils/redactTypedTextArguments";
import {
  defaultToolSelectionProfileRegistry,
  type ToolSelectionProfileRegistry,
} from "./toolSelectionProfileRegistry";

export interface McpServerOptions {
  iosDependencies?: IosDoctorDependencies;
  debug?: boolean;
  sessionContext?: {
    sessionId?: string;
    initialSessionToolBinding?: string;
    initialReleasedSession?: string;
    initialToolSelectionProfile?: string;
  };
  planExecutionLock?: PlanExecutionLock;
  daemonMode?: boolean;
  /**
   * Per-daemon live-acceptance capability captured at startup. Unlike tool
   * arguments, this is a server-construction boundary clients cannot set.
   */
  acceptanceDiscoveryCapability?: string;
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled"> &
    Partial<Pick<SessionToolSelectionService, "setEnabled" | "deleteSession" | "getOverride">>;
  toolSelectionSessionManager?: ToolSelectionSessionManager;
  /**
   * Process-wide registry of tool-selection profiles this server has minted
   * (see src/server/toolSelectionProfileRegistry.ts). Defaults to the shared
   * module singleton, which is what production needs — every `createMcpServer`
   * call inside one daemon process must share it so a profile minted on one
   * internal loopback session is still recognized on another after crossing
   * the daemon-proxy hop. Only override this in tests that must isolate
   * multiple `createMcpServer()` instances from other test files' state, or
   * that explicitly simulate that hop with more than one instance.
   */
  toolSelectionProfileRegistry?: ToolSelectionProfileRegistry;
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
  installDefaultProvisionedDeviceTransportFence();
  registerAllTools({ daemonMode });
  validateConfiguredToolSelectionDefaults(new Set(ToolRegistry.getConfigurableToolNames()));
}

function registerAllResources(iosDependencies: IosDoctorDependencies): void {
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
  registerSdkCapabilityResources();
  registerDataStoreResources();
  registerAppFileResources();
  registerSessionLogResources();
  registerSharedStorageResources();
  registerFeatureFlagResources();
  registerPrototypeResources();
  registerHostToolchainResources({ iosDependencies });
  registerToolCatalogResources();
  registerNetworkResources();
  registerEmulatorLossIncidentResources();
}

export const createMcpServer = (options: McpServerOptions = {}): McpServer => {
  const sessionToolBinding = new SessionToolBinding(
    options.sessionContext?.initialSessionToolBinding,
    options.sessionContext?.initialToolSelectionProfile,
    undefined,
    options.sessionContext?.initialReleasedSession,
    namesLiveSessionOfBoundPlan,
  );
  // Plan execution lock with per-session scope to prevent interference during executePlan
  // Each test thread gets its own sessionUuid, enabling parallel execution on different devices
  const planExecutionLock = options.planExecutionLock ?? createDefaultPlanExecutionLock();
  const daemonMode = options.daemonMode ?? false;
  const toolSelectionProfileRegistry =
    options.toolSelectionProfileRegistry ?? defaultToolSelectionProfileRegistry;
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

  const iosDependencies =
    options.iosDependencies ??
    createIosDoctorDependencies({ coreDeviceProbe: createProductionCoreDeviceProbe() });

  // Register all resources
  startupBenchmark.startPhase("resourceRegistration");
  registerAllResources(iosDependencies);
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
        resources: { subscribe: true, listChanged: true },
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
    ownsSession: (sessionUuid) =>
      sessionToolBinding.ownsSession(options.sessionContext?.sessionId, sessionUuid),
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
    if (!daemonMode) {
      dropToolCallRecording(options.sessionContext?.sessionId);
    }
    existingServerOnClose?.();
  };

  const listSessionTools = createListSessionTools({
    options,
    sessionToolBinding,
    toolSelectionProfileRegistry,
  });
  server.server.setRequestHandler(ListToolsRequestSchema, () => listSessionTools());

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

  const prepareToolCallRequest = (request: ToolCallRequest): void => {
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
    logger.info("Request: ", {
      ...request,
      params: {
        ...request.params,
        // Typed text is redacted: nobody knows yet whether the target is a password field.
        arguments: redactTypedTextArguments(
          request.params.name,
          stripInternalToolParams(request.params.arguments),
        ),
      },
    });
  };

  const executeToolCall = createToolCallExecutor({
    options,
    daemonMode,
    sessionToolBinding,
    planExecutionLock,
    toolSelectionProfileRegistry,
    listSessionTools,
  });
  installToolCallDispatcher(server, {
    progressFailureMessage: "Failed to send progress notification",
    prepare: prepareToolCallRequest,
    execute: executeToolCall,
  });
  startupBenchmark.endPhase("serverHandlerRegistration");

  return server;
};

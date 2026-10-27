import { clientAdvertisesMcpApps } from "./mcpAppsSupport";
import { DeviceReadiness } from "../daemon/readiness/DeviceReadiness";
import type { ListToolsResult, McpServer, ServerCapabilities } from "@modelcontextprotocol/server";
import { createSdkMcpServer } from "./sdkMcpServer";
import { MODERN_CACHE_HINTS } from "./modernCacheHints";
import { installDefaultProvisionedDeviceTransportFence } from "../db/createDefaultProvisionedDeviceTransportFence";

import { installToolCallDispatcher, type ToolCallRequest } from "./toolCallDispatch";

import { formatToolParamError } from "./toolParamError";
import { reviveNonFiniteArguments } from "../utils/nonFiniteJson";

import { logger } from "../utils/logger";

import { createDefaultPlanExecutionLock, type PlanExecutionLock } from "./PlanExecutionLock";
import { SessionToolBinding } from "./SessionToolBinding";
import type { SessionToolBindingStore } from "./sessionToolBindingStore";
import {
  createReleaseSubscribedBindingStore,
  daemonSessionToolBindingStore,
} from "./daemonSessionToolBindingStore";
import { dropToolCallRecording } from "../daemon/toolCallRecordingManager";

import { stripInternalToolParams } from "./internalToolParams";
export { stripInternalToolParams } from "./internalToolParams";
export { enrichAcquisitionResult } from "./pipeline/ingress/acquisition";
import { createListSessionTools } from "./pipeline/ingress/listSessionTools";
import { createToolCallExecutor } from "./pipeline/ingress/executeToolCall";
import { daemonTaskManager } from "../daemon/tasks/daemonTaskManager";
import { TASKS_EXTENSION_ID } from "../daemon/tasks/mcpTasksExtension";
import { installTasksProtocol } from "./tasks/installTasksProtocol";
import type { TaskManager } from "../daemon/tasks/TaskManager";
import type { TaskLeaseKeepalive } from "../daemon/tasks/taskLeaseKeepalive";
import {
  createTaskAwareToolCallExecutor,
  TASK_ELIGIBILITY,
  type TaskEligibility,
} from "./tasks/toolCallTasks";
import { namesLiveSessionOfBoundPlan } from "./pipeline/ingress/namesLiveSessionOfBoundPlan";

// Import the tool registry
import { ToolRegistry } from "./toolRegistry";
import { createRecording } from "./deviceMutationRecording";
import { defaultDaemonContext } from "../daemon/daemonContext";
import { AndroidCtrlProxyClient } from "../features/observe/android/AndroidCtrlProxyClient";

// Import the resource registry
import { ResourceRegistry } from "./resourceRegistry";

import { registerAllTools } from "./registerAllTools";
import { IOSCtrlProxyClient } from "../features/observe/ios";

import { getMcpServerVersion } from "../utils/mcpVersion";

// Import resource registration functions
import { registerObservationResources } from "./observationResources";
import { registerToolOutputResources } from "./toolOutputResources";
import { registerObserveAppResource } from "./observeAppResource";
import { registerBootedDeviceResources } from "./bootedDeviceResources";
import { registerDeviceImageResources } from "./deviceImageResources";
import { registerAppResources, syncInstalledAppResources } from "./appResources";
import { registerInstalledAppResourceListRefresher } from "./installedAppResourceResync";
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
import { registerCrashReportResources } from "./crashReportResources";
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
import { registerDeviceConditionFeatureFlags } from "./deviceConditionTool";
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
} from "../daemon/toolSelectionProfileRegistry";

export interface McpServerOptions {
  era?: "legacy" | "modern";
  deviceReadiness?: DeviceReadiness;
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
   * The request's session key (#4678): the `MCP_SESSION_KEY_HEADER` value the
   * daemon's HTTP endpoint read for this request. Session-tool bindings are keyed
   * on it, so a binding survives across per-request servers that present the same key.
   * The header wins over an in-band `__mcpSessionId` unless {@link trustForwardedMcpSessionId}
   * is set (#13315).
   */
  requestMcpSessionId?: string;
  /**
   * The server answers the daemon's own in-process forward (stdio proxy / socket-forwarded
   * calls): the in-band `__mcpSessionId` it carries names the originating client and takes
   * precedence over {@link requestMcpSessionId}, the connection key. Never set for direct HTTP
   * clients, whose in-band id is only a fallback when they sent no header (#13315).
   */
  trustForwardedMcpSessionId?: boolean;
  /**
   * The server answers a single request and is closed after it (#4678). Keyed
   * bindings then live in the daemon-scoped {@link daemonSessionToolBindingStore}
   * instead of a store private to this server.
   */
  stateless?: boolean;
  /** Overrides where keyed bindings live; tests share one store across servers. */
  sessionToolBindingStore?: SessionToolBindingStore;
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
  /**
   * MCP Tasks extension (#4668). The daemon serves tasks from its daemon-scoped manager;
   * direct stdio does not. Tests inject a manager, the eligible tools and the keepalive.
   */
  taskManager?: TaskManager;
  /**
   * Who owns the tasks this server creates and serves, when not the request's session key: a
   * control-socket forward from the stdio proxy names the proxy, so its tasks survive the proxy's
   * reconnects (a socket session id does not).
   */
  taskOwnerKey?: string;
  taskEligibleTools?: TaskEligibility;
  taskLeaseKeepalive?: TaskLeaseKeepalive;
}

// `formatToolParamError` lives in its own module so non-server callers (e.g.
// PlanExecutor, #5854 §3) can share the exact MCP-boundary rendering without
// importing the whole server entrypoint (which would be circular). Re-exported
// here to preserve the historical import path used by existing tests.
export { formatToolParamError };

let lastToolRegistration: { daemonMode: boolean; removalEpoch: number } | undefined;

/**
 * Populate the canonical production registry and validate exact-tool startup
 * defaults. The process entrypoint calls this before opening daemon listeners;
 * createMcpServer calls it again because tests and embedded consumers may create
 * a server directly. Registration is idempotent because the registry is keyed
 * by exact tool name.
 */
export function registerMcpTools(daemonMode: boolean): void {
  installDefaultProvisionedDeviceTransportFence();
  // Re-registering rebuilds every definition and drops the tool-schema cache, which a
  // stateless endpoint (one createMcpServer per request) would pay on every tools/list.
  // The registered set only changes when something is removed, so skip while the
  // same mode's set is still present. Session-gated tools are unaffected: callability
  // is evaluated per request against the registry, not captured at registration.
  const removalEpoch = ToolRegistry.removalEpochForRegistration;
  if (
    lastToolRegistration?.daemonMode !== daemonMode ||
    lastToolRegistration.removalEpoch !== removalEpoch
  ) {
    registerAllTools({
      daemonMode,
      iosRunnerLocation: (device) => IOSCtrlProxyClient.getInstance(device),
    });
    lastToolRegistration = { daemonMode, removalEpoch: ToolRegistry.removalEpochForRegistration };
  }
  validateConfiguredToolSelectionDefaults(new Set(ToolRegistry.getConfigurableToolNames()));
}

let lastResourceRegistration:
  | { iosDependencies: IosDoctorDependencies; clearEpoch: number }
  | undefined;

/**
 * Register every resource once per process (#13068). The registry is keyed by URI, so
 * re-registering is redundant, and registering app resources starts a booted-device
 * discovery (adb + simctl), which every stateless request (#4678) used to pay. Device
 * inventory changes resync app resources through the device lifecycle instead.
 */
function registerAllResourcesOnce(iosDependencies: IosDoctorDependencies): void {
  if (
    lastResourceRegistration?.iosDependencies === iosDependencies &&
    lastResourceRegistration.clearEpoch === ResourceRegistry.clearEpochForRegistration
  ) {
    return;
  }
  registerAllResources(iosDependencies);
  lastResourceRegistration = {
    iosDependencies,
    clearEpoch: ResourceRegistry.clearEpochForRegistration,
  };
}

function registerAllResources(iosDependencies: IosDoctorDependencies): void {
  registerObservationResources();
  registerToolOutputResources();
  registerObserveAppResource();
  registerBootedDeviceResources();
  registerDeviceImageResources();
  registerAppResources();
  registerInstalledAppResourceListRefresher(() => syncInstalledAppResources());
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
  registerCrashReportResources();
  registerSharedStorageResources();
  registerFeatureFlagResources();
  registerPrototypeResources();
  registerHostToolchainResources({ iosDependencies });
  registerToolCatalogResources();
  registerNetworkResources();
  registerEmulatorLossIncidentResources();
}

/**
 * The key this server's request-less paths (tools/list, resources) bind under:
 * the request's session key, else the stateful transport's own session id.
 */
function serverBindingKey(options: McpServerOptions): string | undefined {
  return options.requestMcpSessionId ?? options.sessionContext?.sessionId;
}

/**
 * The session key a request's tasks belong to (#4668): the explicit key header on a stateless
 * daemon server (its scope id is one-off and would orphan the task), else the stateful
 * transport's session id. Keyless stateless requests own no tasks and run synchronously.
 */
function taskOwnerKey(options: McpServerOptions): string | undefined {
  if (options.taskOwnerKey?.trim()) {
    return options.taskOwnerKey;
  }
  const key = options.stateless ? options.requestMcpSessionId : serverBindingKey(options);
  return key?.trim() ? key : undefined;
}

function resolveTaskManager(options: McpServerOptions): TaskManager | undefined {
  return options.taskManager ?? (options.daemonMode ? daemonTaskManager() : undefined);
}

/**
 * Serves the Tasks extension on this server when a task manager is available, and wraps the
 * `tools/call` executor so an eligible tool can answer a declaring request with a task.
 */
function installTasks(
  server: McpServer,
  options: McpServerOptions,
  execute: ReturnType<typeof createToolCallExecutor>,
): ReturnType<typeof createTaskAwareToolCallExecutor> {
  const taskManager = resolveTaskManager(options);
  const ownerKey = taskOwnerKey(options);
  if (taskManager) {
    installTasksProtocol(server, { taskManager, ownerKey });
  }
  return createTaskAwareToolCallExecutor({
    execute,
    taskManager,
    ownerKey,
    eligibleTools: options.taskEligibleTools ?? TASK_ELIGIBILITY,
    ...(options.taskLeaseKeepalive && { keepalive: options.taskLeaseKeepalive }),
  });
}

function resolveBindingStore(options: McpServerOptions): {
  store: SessionToolBindingStore;
  owned: boolean;
} {
  if (options.sessionToolBindingStore) {
    return { store: options.sessionToolBindingStore, owned: false };
  }
  if (options.daemonMode && options.stateless) {
    return { store: daemonSessionToolBindingStore(), owned: false };
  }
  return { store: createReleaseSubscribedBindingStore(), owned: true };
}

function installDeviceReadiness(options: McpServerOptions): void {
  if (options.deviceReadiness) {
    ToolRegistry.setDeviceReadiness(options.deviceReadiness);
  } else if (!options.daemonMode && !ToolRegistry.hasDeviceReadiness()) {
    // An embedded direct-mode server that injects none still needs one for setActiveDevice and
    // device tools; the daemon and the stdio entrypoint install their own (#14843).
    ToolRegistry.setDeviceReadiness(DeviceReadiness.createInstance());
  }
}

/**
 * The capabilities one request's server advertises. A modern request has no notification stream
 * until subscriptions/listen is wired (#13947), so it claims no resource subscriptions.
 */
function sdkServerCapabilities(era: McpServerOptions["era"]): ServerCapabilities {
  return {
    resources: era === "modern" ? { listChanged: true } : { subscribe: true, listChanged: true },
    tools: era === "modern" ? { listChanged: true } : {},
    prompts: {},
    ...(era === "modern" && { extensions: { [TASKS_EXTENSION_ID]: {} } }),
  };
}

export const createMcpServer = (options: McpServerOptions = {}): McpServer => {
  ToolRegistry.setMutationRecording(
    createRecording(defaultDaemonContext, {
      keyboardProfilesFor: (device) => AndroidCtrlProxyClient.getInstance(device),
    }),
  );
  installDeviceReadiness(options);
  const bindingStore = resolveBindingStore(options);
  const sessionToolBinding = new SessionToolBinding(
    options.sessionContext?.initialSessionToolBinding,
    options.sessionContext?.initialToolSelectionProfile,
    undefined,
    options.sessionContext?.initialReleasedSession,
    namesLiveSessionOfBoundPlan,
    bindingStore.store,
  );
  const bindingKey = serverBindingKey(options);
  // Plan execution lock with per-session scope to prevent interference during executePlan
  // Each test thread gets its own sessionUuid, enabling parallel execution on different devices
  const planExecutionLock = options.planExecutionLock ?? createDefaultPlanExecutionLock();
  const daemonMode = options.daemonMode ?? false;
  const toolSelectionProfileRegistry =
    options.toolSelectionProfileRegistry ?? defaultToolSelectionProfileRegistry;
  registerDeviceConditionFeatureFlags(FeatureFlagService.getInstance());
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
  registerAllResourcesOnce(iosDependencies);
  startupBenchmark.endPhase("resourceRegistration");

  // Create a new MCP server
  startupBenchmark.startPhase("sdkInitialization");
  const server = createSdkMcpServer(
    {
      name: "AutoMobile",
      version: getMcpServerVersion(),
    },
    sdkServerCapabilities(options.era),
    options.era === "modern" ? MODERN_CACHE_HINTS : undefined,
  );
  startupBenchmark.endPhase("sdkInitialization");

  // Register all tools with the server
  startupBenchmark.startPhase("serverHandlerRegistration");
  // A stateless server answers one request: track it only until it closes and never
  // notify it (#4678).
  const registration = { ephemeral: options.stateless === true };
  ToolRegistry.registerWithServer(server, registration);

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
  ResourceRegistry.registerWithServer(
    server,
    (signal) => ({
      sessionUuid: sessionToolBinding.effectiveSessionUuid(bindingKey),
      ownsSession: (sessionUuid) => sessionToolBinding.ownsSession(bindingKey, sessionUuid),
      releasedSessionUuid: sessionToolBinding.releasedResourceSessionUuid(bindingKey),
      signal,
      clientSupportsApps: clientAdvertisesMcpApps(server.server.getClientCapabilities()),
    }),
    registration,
  );

  if (registration.ephemeral) {
    // A server closed before it connects has no transport, so the SDK never fires
    // onclose and the prune hooks would leave it tracked forever.
    const closeServer = server.close.bind(server);
    server.close = async () => {
      try {
        await closeServer();
      } finally {
        // A never-connected server never fires onclose, which is what detaches its binding.
        sessionToolBinding.dispose();
        ToolRegistry.untrackServer(server);
        ResourceRegistry.untrackServer(server);
      }
    };
  }

  // Release teardown is subscribed by the binding store, once per store (see
  // createReleaseSubscribedBindingStore); this server's binding is attached to it
  // until the transport closes. Chain onto the existing onclose (set by
  // ToolRegistry.registerWithServer's server tracking) so no other lifecycle hook
  // is clobbered. A shared store keeps its keyed bindings and its subscription.
  const existingServerOnClose = server.server.onclose;
  server.server.onclose = () => {
    sessionToolBinding.dispose();
    if (bindingStore.owned) {
      bindingStore.store.dispose();
    }
    if (!daemonMode) {
      dropToolCallRecording(options.sessionContext?.sessionId);
    }
    existingServerOnClose?.();
  };

  const listSessionTools = createListSessionTools({
    options,
    bindingKey,
    sessionToolBinding,
    toolSelectionProfileRegistry,
  });
  // The advertised definitions are built from our own JSON Schemas, which the SDK
  // types only as `Record<string, unknown>`; the wire value is unchanged.
  server.server.setRequestHandler(
    "tools/list",
    async () => (await listSessionTools()) as ListToolsResult,
  );

  // Add ping handler as per MCP specification
  server.server.setRequestHandler("ping", async () => {
    return {};
  });

  // Register prompts list handler (currently returns empty list since no prompts are implemented)
  server.server.setRequestHandler("prompts/list", async () => {
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
    serverBindingKey: bindingKey,
    sessionToolBinding,
    planExecutionLock,
    toolSelectionProfileRegistry,
    listSessionTools,
  });
  installToolCallDispatcher(server, {
    progressFailureMessage: "Failed to send progress notification",
    prepare: prepareToolCallRequest,
    execute: installTasks(server, options, executeToolCall),
  });
  startupBenchmark.endPhase("serverHandlerRegistration");

  return server;
};

/** Refresh externally changed resource rosters before a cached control-socket discovery reply. */
export function refreshMcpResourceList(): Promise<void> {
  return ResourceRegistry.refreshBeforeList();
}

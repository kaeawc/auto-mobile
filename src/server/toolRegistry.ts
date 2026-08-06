import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJSONSchema } from "zod";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import { ActionableError, BootedDevice, SomePlatform } from "../models";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { UIStateExtractor } from "../features/navigation/UIStateExtractor";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { serverConfig } from "../utils/ServerConfig";
import { MemoryAudit } from "../features/memory/MemoryAudit";
import { TelemetryRecorder } from "../features/telemetry/TelemetryRecorder";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { logger, type Logger } from "../utils/logger";
import { DaemonState } from "../daemon/daemonState";
import { createToolExecutionContext } from "./ToolExecutionContext";
import { AppCleanupService, DefaultAppCleanupService } from "./AppCleanupService";
import { ToolCallRepository } from "../db/toolCallRepository";
import { getDeviceLabelMap, releaseDeviceLabelSessions } from "./deviceLabelMapping";
import { isDevicePoolAutolockEnabled } from "../daemon/poolConfig";
import { isDebugModeEnabled } from "../utils/debug";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getMcpRecorder } from "./mcpRecordingManager";
import { formatToolResultLog } from "./toolResultLog";
import { formatStructuredToolError } from "../utils/formatStructuredToolError";
import { flattenTopLevelUnion } from "./TopLevelUnionFlattener";
import { advertiseBoundsForCompact } from "./compactBoundsAdvertisement";
import { finalizeToolResponse, type ObservationArtifactWriter, type ObservationBaselineStore } from "./finalizeToolResponse";
import { INTERNAL_NO_DIFF_PARAM, markInternalToolCall } from "./internalToolCall";
import { ListChangedBroadcaster } from "./listChangedBroadcast";
import { getStructuredField, StructuredToolResponse } from "../utils/toolUtils";
import { applyJsonSchemaOverride, isInjectedDeviceIdSchema } from "./toolSchemaHelpers";
import {
  InternalToolName,
  InternalToolPayloads,
  narrowInternalToolEnvelope,
} from "./internalToolPayloads";
import { JsonToolOutputArtifactWriter, type ToolOutputArtifactRetention } from "./toolOutputArtifactWriter";
import { getDefaultToolOutputsDir } from "../utils/toolOutputArtifacts";
import type { SessionToolProfileService } from "../features/toolCapabilities/SessionToolProfileService";
import {
  assertToolEnabledForAnySession,
} from "../features/toolCapabilities/toolCapabilityPolicy";
import { resolveCapabilityBaseSessionUuid } from "../features/toolCapabilities/capabilitySessionResolver";
import {
  getToolCapabilityContext,
  runWithToolCapabilityContext,
} from "../features/toolCapabilities/toolCapabilityContext";
import { isDeviceLostError } from "./deviceLossOutcome";

// Re-exported for backward compatibility; the implementation now lives in
// ./TopLevelUnionFlattener so the schema-flattening concern is independently testable.
export { flattenTopLevelUnion } from "./TopLevelUnionFlattener";

function toAdvertisedJsonSchema(schema: any): Record<string, unknown> {
  return flattenTopLevelUnion(toJSONSchema(schema, {
    override: ({ zodSchema, jsonSchema }) => {
      applyJsonSchemaOverride(zodSchema, jsonSchema);
      if (isInjectedDeviceIdSchema(zodSchema)) {
        const properties = jsonSchema.properties as Record<string, unknown> | undefined;
        if (properties) {
          delete properties.deviceId;
        }
      }
    },
  }));
}

// Progress notification interface
export interface ProgressCallback {
  (progress: number, total?: number, message?: string): Promise<void>;
}

// Interface for tool handlers
interface ToolHandler<T = any> {
  (args: T, progress?: ProgressCallback, signal?: AbortSignal): Promise<any>; // Using any since the actual type varies between text and image responses
}

// Interface for device-aware tool handlers
interface DeviceAwareToolHandler<T = any> {
  (device: BootedDevice, args: T, progress?: ProgressCallback, signal?: AbortSignal): Promise<any>;
}

interface InternalToolCallOptions {
  forPlan?: boolean;
  sessionUuid?: string;
  targetDevice?: BootedDevice;
  sessionToolProfileService?: Pick<SessionToolProfileService, "isEnabled">;
}

interface InternalToolInvocationContext {
  args: Record<string, unknown>;
  routingSessionUuid?: string;
  capabilitySessionUuid?: string;
  planCapabilitiesAuthorized: boolean;
  sessionToolProfileService?: Pick<SessionToolProfileService, "isEnabled">;
}

// Gate reason emitted for `planOnly` tools — hidden from discovery by design,
// expected in plans (so getToolForPlan does not warn about it).
const PLAN_ONLY_GATE_REASON = "plan-only tool";

function preservesPlanCapabilityAuthorization(
  toolName: string,
  parentAuthorized: boolean | undefined,
): boolean {
  return parentAuthorized === true || toolName === "executePlan";
}

interface ToolRegistrationOptions {
  supportsProgress?: boolean;
  debugOnly?: boolean;
  outputSchema?: any;
  /** Accept the plan executor's internal coordination namespace. */
  acceptsPlanLockNamespace?: boolean;
  /**
   * MCP Apps UI resource this tool renders through (issue #4669). When set, the
   * tool definition advertises it as `_meta.ui.resourceUri`; additive and
   * ignored by non-Apps hosts.
   */
  appUiResourceUri?: string;
}

interface DeviceAwareToolOptions<T = any> extends ToolRegistrationOptions {
  shouldEnsureDevice?: (args: T) => boolean;
  nonDeviceHandler?: ToolHandler<T>;
  embeddedSdkOnly?: boolean;
  planExecutable?: boolean;
  // Hide from normal MCP discovery (tools/list) unconditionally, but keep the
  // tool runnable inside plans (pair with planExecutable). For coordination
  // primitives an interactive agent can never sensibly call directly.
  planOnly?: boolean;
}

interface ToolListingOptions {
  includeUnavailable?: boolean;
}

interface CachedToolDefinitionSchemas {
  inputSchema: Record<string, unknown>;
  outputSchemasByRuntimeFlags: Map<string, Record<string, unknown> | undefined>;
}

// Interface for a registered tool
export interface RegisteredTool {
  name: string;
  description: string;
  schema: any;
  handler: ToolHandler;
  supportsProgress?: boolean;
  requiresDevice?: boolean;
  deviceAwareHandler?: DeviceAwareToolHandler;
  debugOnly?: boolean;
  embeddedSdkOnly?: boolean;
  planExecutable?: boolean;
  planOnly?: boolean;
  acceptsPlanLockNamespace?: boolean;
  outputSchema?: any;
  appUiResourceUri?: string;
}

/**
 * Whether a tool declares an `outputSchema`. The single source of truth for the
 * `structuredContent` gate (issues #2899 + #2759): both the wire-boundary strip
 * (`stripToolResultStructuredContent` in `index.ts`) and the `tools/list`
 * advertisement (`getToolDefinitions`) key off this so the wire result and the
 * advertised schema can never disagree. `outputSchema` is always either a Zod
 * schema object or `undefined`.
 */
export function toolHasOutputSchema(tool: Pick<RegisteredTool, "outputSchema">): boolean {
  return tool.outputSchema !== undefined && tool.outputSchema !== null;
}

interface ExecutionTargetInput {
  name: string;
  args: any;
  options: DeviceAwareToolOptions;
  deviceSessionManager: DeviceSessionManager;
}

interface ExecutionTargetContext {
  args: any;
  baseSessionUuid: string | undefined;
  // Capability enforcement session (issue #4611 Gap A). Distinct from the
  // routing `sessionUuid`: for a deviceId-only call there is no routing session,
  // so this is derived from the device's owning session and enforcement still
  // applies. May be a derived `${base}:${label}` label session. Optional so
  // test pipeline overrides need not set it (the assert falls back to
  // `sessionUuid`).
  capabilitySessionUuid?: string | undefined;
  device: BootedDevice | undefined;
  internalCall: boolean;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
}

interface ExecutionTargetResolver {
  resolveExecutionTarget(input: ExecutionTargetInput): Promise<ExecutionTargetContext>;
}

export interface AuditRunnerInput {
  name: string;
  args: any;
  device: BootedDevice;
  handler: DeviceAwareToolHandler;
  progress?: ProgressCallback;
  signal?: AbortSignal;
}

interface AuditRunner {
  run(input: AuditRunnerInput): Promise<any>;
}

interface NavigationToolCallRecorder {
  record(name: string, args: any, device: BootedDevice | undefined, sessionUuid: string | undefined): void;
}

interface AfterToolCallInput {
  name: string;
  args: any;
  device: BootedDevice | undefined;
  internalCall: boolean;
  response: any;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
  signal?: AbortSignal;
  timer: Timer;
  toolStartMs: number;
}

interface AfterToolCallResult {
  durationMs: number;
  finalizedResponse: any;
}

interface AfterToolCallHandler {
  handle(input: AfterToolCallInput): Promise<AfterToolCallResult>;
}

type ObservationArtifactWriterFactory = (
  outputDirectory: string,
  timer: Timer,
  retention?: ToolOutputArtifactRetention
) => ObservationArtifactWriter;

const AUTOMATIC_TOOL_OUTPUT_RETENTION: ToolOutputArtifactRetention = {
  maxAgeMs: 24 * 60 * 60 * 1000,
  maxFiles: 500,
  overflowMinAgeMs: 60 * 60 * 1000,
};

/**
 * Server-side session-binding teardown seam (issue #4611 Gap D). A daemon
 * session release (e.g. an executePlan auto-release) frees the session in the
 * SessionManager/DevicePool but cannot, by itself, reach the per-transport
 * `SessionToolBinding` held in `createMcpServer` (index.ts) — that binding still
 * resolves the released session as the transport's effective session, so a later
 * sessionless `tools/list`/`tools/call` keeps enforcing the released (stale)
 * profile. `createMcpServer` registers a handler here (interface + fake per DI
 * convention) so the actual release path can clear its transport binding.
 */
export interface SessionBindingReleaseHandler {
  onSessionReleased(sessionUuid: string): void;
}

export interface PlanLifecycleInput {
  name: string;
  args: any;
  baseSessionUuid: string | undefined;
  cleanupService: AppCleanupService;
  device: BootedDevice | undefined;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
  // Injected teardown for the server-side per-transport SessionToolBinding
  // (issue #4611 Gap D). Invoked AFTER a real release for every session freed —
  // base and derived label sessions alike — never optimistically.
  sessionBindingReleaseHandler?: SessionBindingReleaseHandler;
  /** Removes persisted capability overrides for sessions actually released. */
  sessionToolProfileService?: Partial<Pick<SessionToolProfileService, "deleteSession">>;
}

interface PlanLifecycleManager {
  afterExecution(input: PlanLifecycleInput): Promise<void>;
}

interface ToolRegistryPipelineOverrides {
  executionTargetResolver?: ExecutionTargetResolver;
  auditRunner?: AuditRunner;
  afterToolCall?: AfterToolCallHandler;
  planLifecycleManager?: PlanLifecycleManager;
}

class DefaultExecutionTargetResolver implements ExecutionTargetResolver {
  constructor(private readonly logger: Logger = logger) {}
  async resolveExecutionTarget(input: ExecutionTargetInput): Promise<ExecutionTargetContext> {
    const { name, args, options, deviceSessionManager } = input;
    const shouldResolveDevice = options.shouldEnsureDevice
      ? options.shouldEnsureDevice(args)
      : true;

    // Extract internal routing params from args.
    // If you add new injected params here, also update INTERNAL_PARAMS in
    // src/features/record/McpCallRecorder.ts so they are stripped from recordings.
    let providedDeviceId = args.deviceId;
    const baseSessionUuid = args.sessionUuid;
    const deviceLabel = typeof args.device === "string" ? args.device : undefined;
    const declaredDeviceLabels = Array.isArray(args.devices) ? args.devices : undefined;
    const mcpSessionId = typeof args.__mcpSessionId === "string" ? args.__mcpSessionId : undefined;
    // Internal tool-to-tool marker (#3053 / #3087): internal callers (PlanExecutor
    // steps, navigation/setup replays) set this via `markInternalToolCall` so a
    // plan/navigation step's finalized envelope is never diffed/stripped and never
    // advances the agent-facing diff baseline (a future internal
    // `.observation.viewHierarchy` reader stays correct).
    const internalCall = args[INTERNAL_NO_DIFF_PARAM] === true;
    let sessionUuid = baseSessionUuid;
    const keepScreenAwake = typeof args.keepScreenAwake === "boolean" ? args.keepScreenAwake : undefined;

    if (deviceLabel && shouldResolveDevice) {
      if (!DaemonState.getInstance().isInitialized()) {
        throw new ActionableError("Device labels require an active daemon session.");
      }
      if (!baseSessionUuid) {
        throw new ActionableError(`Device label '${deviceLabel}' requires sessionUuid to be provided.`);
      }

      const deviceLabelMap = getDeviceLabelMap(baseSessionUuid);
      if (deviceLabelMap) {
        const mappedSession = deviceLabelMap[deviceLabel];
        if (!mappedSession) {
          const available = Object.keys(deviceLabelMap);
          const suffix = available.length > 0 ? ` Available labels: ${available.join(", ")}` : "";
          throw new ActionableError(`Unknown device label '${deviceLabel}'.${suffix}`);
        }
        sessionUuid = mappedSession;
      } else if (name === "executePlan" && declaredDeviceLabels?.includes(deviceLabel)) {
        sessionUuid = baseSessionUuid;
      } else {
        throw new ActionableError(
          `Device label '${deviceLabel}' is not allocated. Provide a devices list to executePlan before using device labels.`
        );
      }

      if (providedDeviceId) {
        logger.warn(`[ToolRegistry] Ignoring deviceId because device label '${deviceLabel}' was provided.`);
        providedDeviceId = undefined;
      }
    }

    // Extract platform from args, default to "either" for backward compatibility
    let platform: SomePlatform = args.platform || "either";

    if (shouldResolveDevice) {
      const implicitSessionUuid = this.resolveImplicitAutolockSession(platform, sessionUuid, providedDeviceId, mcpSessionId);
      if (implicitSessionUuid) {
        sessionUuid = implicitSessionUuid;
        logger.info(`[ToolRegistry] Resolved implicit autolock session for MCP session ${mcpSessionId}: ${implicitSessionUuid}`);
      }
      if (sessionUuid) {
        // Handlers must use the resolved label or implicit session, not the
        // caller's base session, so session-scoped state stays on the device
        // that ToolRegistry selected.
        args.sessionUuid = sessionUuid;
      }
      await this.enforceSessionUuidForMultipleIos(platform, sessionUuid, providedDeviceId, deviceSessionManager);
      await this.enforceSessionUuidForAutolock(platform, sessionUuid, providedDeviceId, deviceSessionManager);
    }

    logger.info(`[ToolRegistry] Tool ${name} called, sessionUuid=${sessionUuid}, daemonInitialized=${DaemonState.getInstance().isInitialized()}`);

    // If session UUID provided, resolve device from session
    if (shouldResolveDevice && sessionUuid && DaemonState.getInstance().isInitialized()) {
      logger.info(`[ToolRegistry] Entering session-based device assignment for ${sessionUuid}`);
      const sessionManager = DaemonState.getInstance().getSessionManager();
      const devicePool = DaemonState.getInstance().getDevicePool();
      const context = await createToolExecutionContext(sessionUuid, sessionManager, devicePool, {
        keepScreenAwake,
        platform: platform === "android" || platform === "ios" ? platform : undefined
      });
      if (context.deviceId && !providedDeviceId) {
        providedDeviceId = context.deviceId;
        logger.info(`[ToolRegistry] Resolved device from session: ${providedDeviceId}`);
      }
      if (platform === "either" && context.devicePlatform) {
        platform = context.devicePlatform;
      }
    } else if (sessionUuid) {
      logger.warn(`[ToolRegistry] SessionUuid provided but DaemonState not initialized!`);
    }

    let device: BootedDevice | undefined;
    if (shouldResolveDevice) {
      if (sessionUuid && DaemonState.getInstance().isInitialized() && providedDeviceId) {
        // Daemon session path: device already resolved via createToolExecutionContext.
        // Construct BootedDevice directly to avoid mutating global DeviceSessionManager state.
        const resolvedPlatform = (platform === "android" || platform === "ios") ? platform : "android";
        const pooledDevice = DaemonState.getInstance().getDevicePool().getDevice(providedDeviceId);
        device = {
          deviceId: providedDeviceId,
          name: pooledDevice?.name ?? providedDeviceId,
          platform: pooledDevice?.platform ?? resolvedPlatform,
          iosVersion: pooledDevice?.iosVersion,
        };
        logger.info(`[ToolRegistry] ${name}: Using session-resolved device ${device.deviceId}`);
      } else {
        // Legacy single-agent path or no session: use DeviceSessionManager (may set global state)
        logger.info(`[ToolRegistry] ${name}: Resolving device for platform=${platform}, providedDeviceId=${providedDeviceId}`);
        device = await deviceSessionManager.ensureDeviceReady(
          platform,
          providedDeviceId,
          { skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled() }
        );
        logger.info(`[ToolRegistry] ${name}: Using device ${device.deviceId}`);
      }
    } else {
      logger.info(`[ToolRegistry] ${name}: Skipping device resolution.`);
    }

    // Enforce autolock: a locked device may only be driven by the session that locked it.
    if (device && isDevicePoolAutolockEnabled() && DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().getDevicePool().assertAutolockAccess(device.deviceId, sessionUuid);
    }

    // Bind session to device's CtrlProxyClient for multi-agent NavigationGraphManager isolation
    if (device && sessionUuid) {
      try {
        if (device.platform === "android") {
          AndroidCtrlProxyClient.getInstance(device).bindSession(sessionUuid);
        } else if (device.platform === "ios") {
          IOSCtrlProxyClient.getInstance(device).bindSession(sessionUuid);
        }
      } catch (error) {
        this.logger.debug(`[ToolRegistry] Best-effort CtrlProxy session bind skipped for ${name}: ${error}`);
      }
    }

    // Capability enforcement session (issue #4611 Gap A). A deviceId-only call
    // has no routing sessionUuid, so a narrowed profile on the device's owning
    // session would otherwise be silently bypassed (the policy treats an
    // undefined session as fully enabled). When a routing session exists it IS
    // the capability session (possibly a derived `${base}:${label}` label
    // session); otherwise derive the device's owning session so enforcement
    // still applies. Guarded on an initialized daemon — outside the daemon
    // there is no session registry to consult. This mirrors the socket path,
    // which already resolves deviceId -> session before enforcing.
    let capabilitySessionUuid = sessionUuid;
    if (!capabilitySessionUuid && device && DaemonState.getInstance().isInitialized()) {
      capabilitySessionUuid =
        DaemonState.getInstance().getSessionManager().getSessionForDevice?.(device.deviceId) ?? undefined;
    }

    return {
      args,
      baseSessionUuid,
      capabilitySessionUuid,
      device,
      internalCall,
      sessionUuid,
      shouldResolveDevice,
    };
  }

  private async enforceSessionUuidForMultipleIos(
    platform: SomePlatform,
    sessionUuid: string | undefined,
    providedDeviceId: string | undefined,
    deviceSessionManager: DeviceSessionManager
  ): Promise<void> {
    if (sessionUuid || providedDeviceId) {
      return;
    }

    const currentDevice = deviceSessionManager.getCurrentDevice();
    const currentPlatform = deviceSessionManager.getCurrentPlatform();
    if (currentDevice && currentPlatform === "ios" && platform === "ios") {
      return;
    }

    if (platform !== "ios" && platform !== "either") {
      return;
    }

    const connectedPlatforms = await deviceSessionManager.detectConnectedPlatforms();
    const iosDevices = connectedPlatforms.filter(device => device.platform === "ios");
    if (iosDevices.length <= 1) {
      return;
    }

    if (platform === "either") {
      const androidDevices = connectedPlatforms.filter(device => device.platform === "android");
      if (androidDevices.length > 0) {
        return;
      }
    }

    throw new ActionableError(
      "Multiple iOS simulators detected. Provide sessionUuid to target a specific simulator."
    );
  }

  private resolveImplicitAutolockSession(
    platform: SomePlatform,
    sessionUuid: string | undefined,
    providedDeviceId: string | undefined,
    mcpSessionId: string | undefined
  ): string | undefined {
    if (sessionUuid) {
      return undefined;
    }
    if (!isDevicePoolAutolockEnabled() || !DaemonState.getInstance().isInitialized()) {
      return undefined;
    }

    const platformFilter = platform === "android" || platform === "ios" ? platform : undefined;
    const sessionId = DaemonState.getInstance()
      .getDevicePool()
      .resolveAutolockSessionForMcpSession(mcpSessionId, platformFilter);
    if (!sessionId) {
      return undefined;
    }

    if (!providedDeviceId) {
      return sessionId;
    }

    const session = DaemonState.getInstance().getSessionManager().getSession(sessionId);
    return session?.assignedDevice === providedDeviceId ? sessionId : undefined;
  }

  private async enforceSessionUuidForAutolock(
    platform: SomePlatform,
    sessionUuid: string | undefined,
    providedDeviceId: string | undefined,
    deviceSessionManager: DeviceSessionManager
  ): Promise<void> {
    if (!isDevicePoolAutolockEnabled()) {
      return;
    }
    if (sessionUuid || providedDeviceId) {
      return;
    }

    const currentDevice = deviceSessionManager.getCurrentDevice();
    const currentPlatform = deviceSessionManager.getCurrentPlatform();
    if (currentDevice && (platform === "either" || platform === currentPlatform)) {
      return;
    }

    const connectedPlatforms = await deviceSessionManager.detectConnectedPlatforms();
    const candidates = platform === "either"
      ? connectedPlatforms
      : connectedPlatforms.filter(device => device.platform === platform);

    if (candidates.length <= 1) {
      return;
    }

    throw new ActionableError(
      "Device pool autolock is enabled and multiple devices are available. " +
      "Call startDevice first from this MCP session, or provide the sessionId returned by 'startDevice' (or a deviceId) to target a specific device."
    );
  }
}

// Exported for focused unit coverage (issue #3208). Production wires this via
// the ToolRegistry constructor; tests instantiate it directly to exercise the
// memory-audit wrapping decision and foreground-package lookup without a device.
export class DefaultAuditRunner implements AuditRunner {
  constructor(private readonly log: Logger = logger) {}
  async run(input: AuditRunnerInput): Promise<any> {
    const { name, args, device, handler, progress, signal } = input;
    if (!serverConfig.isMemPerfAuditEnabled() || device.platform !== "android") {
      return handler(device, args, progress, signal);
    }

    const packageName = await this.getForegroundPackageName(device);
    if (!packageName) {
      this.log.warn(`[ToolRegistry] Could not determine foreground app, skipping memory audit for ${name}`);
      return handler(device, args, progress, signal);
    }

    logger.info(`[ToolRegistry] Running memory audit for ${packageName} during ${name}`);
    const memoryAudit = new MemoryAudit(device);
    const perf = createGlobalPerformanceTracker();
    let response: any | undefined;

    const auditResult = await memoryAudit.runAudit(
      packageName,
      name,
      args,
      async () => {
        response = await handler(device, args, progress, signal);
      },
      perf
    );

    if (!auditResult.passed) {
      const errorMsg = `Memory audit FAILED for ${packageName} during ${name}\n\n${auditResult.diagnostics}`;
      logger.error(`[ToolRegistry] ${errorMsg}`);
      throw new ActionableError(errorMsg);
    }

    logger.info(`[ToolRegistry] Memory audit PASSED for ${packageName} during ${name}`);
    return response;
  }

  private async getForegroundPackageName(device: BootedDevice): Promise<string | null> {
    try {
      const adb = defaultAdbClientFactory.create(device);
      const { stdout } = await adb.executeCommand(
        "shell dumpsys window | grep mCurrentFocus"
      );

      const match = stdout.match(/\s+(\S+)\/\S+\}/);
      return match ? match[1] : null;
    } catch (error) {
      this.log.warn(`[ToolRegistry] Failed to get foreground package name: ${error}`);
      return null;
    }
  }
}

// UI interaction tools that may cause navigation. Excludes app lifecycle tools
// (launchApp, terminateApp, homeScreen, etc.) because they don't represent
// replayable in-app navigation paths. Module-level Set so record() does O(1)
// membership checks without re-allocating the list on every tool call.
export const NAVIGATION_RELEVANT_TOOLS = new Set([
  "tapOn", "swipeOn", "pinchOn", "dragAndDrop",
  "pressButton", "inputText", "clearText", "imeAction"
]);

class DefaultNavigationToolCallRecorder implements NavigationToolCallRecorder {
  record(name: string, args: any, device: BootedDevice | undefined, sessionUuid: string | undefined): void {
    // Record tool call for navigation graph correlation before the handler mutates UI state.
    if (!NAVIGATION_RELEVANT_TOOLS.has(name)) {
      return;
    }

    const cachedResult = device
      ? RealObserveScreen.getRecentCachedResultForDevice(device.deviceId)
      : RealObserveScreen.getRecentCachedResult();
    const uiState = new UIStateExtractor().extractFromObservation(cachedResult);
    const navManager = sessionUuid
      ? NavigationGraphManager.getInstanceForSession(sessionUuid)
      : NavigationGraphManager.getInstance();
    navManager.recordToolCall(name, args, uiState);
  }
}

function responseText(response: any): unknown {
  const first = Array.isArray(response?.content) ? response.content[0] : undefined;
  return first?.type === "text" ? first.text : undefined;
}

function unwrapToolResponse(response: any): any {
  if (!response || typeof response !== "object" || "success" in response) {
    return response;
  }
  const text = responseText(response);
  if (typeof text !== "string") {
    return response;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && "success" in parsed ? parsed : response;
  } catch {
    return response;
  }
}

export class DefaultAfterToolCallHandler implements AfterToolCallHandler {
  constructor(
    private readonly createArtifactWriter: ObservationArtifactWriterFactory =
    (outputDirectory, timer, retention) => new JsonToolOutputArtifactWriter({ outputDirectory, timer, retention })
  ) {}

  async handle(input: AfterToolCallInput): Promise<AfterToolCallResult> {
    const { name, args, internalCall, response, sessionUuid, shouldResolveDevice, signal, timer, toolStartMs } = input;

    // Unwrap MCP response envelope to get the inner result for success/error checks.
    // Tools may return { content: [{ type: "text", text: '{"success":false,...}' }] }
    // instead of a plain { success, error } object.
    const unwrapped = unwrapToolResponse(response);

    const toolSuccess = unwrapped && typeof unwrapped === "object" && "success" in unwrapped
      ? unwrapped.success !== false
      : true;
    const toolError = unwrapped && typeof unwrapped === "object" && "error" in unwrapped
      ? formatStructuredToolError(unwrapped.error) ?? String(unwrapped.error ?? "")
      : null;
    if (unwrapped && typeof unwrapped === "object" && "success" in unwrapped) {
      const resultLog = formatToolResultLog({
        toolName: name,
        success: unwrapped.success !== false,
        error: toolError ?? unwrapped.error,
        callerTimedOut: signal?.aborted ?? false,
      });
      logger[resultLog.level](resultLog.message);
    }

    const durationMs = timer.now() - toolStartMs;

    // Typed envelope views (issues #2932 / #3222): the heterogeneous pipeline
    // hands back `any`, so narrow to the concrete tool payload via
    // `narrowInternalToolEnvelope` before reading. Unlike a raw unchecked cast,
    // this validates the envelope shape at runtime (a bad shape
    // yields `undefined`, matching `getStructuredField`'s existing behavior) and
    // keys the payload type off the tool name via `InternalToolPayloads`. Reading
    // a non-hoisted field off the envelope top level (`swipeEnvelope.found`) is a
    // compile error, and `getStructuredField`'s key is checked against the
    // payload — the stringly-typed dead-read footgun is gone.
    if (name === "swipeOn" && args.lookFor) {
      const swipeEnvelope = narrowInternalToolEnvelope("swipeOn", response);
      if (getStructuredField(swipeEnvelope, "success") && getStructuredField(swipeEnvelope, "found")) {
        const scrollPosition = UIStateExtractor.createScrollPosition(args);
        if (scrollPosition) {
          const scrollNavManager = sessionUuid
            ? NavigationGraphManager.getInstanceForSession(sessionUuid)
            : NavigationGraphManager.getInstance();
          scrollNavManager.updateScrollPosition(scrollPosition);
        }
      }
    }

    if (shouldResolveDevice && sessionUuid && DaemonState.getInstance().isInitialized()) {
      const sessionManager = DaemonState.getInstance().getSessionManager();
      const observeEnvelope = narrowInternalToolEnvelope("observe", response);
      const observeHierarchy = name === "observe" ? getStructuredField(observeEnvelope, "viewHierarchy") : undefined;
      if (observeHierarchy) {
        sessionManager.setLastHierarchy(sessionUuid, observeHierarchy);
      }
      // NOTE: there is deliberately no `screenshot` read here. Production
      // `observe` never emitted a `screenshot` payload field and the session
      // `lastScreenshot` slot had no reader, so the whole cache chain was dead
      // and was removed (issue #3221). If observe ever attaches a screenshot,
      // reintroduce the write together with a real consumer.
    }

    const baselineStore: ObservationBaselineStore | undefined =
      sessionUuid && DaemonState.getInstance().isInitialized()
        ? {
          get: uuid => DaemonState.getInstance().getSessionManager().getLastRenderedObservation(uuid),
          set: (uuid, observation) => DaemonState.getInstance().getSessionManager().setLastRenderedObservation(uuid, observation),
        }
        : undefined;
    const configuredArtifactDirectory = serverConfig.getToolOutputsDir();
    const artifactMode = configuredArtifactDirectory ? "always" : "oversized";
    const artifactDirectory = configuredArtifactDirectory ?? getDefaultToolOutputsDir();
    const artifactWriter = !internalCall
      ? configuredArtifactDirectory
        ? this.createArtifactWriter(artifactDirectory, timer)
        : this.createArtifactWriter(artifactDirectory, timer, AUTOMATIC_TOOL_OUTPUT_RETENTION)
      : undefined;

    const finalizedResponse = finalizeToolResponse(response, {
      name,
      args,
      sessionUuid,
      baselineStore,
      internal: internalCall,
      artifactWriter,
      artifactMode,
    });

    TelemetryRecorder.getInstance().recordToolCallEvent({
      timestamp: toolStartMs,
      toolName: name,
      durationMs,
      success: toolSuccess,
      error: toolError,
      args: typeof args === "object" ? args : null,
    });

    if (toolSuccess) {
      getMcpRecorder()?.record(name, args);
    }

    return {
      durationMs,
      finalizedResponse,
    };
  }
}

// Exported for focused unit coverage (issue #3208). Production wires this via
// the ToolRegistry constructor; tests instantiate it directly to exercise
// executePlan cleanup and the auto-release guard without a live daemon session.
export class DefaultPlanLifecycleManager implements PlanLifecycleManager {
  async afterExecution(input: PlanLifecycleInput): Promise<void> {
    const {
      name,
      args,
      baseSessionUuid,
      cleanupService,
      device,
      sessionUuid,
      shouldResolveDevice,
      sessionBindingReleaseHandler,
      sessionToolProfileService,
    } = input;
    if (device && name === "executePlan" && args?.cleanupAppId) {
      await cleanupService.cleanup(device, {
        appId: args.cleanupAppId,
        clearAppData: args.cleanupClearAppData,
      });
    }

    if (shouldResolveDevice && sessionUuid && name === "executePlan" && DaemonState.getInstance().isInitialized()) {
      try {
        const sessionManager = DaemonState.getInstance().getSessionManager();
        const devicePool = DaemonState.getInstance().getDevicePool();
        const releaseSessionUuid = baseSessionUuid ?? sessionUuid;
        // Track exactly which sessions this release actually frees so the
        // server-side transport binding is torn down for each (issue #4611 Gap
        // D) — coupled to the REAL release, never cleared optimistically.
        const releasedSessionUuids: string[] = [];
        if (releaseSessionUuid) {
          releasedSessionUuids.push(...await releaseDeviceLabelSessions(releaseSessionUuid));
        }

        const session = releaseSessionUuid ? sessionManager.getSession(releaseSessionUuid) : null;
        if (session) {
          const deviceId = session.assignedDevice;
          // Await the release so its onSessionRelease callbacks (CtrlProxy binding +
          // detector cleanup) complete — and any rejection is caught by this try —
          // before the device is freed (#4984).
          await sessionManager.releaseSession(session.sessionId);
          await devicePool.releaseDevice(deviceId);
          NavigationGraphManager.releaseSession(releaseSessionUuid);
          // CtrlProxy client binding + detector cleanup for the released session is
          // handled centrally in the daemon's onSessionRelease hook (#4984), which
          // covers every release path and each derived label session on its device.
          RealObserveScreen.clearCache(deviceId);
          releasedSessionUuids.push(releaseSessionUuid);
          logger.info(`Auto-released session ${session.sessionId} and freed device ${deviceId} after executePlan`);
        }

        // Clear the per-transport SessionToolBinding for every freed session so a
        // later sessionless tools/list or tools/call stops enforcing a released
        // profile (issue #4611 Gap D). Best-effort: the handler swallows its own
        // failures, but the release itself has already succeeded regardless.
        for (const releasedUuid of releasedSessionUuids) {
          sessionBindingReleaseHandler?.onSessionReleased(releasedUuid);
          await sessionToolProfileService?.deleteSession?.(releasedUuid);
        }
      } catch (releaseError) {
        logger.warn(`Failed to auto-release session ${sessionUuid}: ${releaseError}`);
      }
    }
  }
}

// The registry that holds all tools
export class ToolRegistryClass {
  private tools: Map<string, RegisteredTool> = new Map();
  // Every live MCP server this registry has been registered with. In daemon
  // mode `registerWithServer` runs once per HTTP session, so notifications must
  // fan out to ALL live sessions — a single retained server would be
  // last-writer-wins (issue #3223). Entries are pruned via the underlying
  // server's onclose hook when a session's transport closes.
  private servers: Set<McpServer> = new Set();
  // Per-transport server-side session-binding teardown handlers (issue #4611 Gap
  // D). `createMcpServer` registers one per loopback transport; the plan-release
  // path fans a released session UUID out to all of them so each transport's
  // SessionToolBinding drops the stale session. Pruned via the returned
  // unsubscribe on transport close, mirroring the `servers` set above.
  private sessionBindingReleaseHandlers: Set<SessionBindingReleaseHandler> = new Set();
  // Stable aggregate handed to the plan-lifecycle input so afterExecution can
  // fan a released session out to every registered transport handler.
  private readonly sessionBindingReleaseNotifier: SessionBindingReleaseHandler = {
    onSessionReleased: sessionUuid => this.notifySessionBindingReleased(sessionUuid),
  };
  private deviceSessionManager: DeviceSessionManager;
  private cleanupService: AppCleanupService;
  private toolCallRepository: ToolCallRepository;
  private timer: Timer;
  private executionTargetResolver: ExecutionTargetResolver;
  private auditRunner: AuditRunner;
  private navigationToolCallRecorder: NavigationToolCallRecorder;
  private afterToolCall: AfterToolCallHandler;
  private planLifecycleManager: PlanLifecycleManager;
  private toolDefinitionSchemaCache: Map<string, CachedToolDefinitionSchemas> = new Map();

  constructor(timer: Timer = defaultTimer, loggerInstance: Logger = logger) {
    this.deviceSessionManager = DeviceSessionManager.getInstance();
    this.cleanupService = new DefaultAppCleanupService();
    this.toolCallRepository = new ToolCallRepository();
    this.timer = timer;
    this.executionTargetResolver = new DefaultExecutionTargetResolver(loggerInstance);
    this.auditRunner = new DefaultAuditRunner(loggerInstance);
    this.navigationToolCallRecorder = new DefaultNavigationToolCallRecorder();
    this.afterToolCall = new DefaultAfterToolCallHandler();
    this.planLifecycleManager = new DefaultPlanLifecycleManager();
  }

  private getToolAvailabilityGateReasons(tool: RegisteredTool): string[] {
    const reasons: string[] = [];
    if (tool.debugOnly && !isDebugModeEnabled()) {
      reasons.push("--debug is disabled");
    }
    if (tool.embeddedSdkOnly && !serverConfig.isEmbeddedSdkEnabled()) {
      reasons.push("embedded SDK mode is disabled");
    }
    if (tool.planOnly) {
      reasons.push(PLAN_ONLY_GATE_REASON);
    }
    return reasons;
  }

  private isToolAvailable(tool: RegisteredTool): boolean {
    return this.getToolAvailabilityGateReasons(tool).length === 0;
  }

  // Register a new tool
  register(
    name: string,
    description: string,
    schema: any,
    handler: ToolHandler,
    options: ToolRegistrationOptions = {}
  ): void {
    this.invalidateToolDefinitionSchemaCache();
    this.tools.set(name, {
      name,
      description,
      schema,
      handler,
      supportsProgress: options.supportsProgress ?? false,
      requiresDevice: false,
      debugOnly: options.debugOnly ?? false,
      embeddedSdkOnly: false,
      acceptsPlanLockNamespace: options.acceptsPlanLockNamespace ?? false,
      outputSchema: options.outputSchema,
      appUiResourceUri: options.appUiResourceUri
    });
  }

  /** Remove one test-only or dynamically registered tool without disturbing the registry. */
  unregister(name: string): void {
    this.invalidateToolDefinitionSchemaCache();
    this.tools.delete(name);
  }

  // Register a device-aware tool
  registerDeviceAware(
    name: string,
    description: string,
    schema: any,
    handler: DeviceAwareToolHandler,
    options: DeviceAwareToolOptions = {}
  ): void {
    this.invalidateToolDefinitionSchemaCache();
    // Create a wrapper that handles device ID injection
    const wrappedHandler: ToolHandler = async (args: any, progress?: ProgressCallback, signal?: AbortSignal) => {
      const capabilityContext = getToolCapabilityContext();
      // Re-inject the ambient ROUTING session (issue #4611 Gap C) so a nested
      // device-aware call keeps the outer call's derived/label routing identity
      // rather than reverting to the base session.
      const handlerArgs = capabilityContext?.routingSessionUuid && args.sessionUuid !== capabilityContext.routingSessionUuid
        ? { ...args, sessionUuid: capabilityContext.routingSessionUuid }
        : args;
      const toolStartMs = this.timer.now();
      const toolCallTimestamp = new Date().toISOString();
      let toolDurationMs: number | undefined;
      let sessionUuid = handlerArgs.sessionUuid;

      try {
        const resolvedTarget = await this.executionTargetResolver.resolveExecutionTarget({
          name,
          args: handlerArgs,
          options,
          deviceSessionManager: this.deviceSessionManager,
        });
        sessionUuid = resolvedTarget.sessionUuid;
        // Capability enforcement is resolved independently of the routing
        // session (issue #4611 Gaps A/B/C). The derived capability session is
        // the resolver-derived device session (Gap A) or the routing session;
        // the base is the caller-supplied base or the label's base resolved via
        // the shared helper. Enforcement is the UNION of base + derived (Gap B,
        // product decision): a tool is enabled if EITHER grants it, so a derived
        // label may re-enable a tool the base narrowed away.
        const capabilityDerivedSessionUuid = resolvedTarget.capabilitySessionUuid ?? resolvedTarget.sessionUuid;
        if (!capabilityContext?.planCapabilitiesAuthorized) {
          await this.assertToolEnabledUnion(
            name,
            capabilityDerivedSessionUuid,
            resolvedTarget.baseSessionUuid,
            getToolCapabilityContext()?.sessionToolProfileService,
            capabilityContext?.capabilitySessionUuid,
          );
        }
        return await runWithToolCapabilityContext(
          // Bind the ROUTING session (Gap C), not the base/capability session, so
          // nested calls re-inject the correct derived routing UUID.
          {
            routingSessionUuid: resolvedTarget.sessionUuid,
            // Preserve the connection profile, if any. The derived session is
            // supplied separately to the union assertion above; replacing the
            // connection identity here would lose an opt-in when nested calls
            // route through a labeled or explicitly selected device session.
            capabilitySessionUuid: capabilityContext?.capabilitySessionUuid,
            // The outer executePlan tool has already passed its test-authoring
            // capability gate, so its declarative steps are authorized by that
            // admission. Other tool handlers retain normal per-tool policy.
            planCapabilitiesAuthorized: preservesPlanCapabilityAuthorization(
              name,
              capabilityContext?.planCapabilitiesAuthorized,
            ),
          },
          async () => {
            try {
              let response: any | undefined;
              if (!resolvedTarget.shouldResolveDevice) {
                if (!options.nonDeviceHandler) {
                  throw new ActionableError(`Tool ${name} requires a device.`);
                }
                response = await options.nonDeviceHandler(handlerArgs, progress, signal);
              } else if (resolvedTarget.device !== undefined) {
                this.navigationToolCallRecorder.record(name, handlerArgs, resolvedTarget.device, resolvedTarget.sessionUuid);
                response = await this.auditRunner.run({
                  name,
                  args: handlerArgs,
                  device: resolvedTarget.device,
                  handler,
                  progress,
                  signal,
                });
              }

              const afterToolCallResult = await this.afterToolCall.handle({
                name,
                args: handlerArgs,
                device: resolvedTarget.device,
                internalCall: resolvedTarget.internalCall,
                response,
                sessionUuid: resolvedTarget.sessionUuid,
                shouldResolveDevice: resolvedTarget.shouldResolveDevice,
                signal,
                timer: this.timer,
                toolStartMs,
              });
              toolDurationMs = afterToolCallResult.durationMs;
              return afterToolCallResult.finalizedResponse;
            } catch (error) {
              if (error instanceof ActionableError || isDeviceLostError(error)) {
                throw error;
              }
              const deviceContext = resolvedTarget.device ? ` on device ${resolvedTarget.device.deviceId}` : "";
              throw new ActionableError(`Failed to execute tool ${name}${deviceContext}: ${error}`);
            } finally {
              await this.planLifecycleManager.afterExecution({
                name,
                args: handlerArgs,
                baseSessionUuid: resolvedTarget.baseSessionUuid,
                cleanupService: this.cleanupService,
                device: resolvedTarget.device,
                sessionUuid: resolvedTarget.sessionUuid,
                shouldResolveDevice: resolvedTarget.shouldResolveDevice,
                sessionBindingReleaseHandler: this.sessionBindingReleaseNotifier,
                sessionToolProfileService: getToolCapabilityContext()?.sessionToolProfileService,
              });
            }
          }
        );
      } finally {
        await this.toolCallRepository.recordToolCall({
          toolName: name,
          timestamp: toolCallTimestamp,
          sessionUuid,
          durationMs: toolDurationMs ?? this.timer.now() - toolStartMs,
        });
      }
    };

    this.tools.set(name, {
      name,
      description,
      schema,
      handler: wrappedHandler,
      supportsProgress: options.supportsProgress ?? false,
      requiresDevice: true,
      deviceAwareHandler: handler,
      debugOnly: options.debugOnly ?? false,
      embeddedSdkOnly: options.embeddedSdkOnly ?? false,
      planExecutable: options.planExecutable ?? false,
      planOnly: options.planOnly ?? false,
      acceptsPlanLockNamespace: options.acceptsPlanLockNamespace ?? false,
      outputSchema: options.outputSchema,
      appUiResourceUri: options.appUiResourceUri
    });
  }

  // Get all registered tools
  getAllTools(options: ToolListingOptions = {}): RegisteredTool[] {
    const tools = Array.from(this.tools.values());
    if (options.includeUnavailable) {
      return tools;
    }
    return tools.filter(tool => this.isToolAvailable(tool));
  }

  // Get a specific tool by name
  getTool(name: string): RegisteredTool | undefined {
    const tool = this.tools.get(name);
    if (!tool || !this.isToolAvailable(tool)) {
      return undefined;
    }
    return tool;
  }

  // Invoke a tool's wrapped handler on behalf of an internal caller (a
  // PlanExecutor step or a navigation/setup replay) rather than the agent. In
  // one call it resolves the tool, marks the args via `markInternalToolCall`,
  // invokes `.handler()`, and returns the RAW response — callers keep their own
  // result handling (reading `found`, discarding, racing a timeout).
  //
  // This is the single internal-call seam (#3108): marking the call is no longer
  // a per-site two-step, so a new internal caller cannot forget the
  // `__internalNoDiff` marker and silently advance the agent-facing diff baseline
  // (the #3087 bug class). Pass a tool name to also centralize the
  // resolve-and-null-check (`options.forPlan` selects `getToolForPlan` for tools
  // hidden from MCP discovery but valid in plans); pass an already-resolved
  // `RegisteredTool` for sites that must resolve it themselves first (e.g. to run
  // `tool.schema.parse` before the call). Throws `ActionableError` when a name
  // does not resolve; callers that degrade gracefully wrap the call in try/catch.
  async callInternal(
    tool: string | RegisteredTool,
    args: Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    options: InternalToolCallOptions = {}
  ): Promise<any> {
    const resolved = typeof tool === "string"
      ? (options.forPlan ? this.getToolForPlan(tool) : this.getTool(tool))
      : tool;
    if (!resolved) {
      throw new ActionableError(`Tool not found: ${tool}`);
    }
    const invocation = this.createInternalToolInvocationContext(args, options);

    return runWithToolCapabilityContext(
      invocation,
      () => this.invokeInternalTool(
        resolved,
        invocation.args,
        progress,
        signal,
        options.targetDevice,
        invocation.routingSessionUuid,
        invocation.capabilitySessionUuid,
        invocation.sessionToolProfileService,
        invocation.planCapabilitiesAuthorized,
      ),
    );
  }

  private createInternalToolInvocationContext(
    args: Record<string, unknown>,
    options: InternalToolCallOptions,
  ): InternalToolInvocationContext {
    const context = getToolCapabilityContext();
    // An internal call inherits the ambient ROUTING session (issue #4611 Gap C)
    // so a plan step or navigation replay routes to the same derived/label
    // session the outer call resolved to, not the base session.
    const sessionUuid = options.sessionUuid
      ?? context?.routingSessionUuid
      ?? (typeof args.sessionUuid === "string" ? args.sessionUuid : undefined);
    return {
      args: sessionUuid && args.sessionUuid !== sessionUuid
        ? { ...args, sessionUuid }
        : args,
      routingSessionUuid: sessionUuid,
      capabilitySessionUuid: context?.capabilitySessionUuid,
      planCapabilitiesAuthorized: context?.planCapabilitiesAuthorized === true,
      sessionToolProfileService: options.sessionToolProfileService ?? context?.sessionToolProfileService,
    };
  }

  private async invokeInternalTool(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    progress: ProgressCallback | undefined,
    signal: AbortSignal | undefined,
    targetDevice: BootedDevice | undefined,
    sessionUuid: string | undefined,
    capabilitySessionUuid: string | undefined,
    sessionToolProfileService: Pick<SessionToolProfileService, "isEnabled"> | undefined,
    allowPlanCapabilities: boolean,
  ): Promise<any> {
    // Honor the UNION of the base + derived `${base}:${label}` sessions here too
    // (issue #4611). `sessionUuid` is the ambient ROUTING session — a derived
    // label session for a labeled `criticalSection`/`executePlan` step — so a
    // single-session assert would reject a tool the base enables but the label
    // narrowed away. The `targetDevice` path below bypasses the device-aware
    // wrapper's own union gate entirely, so this pre-gate is the ONLY enforcement
    // point for it and must apply the union as well.
    if (!allowPlanCapabilities) {
      await this.assertToolEnabledUnion(
        tool.name,
        sessionUuid,
        undefined,
        sessionToolProfileService,
        capabilitySessionUuid,
      );
    }
    if (targetDevice && tool.deviceAwareHandler) {
      return tool.deviceAwareHandler(targetDevice, markInternalToolCall(args), progress, signal);
    }
    return tool.handler(markInternalToolCall(args), progress, signal);
  }

  /**
   * Assert a tool is enabled under UNION capability semantics (issue #4611): a
   * tool is enabled when EITHER the base OR the derived `${base}:${label}`
   * device-label session grants it. Applied at every enforcement gate — the
   * device-aware wrapper and the nested internal-call pre-gate — so no gate can
   * reject a call the union should allow.
   *
   * The REAL base is always resolved through the shared resolver, even when the
   * caller supplies `explicitBaseSessionUuid` (issue #4655). For an internal
   * device-aware step whose routing session is already the derived `${base}:B`,
   * the wrapper's resolver reports `baseSessionUuid = ${base}:B` — the derived
   * value, not the true base. Trusting it verbatim would collapse the union to
   * `[${base}:B, ${base}:B]` and lose the base grant. Passing the supplied base
   * (or the derived session when none is supplied) back through
   * `resolveCapabilityBaseSessionUuid` strips a `:label` when present and is a
   * no-op for a genuine base, so the union is genuinely `[base, ${base}:B]`.
   */
  private async assertToolEnabledUnion(
    toolName: string,
    derivedSessionUuid: string | undefined,
    explicitBaseSessionUuid: string | undefined,
    sessionToolProfileService: Pick<SessionToolProfileService, "isEnabled"> | undefined,
    connectionCapabilityProfileUuid?: string,
  ): Promise<void> {
    const sessionManager = DaemonState.getInstance().isInitialized()
      ? DaemonState.getInstance().getSessionManager()
      : undefined;
    const baseSessionUuid = resolveCapabilityBaseSessionUuid(
      explicitBaseSessionUuid ?? derivedSessionUuid,
      sessionManager,
    );
    await assertToolEnabledForAnySession(
      toolName,
      [connectionCapabilityProfileUuid, baseSessionUuid, derivedSessionUuid],
      sessionToolProfileService,
      connectionCapabilityProfileUuid,
    );
  }

  // Typed variant of `callInternal` for the handful of internally-consumed tools
  // whose envelope a caller then reads (issue #3222). Threads the concrete
  // payload type from `InternalToolPayloads` through the registry seam so
  // `callInternalTyped("swipeOn", …)` resolves to
  // `StructuredToolResponse<SwipeOnToolPayload> | undefined` instead of the
  // untyped `Promise<any>` — reading a non-hoisted field off the envelope top
  // level is a compile error and `getStructuredField` keys are checked against
  // the payload. It delegates to `callInternal` (so the #3108 `markInternalToolCall`
  // guarantee is preserved) and validates the shape at runtime via
  // `narrowInternalToolEnvelope` — there is NO unchecked `any`→typed cast. A
  // response that is not envelope-shaped narrows to `undefined`, which the read
  // sites already handle (`getStructuredField(undefined, …)` is `undefined`).
  async callInternalTyped<K extends InternalToolName>(
    name: K,
    args: Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    options: InternalToolCallOptions = {}
  ): Promise<StructuredToolResponse<InternalToolPayloads[K]> | undefined> {
    const response = await this.callInternal(name, args, progress, signal, options);
    return narrowInternalToolEnvelope(name, response);
  }

  // Get a tool for internal plan execution. Some tools are intentionally hidden
  // from MCP navigation surfaces but remain valid in recorded/replayed plans.
  getToolForPlan(name: string): RegisteredTool | undefined {
    const tool = this.tools.get(name);
    if (!tool) {
      return undefined;
    }

    const gateReasons = this.getToolAvailabilityGateReasons(tool);
    if (gateReasons.length > 0 && !tool.planExecutable) {
      return undefined;
    }
    // A `planOnly` tool is hidden from discovery by design and is expected in
    // plans, so don't warn about that reason — only surface *other* gate reasons
    // (e.g. a debug-only tool being used inside a plan), which are noteworthy.
    const unexpectedReasons = gateReasons.filter(r => r !== PLAN_ONLY_GATE_REASON);
    if (unexpectedReasons.length > 0) {
      logger.warn(
        `[ToolRegistry] Plan execution is using gated tool "${name}" (${unexpectedReasons.join(", ")}). Tool is hidden from normal MCP discovery but marked planExecutable.`
      );
    }
    return tool;
  }

  // Register all tools with an MCP server
  registerWithServer(server: McpServer): void {
    // Retained so runtime changes that alter tool definitions can emit
    // notifications/tools/list_changed (issue #2963) to EVERY live session, not
    // just the most recently created one (issue #3223), mirroring how
    // ResourceRegistry retains its servers for resources/list_changed.
    this.trackServer(server);

    this.tools.forEach(tool => {
      if (!this.isToolAvailable(tool)) {
        return;
      }

      // Create a wrapper that adapts our ToolHandler to the MCP server's expected signature
      const wrappedHandler = async (args: any, extra: any) => {
        const signal: AbortSignal | undefined = extra?.signal;

        if (tool.supportsProgress) {
          const progressToken = extra?._meta?.progressToken ?? `${tool.name}-${this.timer.now()}`;
          const progressCallback: ProgressCallback = async (progress: number, total?: number, message?: string) => {
            try {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress,
                  total,
                  ...(message && { message })
                }
              });
            } catch (error) {
              logger.warn(`Failed to send progress notification: ${error}`);
            }
          };
          return await tool.handler(args, progressCallback, signal);
        } else {
          return await tool.handler(args, undefined, signal);
        }
      };

      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: tool.schema,
        ...(process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS === "true" && {
          _meta: { "anthropic/alwaysLoad": true },
        })
      }, wrappedHandler);
    });
  }

  // Track a server for list-changed fan-out and prune it when its session's
  // transport closes. The underlying Protocol preserves a pre-set `onclose`
  // (both the transport's and the server's), so chaining here cannot clobber
  // other lifecycle hooks — and vice versa.
  private trackServer(server: McpServer): void {
    if (this.servers.has(server)) {
      return;
    }
    this.servers.add(server);
    const underlying = server.server;
    const existingOnClose = underlying.onclose;
    underlying.onclose = () => {
      this.servers.delete(server);
      existingOnClose?.();
    };
  }

  // Test-only: drop tracked servers so suites sharing the singleton stay hermetic.
  clearServersForTesting(): void {
    this.servers.clear();
  }

  // Register a per-transport server-side session-binding teardown handler (issue
  // #4611 Gap D) and return its unsubscribe. `createMcpServer` calls this once per
  // loopback transport and drops it on transport close, so a released session's
  // stale binding is cleared on every live transport but a closed transport's
  // handler never lingers.
  registerSessionBindingReleaseHandler(handler: SessionBindingReleaseHandler): () => void {
    this.sessionBindingReleaseHandlers.add(handler);
    return () => {
      this.sessionBindingReleaseHandlers.delete(handler);
    };
  }

  // Fan a released session UUID out to every registered transport handler. Called
  // from the plan-release path (via the injected notifier) after a session is
  // actually freed. Best-effort: one throwing handler never blocks the others or
  // the release that triggered it.
  notifySessionBindingReleased(sessionUuid: string): void {
    for (const handler of this.sessionBindingReleaseHandlers) {
      try {
        handler.onSessionReleased(sessionUuid);
      } catch (error) {
        logger.warn(`[ToolRegistry] session-binding release handler failed for ${sessionUuid}: ${error}`);
      }
    }
  }

  // Test-only: drop registered session-binding release handlers so suites sharing
  // the singleton stay hermetic.
  clearSessionBindingReleaseHandlersForTesting(): void {
    this.sessionBindingReleaseHandlers.clear();
  }

  // Emit notifications/tools/list_changed so caching clients re-fetch tools/list
  // after a runtime change that alters tool definitions — outputSchema
  // advertisement (getToolDefinitions) or tool availability (isToolAvailable).
  // Called from FeatureFlagService when a tool-definition-affecting flag toggles
  // (issue #2963); mirrors ResourceRegistry.notifyResourceListChanged. The SDK's
  // sendToolListChanged() is itself a guarded no-op until a client connects, so
  // this is safe to call before any transport attaches.
  //
  // Fan-out (issue #3223): every live session's server is notified (not just the
  // most recently created one), and the ListChangedBroadcaster carries the event
  // to non-MCP transports — the daemon's Unix socket server pushes it to
  // connected DaemonMcpProxy clients, which invalidate their tool cache and
  // re-emit to their own external clients.
  notifyToolListChanged(): void {
    this.invalidateToolDefinitionSchemaCache();
    for (const server of this.servers) {
      try {
        server.sendToolListChanged();
      } catch (error) {
        // Best-effort: a failed notification must never break the flag toggle
        // that triggered it, nor block sibling sessions. Unexpected for a
        // connected client (transport mid-teardown is the only expected case),
        // so warn — matching notifyResourceListChanged.
        logger.warn(`[ToolRegistry] Failed to notify tool list change: ${error}`);
      }
    }
    ListChangedBroadcaster.emit("tools");
  }

  // Get tools in MCP format
  getToolDefinitions(options: ToolListingOptions = {}) {
    const alwaysLoad = process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS === "true";
    // When tool results are stripped of `structuredContent` (issue #2899), do not
    // advertise an `outputSchema` in `tools/list`: an MCP server that declares an
    // output schema is expected to return matching `structuredContent`, so keeping
    // both consistent avoids advertising output the finalize step will strip.
    const suppressOutputSchema = serverConfig.isToolResultsNoStructuredContentEnabled();
    // Bounds compaction is now an unconditional default, so the tuple arm is always
    // emitted and therefore always advertised — keeping the advertised shape in sync
    // with the wire (issue #2990), the same way `suppressOutputSchema` above keeps the
    // two in sync for the strip flag.
    const compactBounds = true;
    return this.getAllTools(options).map(tool => {
      const { inputSchema, outputSchema } = this.getCachedToolDefinitionSchemas(
        tool,
        suppressOutputSchema,
        compactBounds
      );

      const definition: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        _meta?: { "anthropic/alwaysLoad"?: boolean; ui?: { resourceUri: string } };
      } = {
        name: tool.name,
        description: tool.description,
        inputSchema,
      };
      if (outputSchema) {
        definition.outputSchema = outputSchema;
      }
      if (alwaysLoad) {
        definition._meta = { ...definition._meta, "anthropic/alwaysLoad": true };
      }
      // MCP Apps UI pointer (issue #4669) — additive; non-Apps hosts ignore it.
      if (tool.appUiResourceUri) {
        definition._meta = { ...definition._meta, ui: { resourceUri: tool.appUiResourceUri } };
      }
      return definition;
    });
  }

  private getCachedToolDefinitionSchemas(
    tool: RegisteredTool,
    suppressOutputSchema: boolean,
    compactBounds: boolean
  ): { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> | undefined } {
    let cached = this.toolDefinitionSchemaCache.get(tool.name);
    if (!cached) {
      cached = {
        inputSchema: toAdvertisedJsonSchema(tool.schema),
        outputSchemasByRuntimeFlags: new Map(),
      };
      this.toolDefinitionSchemaCache.set(tool.name, cached);
    }

    const outputSchemaCacheKey = `${suppressOutputSchema}:${compactBounds}`;
    if (!cached.outputSchemasByRuntimeFlags.has(outputSchemaCacheKey)) {
      const outputSchema = toolHasOutputSchema(tool) && !suppressOutputSchema
        ? advertiseBoundsForCompact(
          toAdvertisedJsonSchema(tool.outputSchema),
          compactBounds
        ) as Record<string, unknown>
        : undefined;
      cached.outputSchemasByRuntimeFlags.set(outputSchemaCacheKey, outputSchema);
    }

    return {
      inputSchema: cached.inputSchema,
      outputSchema: cached.outputSchemasByRuntimeFlags.get(outputSchemaCacheKey),
    };
  }

  private invalidateToolDefinitionSchemaCache(): void {
    this.toolDefinitionSchemaCache.clear();
  }

  // Get a map of all schema
  getSchemaMap(): Record<string, any> {
    const schemaMap: Record<string, any> = {};
    this.getAllTools().forEach(tool => {
      schemaMap[tool.name] = tool.schema;
    });
    return schemaMap;
  }

  // Get the device session manager
  getDeviceSessionManager(): DeviceSessionManager {
    return this.deviceSessionManager;
  }

  // Allow tests to inject a cleanup implementation
  setCleanupService(cleanupService: AppCleanupService): void {
    this.cleanupService = cleanupService;
  }

  // Allow focused unit tests to replace pipeline collaborators without relying
  // on private field names. Production uses the defaults wired in the constructor.
  setPipelineOverridesForTesting(overrides: ToolRegistryPipelineOverrides): () => void {
    const previous = {
      executionTargetResolver: this.executionTargetResolver,
      auditRunner: this.auditRunner,
      afterToolCall: this.afterToolCall,
      planLifecycleManager: this.planLifecycleManager,
    };

    if (overrides.executionTargetResolver) {
      this.executionTargetResolver = overrides.executionTargetResolver;
    }
    if (overrides.auditRunner) {
      this.auditRunner = overrides.auditRunner;
    }
    if (overrides.afterToolCall) {
      this.afterToolCall = overrides.afterToolCall;
    }
    if (overrides.planLifecycleManager) {
      this.planLifecycleManager = overrides.planLifecycleManager;
    }

    return () => {
      this.executionTargetResolver = previous.executionTargetResolver;
      this.auditRunner = previous.auditRunner;
      this.afterToolCall = previous.afterToolCall;
      this.planLifecycleManager = previous.planLifecycleManager;
    };
  }

  // Clear all registered tools (for testing)
  clearTools(): void {
    this.invalidateToolDefinitionSchemaCache();
    this.tools.clear();
  }
}

// Export a singleton instance
export const ToolRegistry = new ToolRegistryClass();

// --- Compile-time enforcement of AC1 (issue #3222) ---
// AC1 is a *type* guarantee: `callInternalTyped(name, …)` must thread the concrete
// payload type from `InternalToolPayloads` through the registry seam rather than
// collapse back to the untyped `Promise<any>` of `callInternal`. The runtime tests
// in `test/server/internalToolPayloads.test.ts` cannot pin this — bun's test runner
// does not typecheck, and the `bun run typecheck` gate compiles only `src`
// (`tsconfig.json` include), so an assertion in `test/` is never checked and would
// pass even against an `any` regression. These type-only aliases live in `src` (and
// beside the method they guard, to avoid a type-resolution cycle) so the gate DOES
// fail if the seam regresses; they erase at build time (zero runtime cost).
type _IsAny<T> = 0 extends 1 & T ? true : false;
type _AssertTrue<T extends true> = T;
type _ResolvedTypedEnvelope = NonNullable<Awaited<ReturnType<typeof ToolRegistry.callInternalTyped>>>;
// The aliases are referenced only by the compiler (their constraint check IS the
// guard); they are intentionally unused at runtime, hence the disable.
/* eslint-disable @typescript-eslint/no-unused-vars */
// Fails to compile if the resolved envelope widens to `any` (the seam stopped
// threading the payload type)...
type _Ac1ResultIsNotAny = _AssertTrue<_IsAny<_ResolvedTypedEnvelope> extends true ? false : true>;
// ...or if it is no longer the concrete `StructuredToolResponse<…Payload>` envelope.
type _Ac1ResultIsConcreteEnvelope = _AssertTrue<
  _ResolvedTypedEnvelope extends StructuredToolResponse<InternalToolPayloads[InternalToolName]>
    ? true
    : false
>;
/* eslint-enable @typescript-eslint/no-unused-vars */

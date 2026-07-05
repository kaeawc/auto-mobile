import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJSONSchema } from "zod";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import { ActionableError, BootedDevice, ObserveToolPayload, SomePlatform, SwipeOnToolPayload } from "../models";
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
import { logger } from "../utils/logger";
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
import { flattenTopLevelUnion } from "./TopLevelUnionFlattener";
import { advertiseBoundsForCompact } from "./compactBoundsAdvertisement";
import { finalizeToolResponse, type ObservationBaselineStore } from "./finalizeToolResponse";
import { INTERNAL_NO_DIFF_PARAM } from "./internalToolCall";
import { asToolEnvelope, getStructuredField } from "../utils/toolUtils";

// Re-exported for backward compatibility; the implementation now lives in
// ./TopLevelUnionFlattener so the schema-flattening concern is independently testable.
export { flattenTopLevelUnion } from "./TopLevelUnionFlattener";

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

interface ToolRegistrationOptions {
  supportsProgress?: boolean;
  debugOnly?: boolean;
  outputSchema?: any;
}

interface DeviceAwareToolOptions<T = any> extends ToolRegistrationOptions {
  shouldEnsureDevice?: (args: T) => boolean;
  nonDeviceHandler?: ToolHandler<T>;
  embeddedSdkOnly?: boolean;
  planExecutable?: boolean;
}

interface ToolListingOptions {
  includeUnavailable?: boolean;
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
  outputSchema?: any;
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
  device: BootedDevice | undefined;
  internalCall: boolean;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
}

interface ExecutionTargetResolver {
  resolveExecutionTarget(input: ExecutionTargetInput): Promise<ExecutionTargetContext>;
}

interface AuditRunnerInput {
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

interface PlanLifecycleInput {
  name: string;
  args: any;
  baseSessionUuid: string | undefined;
  cleanupService: AppCleanupService;
  device: BootedDevice | undefined;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
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
        args.sessionUuid = implicitSessionUuid;
        logger.info(`[ToolRegistry] Resolved implicit autolock session for MCP session ${mcpSessionId}: ${implicitSessionUuid}`);
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
        logger.debug(`[ToolRegistry] Best-effort CtrlProxy session bind skipped for ${name}: ${error}`);
      }
    }

    return {
      args,
      baseSessionUuid,
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

class DefaultAuditRunner implements AuditRunner {
  async run(input: AuditRunnerInput): Promise<any> {
    const { name, args, device, handler, progress, signal } = input;
    if (!serverConfig.isMemPerfAuditEnabled() || device.platform !== "android") {
      return handler(device, args, progress, signal);
    }

    const packageName = await this.getForegroundPackageName(device);
    if (!packageName) {
      logger.warn(`[ToolRegistry] Could not determine foreground app, skipping memory audit for ${name}`);
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
      logger.warn(`[ToolRegistry] Failed to get foreground package name: ${error}`);
      return null;
    }
  }
}

class DefaultNavigationToolCallRecorder implements NavigationToolCallRecorder {
  record(name: string, args: any, device: BootedDevice | undefined, sessionUuid: string | undefined): void {
    // Record tool call for navigation graph correlation before the handler mutates UI state.
    // Only record UI interaction tools that may cause navigation. Excludes app lifecycle
    // tools (launchApp, terminateApp, homeScreen, etc.) because they don't represent
    // replayable in-app navigation paths.
    const navigationRelevantTools = [
      "tapOn", "swipeOn", "pinchOn", "dragAndDrop",
      "pressButton", "inputText", "clearText", "imeAction"
    ];
    if (!navigationRelevantTools.includes(name)) {
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

class DefaultAfterToolCallHandler implements AfterToolCallHandler {
  async handle(input: AfterToolCallInput): Promise<AfterToolCallResult> {
    const { name, args, internalCall, response, sessionUuid, shouldResolveDevice, signal, timer, toolStartMs } = input;

    // Unwrap MCP response envelope to get the inner result for success/error checks.
    // Tools may return { content: [{ type: "text", text: '{"success":false,...}' }] }
    // instead of a plain { success, error } object.
    let unwrapped = response;
    if (
      response && typeof response === "object" &&
      !("success" in response) &&
      Array.isArray(response.content) && response.content.length > 0
    ) {
      const first = response.content[0];
      if (first?.type === "text" && typeof first.text === "string") {
        try {
          const parsed = JSON.parse(first.text);
          if (parsed && typeof parsed === "object" && "success" in parsed) {
            unwrapped = parsed;
          }
        } catch { /* not JSON — use original response */ }
      }
    }

    const toolSuccess = unwrapped && typeof unwrapped === "object" && "success" in unwrapped
      ? unwrapped.success !== false
      : true;
    const toolError = unwrapped && typeof unwrapped === "object" && "error" in unwrapped
      ? String(unwrapped.error || "")
      : null;
    if (unwrapped && typeof unwrapped === "object" && "success" in unwrapped) {
      const resultLog = formatToolResultLog({
        toolName: name,
        success: unwrapped.success !== false,
        error: unwrapped.error,
        callerTimedOut: signal?.aborted ?? false,
      });
      logger[resultLog.level](resultLog.message);
    }

    const durationMs = timer.now() - toolStartMs;
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

    // Typed envelope views (issue #2932): the heterogeneous pipeline hands back
    // `any`, so narrow to the concrete tool payload via `asToolEnvelope` before
    // reading (it names the unchecked `any`→typed crossing). Reading a
    // non-hoisted field off the envelope top level (`swipeEnvelope.found`) is now
    // a compile error, and `getStructuredField`'s key is checked against the
    // payload — the stringly-typed dead-read footgun is gone.
    if (name === "swipeOn" && args.lookFor) {
      const swipeEnvelope = asToolEnvelope<SwipeOnToolPayload>(response);
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
      const observeEnvelope = asToolEnvelope<ObserveToolPayload>(response);
      const observeHierarchy = name === "observe" ? getStructuredField(observeEnvelope, "viewHierarchy") : undefined;
      if (observeHierarchy) {
        sessionManager.setLastHierarchy(sessionUuid, observeHierarchy);
      }
      const observeScreenshot = name === "observe" ? getStructuredField(observeEnvelope, "screenshot") : undefined;
      if (observeScreenshot) {
        sessionManager.setLastScreenshot(sessionUuid, observeScreenshot);
      }
    }

    const baselineStore: ObservationBaselineStore | undefined =
      sessionUuid && DaemonState.getInstance().isInitialized()
        ? {
          get: uuid => DaemonState.getInstance().getSessionManager().getLastRenderedObservation(uuid),
          set: (uuid, observation) => DaemonState.getInstance().getSessionManager().setLastRenderedObservation(uuid, observation),
        }
        : undefined;

    return {
      durationMs,
      finalizedResponse: finalizeToolResponse(response, { name, sessionUuid, baselineStore, internal: internalCall }),
    };
  }
}

class DefaultPlanLifecycleManager implements PlanLifecycleManager {
  async afterExecution(input: PlanLifecycleInput): Promise<void> {
    const { name, args, baseSessionUuid, cleanupService, device, sessionUuid, shouldResolveDevice } = input;
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
        if (releaseSessionUuid) {
          await releaseDeviceLabelSessions(releaseSessionUuid);
        }

        const session = releaseSessionUuid ? sessionManager.getSession(releaseSessionUuid) : null;
        if (session) {
          const deviceId = session.assignedDevice;
          sessionManager.releaseSession(session.sessionId);
          await devicePool.releaseDevice(deviceId);
          NavigationGraphManager.releaseSession(releaseSessionUuid);
          RealObserveScreen.clearCache(deviceId);
          logger.info(`Auto-released session ${session.sessionId} and freed device ${deviceId} after executePlan`);
        }
      } catch (releaseError) {
        logger.warn(`Failed to auto-release session ${sessionUuid}: ${releaseError}`);
      }
    }
  }
}

// The registry that holds all tools
class ToolRegistryClass {
  private tools: Map<string, RegisteredTool> = new Map();
  private deviceSessionManager: DeviceSessionManager;
  private cleanupService: AppCleanupService;
  private toolCallRepository: ToolCallRepository;
  private timer: Timer;
  private executionTargetResolver: ExecutionTargetResolver;
  private auditRunner: AuditRunner;
  private navigationToolCallRecorder: NavigationToolCallRecorder;
  private afterToolCall: AfterToolCallHandler;
  private planLifecycleManager: PlanLifecycleManager;

  constructor(timer: Timer = defaultTimer) {
    this.deviceSessionManager = DeviceSessionManager.getInstance();
    this.cleanupService = new DefaultAppCleanupService();
    this.toolCallRepository = new ToolCallRepository();
    this.timer = timer;
    this.executionTargetResolver = new DefaultExecutionTargetResolver();
    this.auditRunner = new DefaultAuditRunner();
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
    this.tools.set(name, {
      name,
      description,
      schema,
      handler,
      supportsProgress: options.supportsProgress ?? false,
      requiresDevice: false,
      debugOnly: options.debugOnly ?? false,
      embeddedSdkOnly: false,
      outputSchema: options.outputSchema
    });
  }

  // Register a device-aware tool
  registerDeviceAware(
    name: string,
    description: string,
    schema: any,
    handler: DeviceAwareToolHandler,
    options: DeviceAwareToolOptions = {}
  ): void {
    // Create a wrapper that handles device ID injection
    const wrappedHandler: ToolHandler = async (args: any, progress?: ProgressCallback, signal?: AbortSignal) => {
      const toolStartMs = this.timer.now();
      const toolCallTimestamp = new Date().toISOString();
      let toolDurationMs: number | undefined;
      let target: ExecutionTargetContext | undefined;
      let sessionUuid = args.sessionUuid;

      try {
        target = await this.executionTargetResolver.resolveExecutionTarget({
          name,
          args,
          options,
          deviceSessionManager: this.deviceSessionManager,
        });
        sessionUuid = target.sessionUuid;
        try {
          let response: any | undefined;
          if (!target.shouldResolveDevice) {
            if (!options.nonDeviceHandler) {
              throw new ActionableError(`Tool ${name} requires a device.`);
            }
            response = await options.nonDeviceHandler(args, progress, signal);
          } else if (target.device !== undefined) {
            this.navigationToolCallRecorder.record(name, args, target.device, target.sessionUuid);
            response = await this.auditRunner.run({
              name,
              args,
              device: target.device,
              handler,
              progress,
              signal,
            });
          }

          const afterToolCallResult = await this.afterToolCall.handle({
            name,
            args,
            device: target.device,
            internalCall: target.internalCall,
            response,
            sessionUuid: target.sessionUuid,
            shouldResolveDevice: target.shouldResolveDevice,
            signal,
            timer: this.timer,
            toolStartMs,
          });
          toolDurationMs = afterToolCallResult.durationMs;
          return afterToolCallResult.finalizedResponse;
        } catch (error) {
          if (error instanceof ActionableError) {
            throw error;
          }
          const deviceContext = target.device ? ` on device ${target.device.deviceId}` : "";
          throw new ActionableError(`Failed to execute tool ${name}${deviceContext}: ${error}`);
        } finally {
          if (target) {
            await this.planLifecycleManager.afterExecution({
              name,
              args,
              baseSessionUuid: target.baseSessionUuid,
              cleanupService: this.cleanupService,
              device: target.device,
              sessionUuid: target.sessionUuid,
              shouldResolveDevice: target.shouldResolveDevice,
            });
          }
        }
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
      outputSchema: options.outputSchema
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
    if (gateReasons.length > 0) {
      logger.warn(
        `[ToolRegistry] Plan execution is using gated tool "${name}" (${gateReasons.join(", ")}). Tool is hidden from normal MCP discovery but marked planExecutable.`
      );
    }
    return tool;
  }

  // Register all tools with an MCP server
  registerWithServer(server: McpServer): void {
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

  // Get tools in MCP format
  getToolDefinitions(options: ToolListingOptions = {}) {
    const alwaysLoad = process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS === "true";
    // When tool results are stripped of `structuredContent` (issue #2899), do not
    // advertise an `outputSchema` in `tools/list`: an MCP server that declares an
    // output schema is expected to return matching `structuredContent`, so keeping
    // both consistent avoids advertising output the finalize step will strip.
    const suppressOutputSchema = serverConfig.isToolResultsNoStructuredContentEnabled();
    // Advertise the compact bounds tuple only when the server will actually emit it,
    // so the advertised shape stays in sync with the wire (issue #2990), the same way
    // `suppressOutputSchema` above keeps the two in sync for the strip flag.
    const compactBounds = serverConfig.isObserveResultCompactEnabled();
    return this.getAllTools(options).map(tool => {
      const outputSchema = toolHasOutputSchema(tool) && !suppressOutputSchema
        ? advertiseBoundsForCompact(flattenTopLevelUnion(toJSONSchema(tool.outputSchema)), compactBounds)
        : undefined;

      return {
        name: tool.name,
        description: tool.description,
        inputSchema: flattenTopLevelUnion(toJSONSchema(tool.schema)),
        ...(outputSchema && { outputSchema }),
        ...(alwaysLoad && { _meta: { "anthropic/alwaysLoad": true } })
      };
    });
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
    this.tools.clear();
  }
}

// Export a singleton instance
export const ToolRegistry = new ToolRegistryClass();

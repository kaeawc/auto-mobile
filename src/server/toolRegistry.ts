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
import { logger } from "../utils/logger";
import { DaemonState } from "../daemon/daemonState";
import { createToolExecutionContext, updateSessionCache } from "./ToolExecutionContext";
import { AppCleanupService, DefaultAppCleanupService } from "./AppCleanupService";
import { ToolCallRepository } from "../db/toolCallRepository";
import { getDeviceLabelMap, releaseDeviceLabelSessions } from "./deviceLabelMapping";
import { isDevicePoolAutolockEnabled } from "../daemon/poolConfig";
import { isDebugModeEnabled } from "../utils/debug";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { getMcpRecorder } from "./mcpRecordingManager";

/**
 * The Anthropic API (and many MCP clients) reject tool input schemas that have
 * top-level combinators such as `anyOf`, `oneOf`, or `allOf`. Zod's `z.union()`
 * produces `anyOf`/`oneOf`.
 * This function flattens union branches into a single `type: "object"` schema
 * by merging all properties from every branch. Required fields are dropped because
 * different branches require different keys.
 *
 * Trade-off: the flattened schema loses mutual-exclusivity information, so LLMs may
 * send invalid property combinations or omit branch-specific required fields. The
 * server-side Zod union still validates at runtime.
 */
export function flattenTopLevelUnion(schema: Record<string, unknown>): Record<string, unknown> {
  const branches = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (!branches || !Array.isArray(branches)) {
    return schema;
  }

  const mergedProperties: Record<string, unknown> = {};
  const seenAdditionalProperties = new Set<boolean | undefined>();
  const requiredSets: Set<string>[] = [];

  for (const branch of branches) {
    const props = branch.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (!mergedProperties[key]) {
          mergedProperties[key] = value;
        } else {
          mergedProperties[key] = mergeUnionProperty(mergedProperties[key], value);
        }
      }
    }
    if (typeof branch.additionalProperties === "boolean") {
      seenAdditionalProperties.add(branch.additionalProperties);
    }
    const req = branch.required as string[] | undefined;
    requiredSets.push(new Set(req ?? []));
  }

  const commonRequired = requiredSets.length > 0
    ? [...requiredSets[0]].filter(key => requiredSets.every(s => s.has(key)))
    : [];

  const result: Record<string, unknown> = {
    ...(schema.$schema ? { $schema: schema.$schema } : {}),
    type: "object",
    properties: mergedProperties,
  };

  if (commonRequired.length > 0) {
    result.required = commonRequired;
  }

  if (seenAdditionalProperties.size === 1) {
    result.additionalProperties = [...seenAdditionalProperties][0];
  }

  const conditionalRequired = buildConditionalRequired(branches, commonRequired);
  if (conditionalRequired) {
    Object.assign(result, conditionalRequired);
  }

  return result;
}

interface ConditionalRequirement {
  if: {
    properties: Record<string, { const: unknown }>;
    required: string[];
  };
  then: {
    required: string[];
  };
  else?: ConditionalRequirement;
}

function buildConditionalRequired(
  branches: Record<string, unknown>[],
  commonRequired: string[]
): ConditionalRequirement | undefined {
  const commonRequiredSet = new Set(commonRequired);
  const requirements: ConditionalRequirement[] = [];

  for (const branch of branches) {
    const required = Array.isArray(branch.required)
      ? branch.required.filter((key): key is string => typeof key === "string")
      : [];
    const branchOnlyRequired = required.filter(key => !commonRequiredSet.has(key));
    if (branchOnlyRequired.length === 0) {
      continue;
    }

    const condition = buildDiscriminatorCondition(branch);
    if (!condition) {
      continue;
    }

    requirements.push({
      if: condition,
      then: {
        required: branchOnlyRequired,
      },
    });
  }

  return chainConditionalRequirements(requirements);
}

function buildDiscriminatorCondition(
  branch: Record<string, unknown>
): ConditionalRequirement["if"] | undefined {
  const properties = isJsonSchemaObject(branch.properties) ? branch.properties : {};
  for (const [key, value] of Object.entries(properties)) {
    if (!isJsonSchemaObject(value)) {
      continue;
    }
    const values = constOrEnumValues(value);
    if (values.length !== 1) {
      continue;
    }
    return {
      properties: {
        [key]: { const: values[0] },
      },
      required: [key],
    };
  }
  return undefined;
}

function chainConditionalRequirements(
  requirements: ConditionalRequirement[]
): ConditionalRequirement | undefined {
  let chain: ConditionalRequirement | undefined;

  for (const requirement of requirements.toReversed()) {
    chain = {
      ...requirement,
      ...(chain ? { else: chain } : {}),
    };
  }

  return chain;
}

function mergeUnionProperty(existing: unknown, incoming: unknown): unknown {
  if (!isJsonSchemaObject(existing) || !isJsonSchemaObject(incoming)) {
    return existing;
  }

  const existingValues = constOrEnumValues(existing);
  const incomingValues = constOrEnumValues(incoming);
  if (existingValues.length === 0 || incomingValues.length === 0) {
    return existing;
  }

  const baseSchema = { ...existing };
  delete baseSchema.const;
  return {
    ...baseSchema,
    enum: [...new Set([...existingValues, ...incomingValues])],
  };
}

function constOrEnumValues(schema: Record<string, unknown>): unknown[] {
  if ("const" in schema) {
    return [schema.const];
  }
  return Array.isArray(schema.enum) ? schema.enum : [];
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

interface DeviceAwareToolOptions<T = any> {
  shouldEnsureDevice?: (args: T) => boolean;
  nonDeviceHandler?: ToolHandler<T>;
  outputSchema?: any;
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
  outputSchema?: any;
}

// The registry that holds all tools
class ToolRegistryClass {
  private tools: Map<string, RegisteredTool> = new Map();
  private deviceSessionManager: DeviceSessionManager;
  private cleanupService: AppCleanupService;
  private toolCallRepository: ToolCallRepository;
  private timer: Timer;

  constructor(timer: Timer = defaultTimer) {
    this.deviceSessionManager = DeviceSessionManager.getInstance();
    this.cleanupService = new DefaultAppCleanupService();
    this.toolCallRepository = new ToolCallRepository();
    this.timer = timer;
  }

  private isToolAvailable(tool: RegisteredTool): boolean {
    return !tool.debugOnly || isDebugModeEnabled();
  }

  // Register a new tool
  register(
    name: string,
    description: string,
    schema: any,
    handler: ToolHandler,
    supportsProgress: boolean = false,
    debugOnly: boolean = false,
    outputSchema?: any
  ): void {
    this.tools.set(name, {
      name,
      description,
      schema,
      handler,
      supportsProgress,
      requiresDevice: false,
      debugOnly,
      outputSchema
    });
  }

  // Helper: Get foreground app package name
  private async getForegroundPackageName(device: BootedDevice): Promise<string | null> {
    try {
      const adb = defaultAdbClientFactory.create(device);
      const { stdout } = await adb.executeCommand(
        "shell dumpsys window | grep mCurrentFocus"
      );

      // Parse: "mCurrentFocus=Window{... u0 com.example.app/com.example.Activity}"
      const match = stdout.match(/\s+(\S+)\/\S+\}/);
      return match ? match[1] : null;
    } catch (error) {
      logger.warn(`[ToolRegistry] Failed to get foreground package name: ${error}`);
      return null;
    }
  }

  // Register a device-aware tool
  registerDeviceAware(
    name: string,
    description: string,
    schema: any,
    handler: DeviceAwareToolHandler,
    supportsProgress: boolean = false,
    debugOnly: boolean = false,
    options: DeviceAwareToolOptions = {}
  ): void {
    // Create a wrapper that handles device ID injection
    const wrappedHandler: ToolHandler = async (args: any, progress?: ProgressCallback, signal?: AbortSignal) => {
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

      const toolStartMs = this.timer.now();

      // Extract platform from args, default to "either" for backward compatibility
      let platform: SomePlatform = args.platform || "either";

      if (shouldResolveDevice) {
        const implicitSessionUuid = this.resolveImplicitAutolockSession(platform, sessionUuid, providedDeviceId, mcpSessionId);
        if (implicitSessionUuid) {
          sessionUuid = implicitSessionUuid;
          args.sessionUuid = implicitSessionUuid;
          logger.info(`[ToolRegistry] Resolved implicit autolock session for MCP session ${mcpSessionId}: ${implicitSessionUuid}`);
        }
        await this.enforceSessionUuidForMultipleIos(platform, sessionUuid, providedDeviceId);
        await this.enforceSessionUuidForAutolock(platform, sessionUuid, providedDeviceId);
      }

      logger.info(`[ToolRegistry] Tool ${name} called, sessionUuid=${sessionUuid}, daemonInitialized=${DaemonState.getInstance().isInitialized()}`);
      void this.toolCallRepository.recordToolCall({
        toolName: name,
        timestamp: new Date().toISOString(),
        sessionUuid,
      });

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
          device = await this.deviceSessionManager.ensureDeviceReady(
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
        } catch {
          // CtrlProxy may not be initialized yet — binding is best-effort
        }
      }

      try {
        // Record tool call for navigation graph correlation
        // Only record UI interaction tools that may cause navigation
        // Excludes app lifecycle tools (launchApp, terminateApp, homeScreen, etc.)
        // as they don't represent replayable in-app navigation paths
        const navigationRelevantTools = [
          "tapOn", "swipeOn", "pinchOn", "dragAndDrop",
          "pressButton", "inputText", "clearText", "imeAction"
        ];
        if (navigationRelevantTools.includes(name)) {
          // Extract UI state from the most recent cached observation
          const cachedResult = device
            ? RealObserveScreen.getRecentCachedResultForDevice(device.deviceId)
            : RealObserveScreen.getRecentCachedResult();
          const uiState = new UIStateExtractor().extractFromObservation(cachedResult);
          const navManager = sessionUuid
            ? NavigationGraphManager.getInstanceForSession(sessionUuid)
            : NavigationGraphManager.getInstance();
          navManager.recordToolCall(name, args, uiState);
        }

        let response: any | undefined;
        if (!shouldResolveDevice) {
          if (!options.nonDeviceHandler) {
            throw new ActionableError(`Tool ${name} requires a device.`);
          }
          response = await options.nonDeviceHandler(args, progress, signal);
        } else if (device !== undefined) {
          // Check if memory performance audit mode is enabled
          const memPerfAuditEnabled = serverConfig.isMemPerfAuditEnabled();

          if (memPerfAuditEnabled && device.platform === "android") {
            // Get the foreground app package name
            const packageName = await this.getForegroundPackageName(device);

            if (packageName) {
              logger.info(`[ToolRegistry] Running memory audit for ${packageName} during ${name}`);

              // Create memory audit instance
              const memoryAudit = new MemoryAudit(device);
              const perf = createGlobalPerformanceTracker();

              // Run the handler within memory audit
              const auditResult = await memoryAudit.runAudit(
                packageName,
                name,
                args,
                async () => {
                  response = await handler(device, args, progress, signal);
                },
                perf
              );

              // If audit failed, throw error with diagnostics
              if (!auditResult.passed) {
                const errorMsg = `Memory audit FAILED for ${packageName} during ${name}\n\n${auditResult.diagnostics}`;
                logger.error(`[ToolRegistry] ${errorMsg}`);
                throw new ActionableError(errorMsg);
              }

              logger.info(`[ToolRegistry] Memory audit PASSED for ${packageName} during ${name}`);
            } else {
              logger.warn(`[ToolRegistry] Could not determine foreground app, skipping memory audit for ${name}`);
              response = await handler(device, args, progress, signal);
            }
          } else {
            // Memory audit not enabled or not Android platform, execute normally
            response = await handler(device, args, progress, signal);
          }
        }

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
          logger.info(`[ToolRegistry] ${name} result: success=${unwrapped.success}${unwrapped.success === false ? `, error=${unwrapped.error || "unknown"}` : ""}`);
        }

        // Emit tool call telemetry
        const toolDurationMs = this.timer.now() - toolStartMs;
        TelemetryRecorder.getInstance().recordToolCallEvent({
          timestamp: toolStartMs,
          toolName: name,
          durationMs: toolDurationMs,
          success: toolSuccess,
          error: toolError,
          args: typeof args === "object" ? args : null,
        });

        // Record successful tool call for MCP recording (test plan generation)
        if (toolSuccess) {
          getMcpRecorder()?.record(name, args);
        }

        // After swipeOn executes with lookFor, update the tool call with scroll position
        if (name === "swipeOn" && args.lookFor && response?.success && response?.found) {
          const scrollPosition = UIStateExtractor.createScrollPosition(args);
          if (scrollPosition) {
            const scrollNavManager = sessionUuid
              ? NavigationGraphManager.getInstanceForSession(sessionUuid)
              : NavigationGraphManager.getInstance();
            scrollNavManager.updateScrollPosition(scrollPosition);
          }
        }

        // Update session cache if sessionUuid provided
        if (shouldResolveDevice && sessionUuid && DaemonState.getInstance().isInitialized()) {
          const sessionManager = DaemonState.getInstance().getSessionManager();
          const devicePool = DaemonState.getInstance().getDevicePool();
          const context = await createToolExecutionContext(sessionUuid, sessionManager, devicePool, {
            keepScreenAwake,
            platform: platform === "android" || platform === "ios" ? platform : undefined
          });

          // Cache observation data for certain tools to reduce API calls
          if (name === "observe" && response?.viewHierarchy) {
            await updateSessionCache(context, "lastHierarchy", response.viewHierarchy);
          }
          if (name === "observe" && response?.screenshot) {
            await updateSessionCache(context, "lastScreenshot", response.screenshot);
          }

          // Update last action timestamp for interaction tools
          if (["tapOn", "swipeOn", "pinchOn", "dragAndDrop", "scroll", "inputText", "clearText", "pressButton"].includes(name)) {
            await updateSessionCache(context, "lastActionTime", this.timer.now());
          }
        }

        return response;
      } catch (error) {
        if (error instanceof ActionableError) {
          throw error;
        }
        const deviceContext = device ? ` on device ${device.deviceId}` : "";
        throw new ActionableError(`Failed to execute tool ${name}${deviceContext}: ${error}`);
      } finally {
        if (device && name === "executePlan" && args?.cleanupAppId) {
          await this.cleanupService.cleanup(device, {
            appId: args.cleanupAppId,
            clearAppData: args.cleanupClearAppData,
          });
        }

        // Auto-release session after executePlan completes
        // This frees the device immediately for parallel test execution
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
              // Clean up session-scoped navigation state and observe cache
              NavigationGraphManager.releaseSession(releaseSessionUuid);
              RealObserveScreen.clearCache(deviceId);
              logger.info(`Auto-released session ${session.sessionId} and freed device ${deviceId} after executePlan`);
            }
          } catch (releaseError) {
            // Don't fail the tool if session release fails
            // Session will be cleaned up by timeout mechanism
            logger.warn(`Failed to auto-release session ${sessionUuid}: ${releaseError}`);
          }
        }
      }
    };

    this.tools.set(name, {
      name,
      description,
      schema,
      handler: wrappedHandler,
      supportsProgress,
      requiresDevice: true,
      deviceAwareHandler: handler,
      debugOnly,
      outputSchema: options.outputSchema
    });
  }

  private async enforceSessionUuidForMultipleIos(
    platform: SomePlatform,
    sessionUuid: string | undefined,
    providedDeviceId: string | undefined
  ): Promise<void> {
    if (sessionUuid || providedDeviceId) {
      return;
    }

    // Check if an iOS device was set via setActiveDevice and platform is explicitly ios
    // Only skip the guard when platform === "ios" because ensureDeviceReady only honors
    // the current device when the requested platform matches currentPlatform
    const currentDevice = this.deviceSessionManager.getCurrentDevice();
    const currentPlatform = this.deviceSessionManager.getCurrentPlatform();
    if (currentDevice && currentPlatform === "ios" && platform === "ios") {
      return;
    }

    if (platform !== "ios" && platform !== "either") {
      return;
    }

    const connectedPlatforms = await this.deviceSessionManager.detectConnectedPlatforms();
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

  /**
   * When device pool autolock is enabled, a tool call that does not name a target
   * (no sessionUuid and no deviceId) must not be routed to an arbitrary device if
   * more than one candidate exists — that would defeat the per-session device
   * ownership autolock provides. Resolve the MCP session's autolock session when
   * available; otherwise require the sessionUuid returned by startDevice.
   *
   * No-op when autolock is disabled, when a target is already specified, when a
   * device was pinned via setActiveDevice, or when only one candidate exists.
   */
  private async enforceSessionUuidForAutolock(
    platform: SomePlatform,
    sessionUuid: string | undefined,
    providedDeviceId: string | undefined
  ): Promise<void> {
    if (!isDevicePoolAutolockEnabled()) {
      return;
    }
    if (sessionUuid || providedDeviceId) {
      return;
    }

    // A device pinned via setActiveDevice is an unambiguous target.
    const currentDevice = this.deviceSessionManager.getCurrentDevice();
    const currentPlatform = this.deviceSessionManager.getCurrentPlatform();
    if (currentDevice && (platform === "either" || platform === currentPlatform)) {
      return;
    }

    const connectedPlatforms = await this.deviceSessionManager.detectConnectedPlatforms();
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

  // Get all registered tools
  getAllTools(): RegisteredTool[] {
    return Array.from(this.tools.values()).filter(tool => this.isToolAvailable(tool));
  }

  // Get a specific tool by name
  getTool(name: string): RegisteredTool | undefined {
    const tool = this.tools.get(name);
    if (!tool || !this.isToolAvailable(tool)) {
      return undefined;
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
  getToolDefinitions() {
    const alwaysLoad = process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS === "true";
    return this.getAllTools().map(tool => {
      const outputSchema = tool.outputSchema
        ? flattenTopLevelUnion(toJSONSchema(tool.outputSchema))
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

  // Clear all registered tools (for testing)
  clearTools(): void {
    this.tools.clear();
  }
}

// Export a singleton instance
export const ToolRegistry = new ToolRegistryClass();

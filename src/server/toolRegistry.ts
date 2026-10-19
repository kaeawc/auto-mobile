import type { z, ZodType } from "zod/v4";
import { erased, eraseDeviceAware, erasePlain } from "./toolRegistryErasure";
import type { DeviceReadOnlyArgShape } from "../daemon/deviceReadOnlyArgShapes";
import {
  runWithPostActionCaptureScope,
  postActionCaptures,
} from "../utils/PostActionCaptureContext";
import { toActionableError } from "../models/ActionableError";
import {
  clearToolTransportRecovery,
  setToolTransportRecovery,
  type ToolTransportRecovery,
} from "../daemon/toolTransportRecovery";
import type { ToolRegistryHost, ToolRegistrySchema } from "./registryHost";
import { DeviceReadiness } from "../devices/DeviceReadiness";
import { ActionableError, BootedDevice } from "../models";
import { serverConfig } from "../utils/ServerConfig";

import { logger, type Logger } from "../utils/logger";
import { assertSessionBrokerToolCall } from "./sessionBrokerToolGate";
import "./featureWiring";

import { AppCleanupService, DefaultAppCleanupService } from "./AppCleanupService";
import { ToolCallRepository } from "../db/toolCallRepository";
import type { Environment } from "../daemon/poolConfig";
import { runWithAutolockPolicy } from "../daemon/deviceAutolockPolicy";
import { isDebugModeEnabled } from "../utils/debug";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { advertiseBoundsForCompact } from "./compactBoundsAdvertisement";
import { markInternalToolCall } from "../daemon/internalToolCall";
import { ListChangedBroadcaster, type ServerRegistrationOptions } from "./listChangedBroadcast";
import { StructuredToolResponse } from "../utils/toolUtils";
import {
  InternalToolName,
  InternalToolPayloads,
  narrowInternalToolEnvelope,
} from "../utils/internalToolPayloads";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../features/toolSelection/toolSelectionContext";
import { isDeviceLostError, throwDeviceLostFromAbortSignal } from "../utils/deviceLossOutcome";
import { nonBlankSessionUuid } from "./planCallerIdentity";
import { executionTracker } from "../daemon/executionTracker";
import { isAlwaysOnTool } from "../features/toolSelection/toolSelectionControl";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";
import {
  applyInheritedPlanRequestParams,
  toAdvertisedJsonSchema,
  addSpillArtifactToAdvertisedOutputSchema,
} from "./pipeline/advertisedSchema";
import {
  ExecutionTargetResolver,
  DefaultExecutionTargetResolver,
} from "./pipeline/executionTarget";
import { AuditRunner, DefaultAuditRunner } from "./pipeline/audit";
import {
  NavigationToolCallRecorder,
  DefaultNavigationToolCallRecorder,
} from "./pipeline/navigationRecording";
import {
  AfterToolCallHandler,
  isToolResponseFailure,
  DefaultAfterToolCallHandler,
} from "./pipeline/afterToolCall";
import {
  SessionBindingReleaseHandler,
  PlanLifecycleInput,
  PlanLifecycleManager,
  DefaultPlanLifecycleManager,
} from "./pipeline/planLifecycle";
import { holdSessionForCurrentTask } from "./tasks/runAsTask";
import {
  isDeviceReadOnlyCall,
  isReadOnlyCall,
  resolveCallerDeviceIds,
  isDeviceIdControlCall,
} from "./pipeline/readTarget";
import {
  deviceAwareHandlerArgs,
  refuseInternalControlOnForeignOwnedSession,
  assertInternalCallWithinBrokerGrant,
  sessionDisplayPinnedHandler,
  invokeResolvedDeviceHandler,
} from "./pipeline/deviceCallDispatch";

export type { AuditRunnerInput } from "./pipeline/audit";
export { stripNavigationInternalParams } from "./pipeline/navigationRecording";
export {
  AUTOMATIC_TOOL_OUTPUT_RETENTION,
  DefaultAfterToolCallHandler,
} from "./pipeline/afterToolCall";
export type {
  SessionBindingReleaseHandler,
  PlanLifecycleInput,
  PlanCleanupFailure,
  PlanCleanupOutcome,
} from "./pipeline/planLifecycle";
export { DefaultAuditRunner } from "./pipeline/audit";
export type { SettleObserveFactory } from "./pipeline/afterToolCall";
export {
  PLAN_APP_CLEANUP_CAP_MS,
  PLAN_APP_CLEANUP_RETRY_DEADLINE_MS,
  DefaultPlanLifecycleManager,
} from "./pipeline/planLifecycle";
export { flattenTopLevelUnion } from "./TopLevelUnionFlattener";

import {
  ProgressCallback,
  ToolHandler,
  DeviceAwareToolHandler,
  InternalToolCallOptions,
  InternalToolInvocationContext,
  PLAN_ONLY_GATE_REASON,
  shadowedSdkToolCallback,
  PlainToolOptions,
  pickToolTraits,
  DeviceAwareToolOptions,
  ToolListingOptions,
  CachedToolDefinitionSchemas,
  RegisteredTool,
  deviceReadOnlyMetadata,
  toolHasOutputSchema,
  ToolRegistryCollaborators,
  ToolRegistryPipelineOverrides,
  withItemsEnum,
} from "./toolRegistryTypes";
import { isAlwaysLoadToolsEnabled } from "../config/alwaysLoadTools";
export type {
  ProgressCallback,
  DeviceAwareToolHandler,
  PlainToolOptions,
  SessionlessDeviceRead,
  ToolTraits,
  DeviceAwareToolOptions,
  RegisteredTool,
  ToolRegistryCollaborators,
} from "./toolRegistryTypes";
export { toolHasOutputSchema } from "./toolRegistryTypes";
export { isRecord } from "./pipeline/isRecord";

// The registry that holds all tools
export class ToolRegistryClass {
  private tools: Map<string, RegisteredTool> = new Map();
  // Every live MCP server this registry has been registered with. In daemon
  // mode `registerWithServer` runs once per HTTP session, so notifications must
  // fan out to ALL live sessions — a single retained server would be
  // last-writer-wins (issue #3223). Entries are pruned via the underlying
  // server's onclose hook when a session's transport closes.
  private servers: Set<ToolRegistryHost> = new Set();
  // Per-request servers (#4678), tracked only until they close and never sent
  // list_changed; see ServerRegistrationOptions.
  private ephemeralServers: Set<ToolRegistryHost> = new Set();
  // Per-transport server-side session-binding teardown handlers (issue #4611 Gap
  // D). `createMcpServer` registers one per loopback transport; the plan-release
  // path fans a released session UUID out to all of them so each transport's
  // SessionToolBinding drops the stale session. Pruned via the returned
  // unsubscribe on transport close, mirroring the `servers` set above.
  private sessionBindingReleaseHandlers: Set<SessionBindingReleaseHandler> = new Set();
  // Stable aggregate handed to the plan-lifecycle input so afterExecution can
  // fan a released session out to every registered transport handler.
  private readonly sessionBindingReleaseNotifier: SessionBindingReleaseHandler = {
    onSessionReleased: (sessionUuid) => this.notifySessionBindingReleased(sessionUuid),
  };
  private deviceSessionManager: DeviceReadiness;
  private cleanupService: AppCleanupService;
  private toolCallRepository: Pick<ToolCallRepository, "recordToolCall">;
  private timer: Timer;
  private readonly logger: Logger;
  private env?: Environment;
  private executionTargetResolver: ExecutionTargetResolver;
  private auditRunner: AuditRunner;
  private navigationToolCallRecorder: NavigationToolCallRecorder;
  private afterToolCall: AfterToolCallHandler;
  private planLifecycleManager: PlanLifecycleManager;
  private readonly isResponseFailure = (response: unknown): boolean =>
    isToolResponseFailure(response);
  private toolDefinitionSchemaCache: Map<string, CachedToolDefinitionSchemas> = new Map();
  private toolDefinitionSchemaBuilds = 0;
  private removalEpoch = 0;

  constructor(timer: Timer = defaultTimer, loggerInstance: Logger = logger) {
    this.deviceSessionManager = DeviceReadiness.getInstance();
    this.cleanupService = new DefaultAppCleanupService();
    this.toolCallRepository = new ToolCallRepository();
    this.timer = timer;
    this.logger = loggerInstance;
    this.executionTargetResolver = new DefaultExecutionTargetResolver(loggerInstance);
    this.auditRunner = new DefaultAuditRunner(loggerInstance);
    this.navigationToolCallRecorder = new DefaultNavigationToolCallRecorder();
    this.afterToolCall = new DefaultAfterToolCallHandler();
    this.planLifecycleManager = new DefaultPlanLifecycleManager(timer);
  }

  setToolCallRepositoryForTesting(repository: Pick<ToolCallRepository, "recordToolCall">): void {
    this.toolCallRepository = repository;
  }

  /**
   * Test seam: the collaborators suites swap on the singleton, so a test can save the
   * originals and restore them with {@link setCollaboratorsForTesting}.
   */
  getCollaboratorsForTesting(): ToolRegistryCollaborators {
    return {
      deviceSessionManager: this.deviceSessionManager,
      toolCallRepository: this.toolCallRepository,
      timer: this.timer,
      navigationToolCallRecorder: this.navigationToolCallRecorder,
      afterToolCall: this.afterToolCall,
    };
  }

  /**
   * Test seam: replace the named collaborators; omitted ones are left alone. Test doubles
   * usually implement only the members under test, so they are accepted as `Partial` and
   * narrowed here, in the one place. The after-tool-call handler is replaced through
   * `setPipelineOverridesForTesting`.
   */
  setCollaboratorsForTesting(overrides: {
    deviceSessionManager?: Partial<DeviceReadiness>;
    toolCallRepository?: Pick<ToolCallRepository, "recordToolCall">;
    timer?: Timer;
    navigationToolCallRecorder?: Partial<NavigationToolCallRecorder>;
  }): void {
    this.deviceSessionManager =
      (overrides.deviceSessionManager as DeviceReadiness | undefined) ?? this.deviceSessionManager;
    this.toolCallRepository = overrides.toolCallRepository ?? this.toolCallRepository;
    this.timer = overrides.timer ?? this.timer;
    this.navigationToolCallRecorder =
      (overrides.navigationToolCallRecorder as NavigationToolCallRecorder | undefined) ??
      this.navigationToolCallRecorder;
  }

  /** Shared availability evidence for discovery, call rejection, and selection validation. */
  getToolAvailabilityGateReasons(tool: RegisteredTool): string[] {
    const reasons: string[] = [];
    if (tool.debugOnly && !isDebugModeEnabled()) {
      reasons.push("--debug is disabled; start the daemon with --debug");
    }
    if (tool.embeddedSdkOnly && !serverConfig.isEmbeddedSdkEnabled()) {
      reasons.push("embedded SDK mode is disabled; start the daemon with --embedded-sdk");
    }
    if (tool.planOnly) {
      reasons.push(PLAN_ONLY_GATE_REASON);
    }
    return reasons;
  }

  private isToolAvailable(tool: RegisteredTool): boolean {
    return this.getToolAvailabilityGateReasons(tool).length === 0;
  }

  private toolReachable(
    tool: RegisteredTool,
    context: "list" | "call" | "plan" | "register",
    options: { includeUnavailable?: boolean } = {},
  ): boolean {
    switch (context) {
      case "list":
      case "register":
        // `includeUnavailable` skips availability gates, but never discovery hiding.
        return !tool.hidden && (options.includeUnavailable === true || this.isToolAvailable(tool));
      case "call":
        // Hidden tools remain directly callable; availability gates still apply.
        return this.isToolAvailable(tool);
      case "plan":
        // Plans may use explicitly plan-executable tools through availability gates.
        return this.isToolAvailable(tool) || tool.planExecutable === true;
    }
  }

  // Register a new tool
  register<S extends ZodType>(
    name: string,
    description: string,
    inSchema: S,
    inHandler: ToolHandler<z.output<S>>,
    inOptions: PlainToolOptions<z.output<S>> = {},
  ): void {
    const { schema, handler, options } = erasePlain(inSchema, inHandler, inOptions);
    this.invalidateToolDefinitionSchemaCache();
    if (this === ToolRegistry) {
      setToolTransportRecovery(name, options.transportRecovery);
    }
    this.tools.set(name, {
      name,
      description,
      schema,
      handler: async (args, progress, signal) => {
        await assertSessionBrokerToolCall(name, false, args);
        return handler(args, progress, signal);
      },
      defaultEnabled: options.defaultEnabled ?? true,
      defaultDeclared: options.defaultEnabled !== undefined,
      supportsProgress: options.supportsProgress ?? false,
      transportRecovery: options.transportRecovery,
      requiresDevice: false,
      isDeviceReadOnlyCall: (args) => isReadOnlyCall(options.readOnly, args),
      ...deviceReadOnlyMetadata(options.readOnly, options.deviceReadOnlyArgs),
      debugOnly: options.debugOnly ?? false,
      hidden: options.hidden ?? false,
      embeddedSdkOnly: false,
      acceptsPlanLockNamespace: options.acceptsPlanLockNamespace ?? false,
      outputSchema: options.outputSchema,
      appUiResourceUri: options.appUiResourceUri,
    });
  }

  /** Remove one test-only or dynamically registered tool without disturbing the registry. */
  unregister(name: string): void {
    this.invalidateToolDefinitionSchemaCache();
    this.removalEpoch++;
    if (this === ToolRegistry) {
      setToolTransportRecovery(name, undefined);
    }
    this.tools.delete(name);
  }

  private prepareDeviceAwareRegistration(
    name: string,
    options: DeviceAwareToolOptions,
  ): ToolTransportRecovery {
    this.invalidateToolDefinitionSchemaCache();
    const recovery = options.transportRecovery ?? "connect";
    if (this === ToolRegistry) {
      setToolTransportRecovery(name, recovery);
    }
    return recovery;
  }

  /** Run the plan lifecycle (cleanup, auto-release) after a device-aware call settles. */
  private async afterPlanLifecycle(
    input: Omit<
      PlanLifecycleInput,
      "cleanupService" | "sessionBindingReleaseHandler" | "sessionToolSelectionService"
    >,
  ): Promise<void> {
    await this.planLifecycleManager.afterExecution({
      ...input,
      cleanupService: this.cleanupService,
      sessionBindingReleaseHandler: this.sessionBindingReleaseNotifier,
      sessionToolSelectionService: getToolSelectionContext()?.sessionToolSelectionService,
    });
  }

  // Register a device-aware tool
  registerDeviceAware<S extends ZodType>(
    name: string,
    description: string,
    inSchema: S,
    inHandler: DeviceAwareToolHandler<z.output<S>>,
    inOptions: DeviceAwareToolOptions<z.output<S>> = {},
  ): void {
    const { schema, handler, options } = eraseDeviceAware(inSchema, inHandler, inOptions);
    const pinnedHandler = sessionDisplayPinnedHandler({ name, schema, handler });
    const traits = pickToolTraits(options);
    // Device-aware tools may reconnect before dispatch. Replaying an ambiguous
    // delivery requires an explicit per-tool opt-in.
    const transportRecovery = this.prepareDeviceAwareRegistration(name, options);
    // Create a wrapper that handles device ID injection
    const wrappedHandler: ToolHandler = async (args, progress, signal) => {
      const selectionContext = getToolSelectionContext();
      // Re-inject the ambient ROUTING session (issue #4611 Gap C) so a nested
      // device-aware call keeps the outer call's derived/label routing identity
      // rather than reverting to the base session.
      const handlerArgs = deviceAwareHandlerArgs(args, options, selectionContext, name);
      const toolStartMs = this.timer.now();
      const toolCallTimestamp = new Date().toISOString();
      let toolDurationMs: number | undefined;
      let sessionUuid =
        typeof handlerArgs.sessionUuid === "string" ? handlerArgs.sessionUuid : undefined;

      try {
        await assertSessionBrokerToolCall(name, true, handlerArgs);
        const resolvedTarget = await this.executionTargetResolver.resolveExecutionTarget({
          name,
          args: handlerArgs,
          options,
          deviceSessionManager: this.deviceSessionManager,
          signal,
          timer: this.timer,
        });
        signal?.throwIfAborted();
        sessionUuid = resolvedTarget.sessionUuid;
        // Under an MCP task, keep this session alive until the task settles (#4668).
        holdSessionForCurrentTask(sessionUuid);
        if (selectionContext?.execution && !selectionContext.deviceAwareDispatch && !sessionUuid) {
          executionTracker.setResolvedAutolockSessionUuid(
            selectionContext.execution.executionId,
            undefined,
          );
        }
        const captures = postActionCaptures(signal, resolvedTarget.internalCall, name);
        return await runWithToolSelectionContext(
          // Bind the ROUTING session, not the selection profile, so
          // nested calls re-inject the correct derived routing UUID.
          {
            deviceAwareDispatch: true,
            routingSessionUuid: resolvedTarget.sessionUuid,
            toolSelectionProfileUuid: selectionContext?.toolSelectionProfileUuid,
            // Handlers read this to stay on their read-only path (observe, snapshotOf).
            explicitObserveDeviceRead:
              (selectionContext?.explicitObserveDeviceRead === true && !handlerArgs.sessionUuid) ||
              resolvedTarget.deviceRead !== undefined,
          },
          captures(async () => {
            let succeeded = false;
            try {
              let response: unknown;
              if (!resolvedTarget.shouldResolveDevice) {
                if (!options.nonDeviceHandler) {
                  throw new ActionableError(`Tool ${name} requires a device.`);
                }
                response = await options.nonDeviceHandler(handlerArgs, progress, signal);
              } else if (resolvedTarget.device !== undefined) {
                response = await invokeResolvedDeviceHandler({
                  target: { ...resolvedTarget, device: resolvedTarget.device },
                  name,
                  args: handlerArgs,
                  handler: pinnedHandler,
                  progress,
                  signal,
                  auditRunner: this.auditRunner,
                  navigationRecorder: this.navigationToolCallRecorder,
                  traits,
                  isResponseFailure: this.isResponseFailure,
                });
                if (resolvedTarget.deviceRead) {
                  signal?.throwIfAborted();
                  resolvedTarget.deviceRead.assertAuthorized(resolvedTarget.device);
                }
              }

              // A late device-loss abort cannot replace a completed success.
              // A resolved failure can have swallowed device-loss cancellation,
              // so it is checked after the response is finalized below.

              const afterToolCallResult = await this.afterToolCall.handle({
                name,
                traits,
                outputSchema: this.getToolOutputSchema(name),
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
              if (this.isResponseFailure(afterToolCallResult.finalizedResponse)) {
                throwDeviceLostFromAbortSignal(signal);
              }
              succeeded = !this.isResponseFailure(afterToolCallResult.finalizedResponse);
              return afterToolCallResult.finalizedResponse;
            } catch (error) {
              throwDeviceLostFromAbortSignal(signal);
              if (error instanceof ActionableError || isDeviceLostError(error)) {
                throw error;
              }
              const deviceContext = resolvedTarget.device
                ? ` on device ${resolvedTarget.device.deviceId}`
                : "";
              throw toActionableError(error, `Failed to execute tool ${name}${deviceContext}`);
            } finally {
              await this.afterPlanLifecycle({
                ...resolvedTarget,
                name,
                args: handlerArgs,
                nestedInPlan: selectionContext?.planRequest !== undefined,
                succeeded,
              });
            }
          }),
        );
      } finally {
        this.recordCompletedCall(
          name,
          toolCallTimestamp,
          sessionUuid,
          toolDurationMs ?? this.timer.now() - toolStartMs,
        );
      }
    };

    this.tools.set(name, {
      name,
      description,
      schema,
      handler: this.withAutolockPolicy(wrappedHandler),
      defaultEnabled: options.defaultEnabled ?? true,
      defaultDeclared: options.defaultEnabled !== undefined,
      supportsProgress: options.supportsProgress ?? false,
      transportRecovery,
      requiresDevice: true,
      deviceAwareHandler: handler,
      isDeviceReadOnlyCall: (args) => isDeviceReadOnlyCall(options, args),
      debugOnly: options.debugOnly ?? false,
      embeddedSdkOnly: options.embeddedSdkOnly ?? false,
      planExecutable: options.planExecutable ?? false,
      planOnly: options.planOnly ?? false,
      ...traits,
      hidden: options.hidden ?? false,
      acceptsPlanLockNamespace: options.acceptsPlanLockNamespace ?? false,
      outputSchema: options.outputSchema,
      appUiResourceUri: options.appUiResourceUri,
      ...deviceReadOnlyMetadata(options.deviceReadOnly, options.deviceReadOnlyArgs),
    });
  }

  private recordCompletedCall(
    name: string,
    timestamp: string,
    sessionUuid: string | undefined,
    durationMs: number,
  ): void {
    void Promise.resolve()
      .then(() =>
        this.toolCallRepository.recordToolCall({
          toolName: name,
          timestamp,
          sessionUuid,
          durationMs,
        }),
      )
      .catch((error: unknown) => {
        logger.warn(`[ToolRegistry] Failed to record tool call for ${name}: ${error}`);
      });
  }

  // Get all registered tools
  getAllTools(options: ToolListingOptions = {}): RegisteredTool[] {
    const tools = Array.from(this.tools.values());
    return tools.filter((tool) => this.toolReachable(tool, "list", options));
  }

  /**
   * Every registered tool, hidden and availability-gated ones included. For audits that must not
   * miss a tool that discovery hides (e.g. the read/control classification lint, #11353).
   */
  getEveryRegisteredTool(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }

  getConfigurableToolNames(): string[] {
    return Array.from(this.tools.values())
      .filter((tool) => this.isUserConfigurableTool(tool.name))
      .map((tool) => tool.name);
  }

  getToolsMissingDeclaredDefault(): string[] {
    return Array.from(this.tools.values())
      .filter((tool) => !tool.defaultDeclared)
      .map((tool) => tool.name);
  }

  isUserConfigurableTool(name: string): boolean {
    const tool = this.tools.get(name);
    return Boolean(tool && !tool.hidden && !tool.planOnly && !isAlwaysOnTool(tool.name));
  }

  getRegisteredTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Output schemas are execution metadata, so lookup deliberately bypasses the
   * availability gate used for discovery. A tool that just ran can be hidden or
   * plan-only and must still preserve its required spill residue.
   */
  getToolOutputSchema(name: string): unknown {
    return this.tools.get(name)?.outputSchema;
  }

  // Get a specific tool by name
  getTool(name: string): RegisteredTool | undefined {
    const tool = this.tools.get(name);
    if (!tool || !this.toolReachable(tool, "call")) {
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
  /**
   * The MCP ingress's use of the one device-id resolver (#11618): a `tools/call`'s arguments with
   * the device ids they name as the pool's canonical ids, before the server routes, judges or
   * queues the call. Covers plain tools, which no execution-target resolver sees, and a client
   * that reaches the daemon's MCP endpoint without the socket server in front of it.
   */
  resolveToolCallDeviceIds(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Record<string, unknown> | Promise<Record<string, unknown>> {
    return resolveCallerDeviceIds(args, {
      control: isDeviceIdControlCall(tool, args),
      signal,
      timer: this.timer,
    });
  }

  async callInternal(
    tool: string | RegisteredTool,
    args: Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    options: InternalToolCallOptions = {},
  ): Promise<unknown> {
    const resolved =
      typeof tool === "string"
        ? options.forPlan
          ? this.getToolForPlan(tool)
          : this.getTool(tool)
        : tool;
    if (!resolved) {
      throw new ActionableError(`Tool not found: ${tool}`);
    }
    // A device-aware tool resolves its own `deviceId` in the execution-target resolver; a plain
    // tool (`setActiveDevice`, `killDevice`, `startDevice`) never reaches it, and the broker binding
    // gate below reads the same arguments.
    const callArgs = resolved.requiresDevice
      ? args
      : resolveCallerDeviceIds(args, {
          control: isDeviceIdControlCall(resolved, args),
          signal,
          timer: this.timer,
        });
    const invocation = this.createInternalToolInvocationContext(
      callArgs instanceof Promise ? await callArgs : callArgs,
      options,
    );
    await assertSessionBrokerToolCall(
      resolved.name,
      resolved.requiresDevice === true,
      invocation.args,
    );
    assertInternalCallWithinBrokerGrant(resolved.name, invocation);
    refuseInternalControlOnForeignOwnedSession(
      resolved,
      nonBlankSessionUuid(args.sessionUuid),
      invocation,
    );

    return runWithToolSelectionContext(invocation, () =>
      runWithPostActionCaptureScope(
        signal,
        () =>
          this.invokeInternalTool(
            resolved,
            invocation.args,
            progress ?? getToolSelectionContext()?.planRequest?.progress,
            signal,
            options.targetDevice,
          ),
        false,
      ),
    );
  }

  private withAutolockPolicy(handler: ToolHandler): ToolHandler {
    return (args, progress, signal) =>
      runWithAutolockPolicy(this.env, () => handler(args, progress, signal));
  }

  private createInternalToolInvocationContext(
    args: Record<string, unknown>,
    options: InternalToolCallOptions,
  ): InternalToolInvocationContext {
    const context = getToolSelectionContext();
    const request = context?.planRequest;
    if (request) {
      args = applyInheritedPlanRequestParams(args, request);
    }
    // An internal call inherits the ambient ROUTING session (issue #4611 Gap C)
    // so a plan step or navigation replay routes to the same derived/label
    // session the outer call resolved to, not the base session.
    // A blank session names none (#11469), so it never replaces the one below it.
    const sessionUuid =
      nonBlankSessionUuid(options.sessionUuid) ??
      nonBlankSessionUuid(context?.routingSessionUuid) ??
      nonBlankSessionUuid(args.sessionUuid);
    return {
      args: sessionUuid && args.sessionUuid !== sessionUuid ? { ...args, sessionUuid } : args,
      routingSessionUuid: sessionUuid,
      toolSelectionProfileUuid: context?.toolSelectionProfileUuid,
      sessionToolSelectionService:
        options.sessionToolSelectionService ?? context?.sessionToolSelectionService,
    };
  }

  private async invokeInternalTool(
    tool: RegisteredTool,
    args: Record<string, unknown>,
    progress: ProgressCallback | undefined,
    signal: AbortSignal | undefined,
    targetDevice: BootedDevice | undefined,
  ): Promise<unknown> {
    if (targetDevice && tool.deviceAwareHandler) {
      const pinnedHandler = sessionDisplayPinnedHandler({
        name: tool.name,
        schema: tool.schema,
        handler: tool.deviceAwareHandler,
      });
      return pinnedHandler(targetDevice, markInternalToolCall(args), progress, signal);
    }
    return tool.handler(markInternalToolCall(args), progress, signal);
  }

  // Typed variant of `callInternal` for internally-consumed tools whose envelope a caller then
  // reads (issue #3222): threads the concrete `InternalToolPayloads` type through the registry
  // seam, so `callInternalTyped("swipeOn", …)` resolves to
  // `StructuredToolResponse<SwipeOnToolPayload> | undefined` instead of the untyped `Promise<any>`
  // and `getStructuredField` keys are checked against the payload. It delegates to `callInternal`
  // (keeping the #3108 `markInternalToolCall` guarantee) and validates the shape at runtime via
  // `narrowInternalToolEnvelope` — there is NO unchecked `any`→typed cast. A response that is not
  // envelope-shaped narrows to `undefined`, which the read sites already handle.
  async callInternalTyped<K extends InternalToolName>(
    name: K,
    args: Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    options: InternalToolCallOptions = {},
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
    if (!this.toolReachable(tool, "plan")) {
      return undefined;
    }
    // A `planOnly` tool is hidden from discovery by design and is expected in
    // plans, so don't warn about that reason — only surface *other* gate reasons
    // (e.g. a debug-only tool being used inside a plan), which are noteworthy.
    const unexpectedReasons = gateReasons.filter((r) => r !== PLAN_ONLY_GATE_REASON);
    if (unexpectedReasons.length > 0) {
      logger.warn(
        `[ToolRegistry] Plan execution is using gated tool "${name}" (${unexpectedReasons.join(", ")}). Tool is hidden from normal MCP discovery but marked planExecutable.`,
      );
    }
    return tool;
  }

  // Register all tools with an MCP server. This advertises the tools
  // capability and schemas only: the server's one `tools/call` handler is
  // installed by `installToolCallDispatcher` (#6545) and replaces the SDK's
  // per-tool dispatch, so the callback below is never live.
  registerWithServer(server: ToolRegistryHost, options: ServerRegistrationOptions = {}): void {
    // Retained so runtime changes that alter tool definitions can emit
    // notifications/tools/list_changed (issue #2963) to EVERY live session, not
    // just the most recently created one (issue #3223), mirroring how
    // ResourceRegistry retains its servers for resources/list_changed.
    this.trackServer(server, options.ephemeral === true);

    this.tools.forEach((tool) => {
      if (!this.toolReachable(tool, "register")) {
        return;
      }

      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: erased<ToolRegistrySchema>(tool.schema),
          ...(isAlwaysLoadToolsEnabled() && { _meta: { "anthropic/alwaysLoad": true } }),
        },
        shadowedSdkToolCallback,
      );
    });
  }

  // Track a server for list-changed fan-out and prune it when its session's
  // transport closes. The underlying Protocol preserves a pre-set `onclose`
  // (both the transport's and the server's), so chaining here cannot clobber
  // other lifecycle hooks — and vice versa.
  private trackServer(server: ToolRegistryHost, ephemeral: boolean): void {
    if (this.servers.has(server) || this.ephemeralServers.has(server)) {
      return;
    }
    const tracked = ephemeral ? this.ephemeralServers : this.servers;
    tracked.add(server);
    const underlying = server.server;
    const existingOnClose = underlying.onclose;
    underlying.onclose = () => {
      tracked.delete(server);
      existingOnClose?.();
    };
  }

  /**
   * Stop tracking a server without waiting for its transport to close. A server
   * closed before it ever connected has no transport, so the SDK never fires its
   * `onclose` and the prune hook installed by `trackServer` would not run.
   */
  untrackServer(server: ToolRegistryHost): void {
    this.servers.delete(server);
    this.ephemeralServers.delete(server);
  }

  // Test-only: drop tracked servers so suites sharing the singleton stay hermetic.
  clearServersForTesting(): void {
    this.servers.clear();
    this.ephemeralServers.clear();
  }

  /** Test-only: how many live servers are tracked, so suites can prove none leak. */
  trackedServerCountsForTesting(): { notified: number; ephemeral: number } {
    return { notified: this.servers.size, ephemeral: this.ephemeralServers.size };
  }

  /** Test-only: forget every registered tool so a suite can register just the tools it exercises. */
  clearToolsForTesting(): void {
    this.removalEpoch++;
    this.tools.clear();
  }

  /** Test-only: put a previously captured tool back under its own name, replacing any current one. */
  setRegisteredToolForTesting(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  /** Test-only: unregister one tool by name; a no-op when it was never registered. */
  removeToolForTesting(name: string): void {
    this.removalEpoch++;
    this.tools.delete(name);
  }

  /**
   * Counts every removal from the registry. A caller that registered a fixed tool
   * set once (see `registerMcpTools`) re-registers only when this has moved,
   * since a removal is the one way that set can stop being present.
   */
  get removalEpochForRegistration(): number {
    return this.removalEpoch;
  }

  /** Test-only: how many per-tool schema builds `getToolDefinitions` has performed. */
  schemaBuildCountForTesting(): number {
    return this.toolDefinitionSchemaBuilds;
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
        logger.warn(
          `[ToolRegistry] session-binding release handler failed for ${sessionUuid}: ${error}`,
        );
      }
    }
  }

  /** Test-only: how many session-binding release handlers are live, so suites can prove none leak. */
  sessionBindingReleaseHandlerCountForTesting(): number {
    return this.sessionBindingReleaseHandlers.size;
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
    const alwaysLoad = isAlwaysLoadToolsEnabled();
    // When tool results are stripped of `structuredContent` (issue #2899), do not
    // advertise an `outputSchema` in `tools/list`: an MCP server that declares an
    // output schema is expected to return matching `structuredContent`, so keeping
    // both consistent avoids advertising output the finalize step will strip.
    const suppressOutputSchema =
      options.suppressOutputSchema ?? serverConfig.isToolResultsNoStructuredContentEnabled();
    // Bounds compaction is now an unconditional default, so the tuple arm is always
    // emitted and therefore always advertised — keeping the advertised shape in sync
    // with the wire (issue #2990), the same way `suppressOutputSchema` above keeps the
    // two in sync for the strip flag.
    const compactBounds = true;
    const listedTools = this.getAllTools(options);
    const configurableToolNames = listedTools
      .filter((tool) => this.isUserConfigurableTool(tool.name))
      .map((tool) => tool.name)
      .sort();
    return listedTools.map((tool) => {
      const { inputSchema, outputSchema } = this.getCachedToolDefinitionSchemas(
        tool,
        suppressOutputSchema,
        compactBounds,
      );

      const definition: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        _meta?: {
          "anthropic/alwaysLoad"?: boolean;
          "automobile/debugOnly"?: boolean;
          "automobile/embeddedSdkOnly"?: boolean;
          "automobile/planOnly"?: boolean;
          "automobile/deviceReadOnly"?: boolean;
          "automobile/deviceReadOnlyArgs"?: readonly DeviceReadOnlyArgShape[];
          ui?: { resourceUri: string };
        };
      } = {
        name: tool.name,
        description: tool.description,
        inputSchema,
      };
      // Keep the compact enabled-tool profile while making optional capabilities
      // discoverable through the always-listed selection control (#6797).
      // Copy the cached schema: availability can change between listings.
      definition.inputSchema = this.withConfigurableToolVocabulary(
        tool.name,
        inputSchema,
        configurableToolNames,
      );
      if (outputSchema) {
        definition.outputSchema = outputSchema;
      }
      if (alwaysLoad) {
        definition._meta = { ...definition._meta, "anthropic/alwaysLoad": true };
      }
      // The committed static catalog includes unavailable tools for schema
      // completeness. Preserve enough generated metadata for the proxy to
      // exclude plan-only tools after a live connection is available.
      if (tool.planOnly) {
        definition._meta = { ...definition._meta, "automobile/planOnly": true };
      }
      if (tool.debugOnly) {
        definition._meta = { ...definition._meta, "automobile/debugOnly": true };
      }
      if (tool.embeddedSdkOnly) {
        definition._meta = { ...definition._meta, "automobile/embeddedSdkOnly": true };
      }
      // Read/control classification for the proxy (#10971) — additive; other clients ignore it.
      if (tool.deviceReadOnly === true) {
        definition._meta = { ...definition._meta, "automobile/deviceReadOnly": true };
      } else if (tool.deviceReadOnlyArgs?.length) {
        definition._meta = {
          ...definition._meta,
          "automobile/deviceReadOnlyArgs": tool.deviceReadOnlyArgs,
        };
      }
      // MCP Apps UI pointer (issue #4669) — additive; non-Apps hosts ignore it.
      if (tool.appUiResourceUri) {
        definition._meta = { ...definition._meta, ui: { resourceUri: tool.appUiResourceUri } };
      }
      return definition;
    });
  }

  /**
   * Decorate the advertised schema with the enum of tool names this listing
   * accepts, so a schema-driven client cannot build a call the handler rejects.
   *
   * Two fields carry that vocabulary: `setToolEnabled`'s `toolName`/`toolNames`
   * (#6797, #6869) and the `enableTools` array the device-acquisition tools
   * (`getAndroid`, `getApple`, `provisionDevice`) take so acquisition and
   * capability declaration are one call. `resolveRequestedEnableTools` rejects
   * every unknown or non-configurable name before any device work starts, so
   * advertising "any non-empty string" there both allowed schema-valid calls
   * that invocation refuses and hid the vocabulary of the one-call flow
   * (#6886 review). Detected by the field's presence rather than a hardcoded
   * tool list, so a future acquisition tool is covered by declaring the field.
   */
  private withConfigurableToolVocabulary(
    toolName: string,
    inputSchema: Record<string, unknown>,
    configurableToolNames: string[],
  ): Record<string, unknown> {
    const properties = inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    if (!properties) {
      return inputSchema;
    }
    if (toolName === SET_TOOL_ENABLED_TOOL_NAME) {
      return {
        ...inputSchema,
        properties: {
          ...properties,
          toolName: { ...properties.toolName, enum: configurableToolNames },
          // #6869 — the batch spelling carries the same vocabulary, so a
          // client declaring a whole toolset in one call reads the choices
          // from the field it is actually filling in.
          toolNames: withItemsEnum(properties.toolNames, configurableToolNames),
        },
      };
    }
    if (!properties.enableTools) {
      return inputSchema;
    }
    return {
      ...inputSchema,
      properties: {
        ...properties,
        enableTools: withItemsEnum(properties.enableTools, configurableToolNames),
      },
    };
  }

  private getCachedToolDefinitionSchemas(
    tool: RegisteredTool,
    suppressOutputSchema: boolean,
    compactBounds: boolean,
  ): { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> | undefined } {
    let cached = this.toolDefinitionSchemaCache.get(tool.name);
    if (!cached) {
      this.toolDefinitionSchemaBuilds++;
      cached = {
        inputSchema: toAdvertisedJsonSchema(tool.schema, {
          constrainAppIds: true,
          anthropicSubset: true,
          exposeDeviceId: tool.name === "observe",
        }),
        outputSchemasByRuntimeFlags: new Map(),
      };
      this.toolDefinitionSchemaCache.set(tool.name, cached);
    }

    const outputSchemaCacheKey = `${suppressOutputSchema}:${compactBounds}`;
    if (!cached.outputSchemasByRuntimeFlags.has(outputSchemaCacheKey)) {
      const outputSchema =
        toolHasOutputSchema(tool) && !suppressOutputSchema
          ? (advertiseBoundsForCompact(
              addSpillArtifactToAdvertisedOutputSchema(
                toAdvertisedJsonSchema(tool.outputSchema, { constrainAppIds: false }),
              ),
              compactBounds,
            ) as Record<string, unknown>)
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

  // Get the device session manager
  getDeviceSessionManager(): DeviceReadiness {
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
      env: this.env,
      executionTargetResolver: this.executionTargetResolver,
      auditRunner: this.auditRunner,
      afterToolCall: this.afterToolCall,
      planLifecycleManager: this.planLifecycleManager,
    };

    this.env = overrides.env ?? this.env;
    if (overrides.executionTargetResolver) {
      this.executionTargetResolver = overrides.executionTargetResolver;
    } else if (overrides.displayInventory || overrides.deviceReadAccess) {
      this.executionTargetResolver = new DefaultExecutionTargetResolver(
        this.logger,
        overrides.displayInventory,
        overrides.deviceReadAccess,
      );
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
      this.env = previous.env;
      this.executionTargetResolver = previous.executionTargetResolver;
      this.auditRunner = previous.auditRunner;
      this.afterToolCall = previous.afterToolCall;
      this.planLifecycleManager = previous.planLifecycleManager;
    };
  }

  // Clear all registered tools (for testing)
  clearTools(): void {
    this.invalidateToolDefinitionSchemaCache();
    this.removalEpoch++;
    this.tools.clear();
    if (this === ToolRegistry) {
      clearToolTransportRecovery();
    }
  }

  getToolTransportRecovery(name: string): ToolTransportRecovery | undefined {
    return this.tools.get(name)?.transportRecovery;
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

type _ResolvedTypedEnvelope = NonNullable<
  Awaited<ReturnType<typeof ToolRegistry.callInternalTyped>>
>;
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

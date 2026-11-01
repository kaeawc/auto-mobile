import { isDeviceBindingTool } from "../daemon/deviceSessionResult";
import type { z, ZodType } from "zod/v4";
import { DeviceReadiness } from "../daemon/readiness/DeviceReadiness";
import {
  clearToolTransportRecovery,
  setToolTransportRecovery,
  type ToolTransportRecovery,
} from "../daemon/toolTransportRecovery";
import { ActionableError } from "../models";
import { findDeviceTransportUnavailable } from "../utils/android-cmdline-tools/AdbDeviceTransportUnavailableError";
import {
  postActionCaptures,
  runWithPostActionCaptureScope,
} from "../utils/PostActionCaptureContext";
import { serverConfig } from "../utils/ServerConfig";
import type { ToolRegistryHost, ToolRegistrySchema } from "./registryHost";
import { ToolDefinitionListing } from "./ToolDefinitionListing";
import { TOOL_ANNOTATIONS } from "./toolAnnotations";
import { toolExecutionError } from "./toolExecutionError";
import { erased, eraseDeviceAware, erasePlain, splitRegistration } from "./toolRegistryErasure";

import { logger, type Logger } from "../utils/logger";
import "./featureWiring";
import { assertSessionBrokerToolCall } from "./sessionBrokerToolGate";

import { runWithAutolockPolicy } from "../daemon/deviceAutolockPolicy";
import { executionTracker } from "../daemon/executionTracker";
import {
  ListChangedBroadcaster,
  type ServerRegistrationOptions,
} from "../daemon/listChangedBroadcast";
import type { Environment } from "../daemon/poolConfig";
import { ToolCallRepository } from "../db/toolCallRepository";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../features/toolSelection/toolSelectionContext";
import { isAlwaysOnTool } from "../features/toolSelection/toolSelectionControl";
import { isDebugModeEnabled } from "../utils/debug";
import { throwDeviceLostFromAbortSignal } from "../utils/deviceLossOutcome";
import {
  InternalToolName,
  InternalToolPayloads,
  narrowInternalToolEnvelope,
} from "../utils/internalToolPayloads";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { StructuredToolResponse } from "../utils/toolUtils";
import { AppCleanupService, DefaultAppCleanupService } from "./AppCleanupService";
import { ToolDefinitionSchemaCache } from "./toolDefinitionSchemaCache";
import { internalToolInvocationContext } from "./pipeline/internalInvocationContext";
import {
  AfterToolCallHandler,
  DefaultAfterToolCallHandler,
  isToolResponseFailure,
  type PlainToolFinalizer,
} from "./pipeline/afterToolCall";
import { AuditRunner, DefaultAuditRunner } from "./pipeline/audit";
import {
  assertInternalCallWithinBrokerGrant,
  deviceAwareHandlerArgs,
  deviceCallRecording,
  invokeResolvedDeviceHandler,
  refuseInternalControlOnForeignOwnedSession,
  sessionDisplayPinnedHandler,
} from "./pipeline/deviceCallDispatch";
import { gateUiInteraction } from "./systemAlertHandler";
import {
  DefaultExecutionTargetResolver,
  ExecutionTargetResolver,
} from "./pipeline/executionTarget";
import {
  DefaultNavigationToolCallRecorder,
  NavigationToolCallRecorder,
} from "./pipeline/navigationRecording";
import {
  DefaultPlanLifecycleManager,
  PlanLifecycleInput,
  PlanLifecycleManager,
  SessionBindingReleaseHandler,
} from "./pipeline/planLifecycle";
import {
  isDeviceIdControlCall,
  isDeviceReadOnlyCall,
  isReadOnlyCall,
  resolveCallerDeviceIds,
} from "./pipeline/readTarget";
import { nonBlankSessionUuid } from "./planCallerIdentity";
import { holdSessionForCurrentTask } from "./tasks/runAsTask";
import { runRecordedToolCall, toolCallOutcome } from "./toolCallRecording";

export {
  AUTOMATIC_TOOL_OUTPUT_RETENTION,
  DefaultAfterToolCallHandler,
} from "./pipeline/afterToolCall";
export type { SettleObserveFactory } from "./pipeline/afterToolCall";
export { DefaultAuditRunner, type AuditRunnerInput } from "./pipeline/audit";
export { isRecord } from "./pipeline/isRecord";
export { stripNavigationInternalParams } from "./pipeline/navigationRecording";
export {
  DefaultPlanLifecycleManager,
  PLAN_APP_CLEANUP_CAP_MS,
  PLAN_APP_CLEANUP_RETRY_DEADLINE_MS,
  type PlanCleanupFailure,
  type PlanCleanupOutcome,
  type PlanLifecycleInput,
  type SessionBindingReleaseHandler,
} from "./pipeline/planLifecycle";
export { toolHasOutputSchema } from "./toolRegistryTypes";
export type {
  DeviceAwareToolHandler,
  DeviceAwareToolOptions,
  DeviceAwareToolRegistration,
  PlainToolOptions,
  PlainToolRegistration,
  ProgressCallback,
  RegisteredTool,
  SessionlessDeviceRead,
  ToolRegistryCollaborators,
  ToolTraits,
} from "./toolRegistryTypes";
export { flattenTopLevelUnion } from "./TopLevelUnionFlattener";

import { isAlwaysLoadToolsEnabled } from "../config/alwaysLoadTools";
import { installDaemonToolRegistryPort } from "../daemon/toolRegistryPort";
import {
  DeviceAwareToolHandler,
  DeviceAwareToolOptions,
  DeviceAwareToolRegistration,
  deviceReadOnlyMetadata,
  InternalToolCallOptions,
  InternalToolCallRequest,
  pickToolTraits,
  PlainToolRegistration,
  PLAN_ONLY_GATE_REASON,
  ProgressCallback,
  RegisteredTool,
  shadowedSdkToolCallback,
  ToolHandler,
  ToolListingOptions,
  ToolRegistryCollaborators,
  ToolRegistryPipelineOverrides,
  type DeviceMutationRecording,
} from "./toolRegistryTypes";

import { defaultDaemonContext } from "../daemon/daemonContext";
import { createRecording } from "./deviceMutationRecording";
import { invokeRecordedInternalTool } from "./deviceMutationDispatch";

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
  private deviceReadiness!: DeviceReadiness;
  private cleanupService: AppCleanupService;
  private toolCallRepository: Pick<ToolCallRepository, "recordToolCall">;
  private timer: Timer;
  private readonly logger: Logger;
  private env?: Environment;
  private executionTargetResolver: ExecutionTargetResolver;
  private auditRunner: AuditRunner;
  private navigationToolCallRecorder: NavigationToolCallRecorder;
  private afterToolCall: AfterToolCallHandler;
  private plainToolFinalizer: PlainToolFinalizer;
  private planLifecycleManager: PlanLifecycleManager;
  private readonly isResponseFailure = (response: unknown): boolean =>
    isToolResponseFailure(response);
  private readonly toolDefinitionSchemas = new ToolDefinitionSchemaCache();
  private removalEpoch = 0;

  constructor(
    timer: Timer = defaultTimer,
    loggerInstance: Logger = logger,
    deviceReadiness: DeviceReadiness | null = DeviceReadiness.createInstance(),
    private mutationRecording: DeviceMutationRecording = createRecording(defaultDaemonContext),
  ) {
    if (deviceReadiness) {
      this.deviceReadiness = deviceReadiness;
    }
    this.cleanupService = new DefaultAppCleanupService();
    this.toolCallRepository = new ToolCallRepository();
    this.timer = timer;
    this.logger = loggerInstance;
    this.executionTargetResolver = new DefaultExecutionTargetResolver(loggerInstance);
    this.auditRunner = new DefaultAuditRunner(loggerInstance);
    this.navigationToolCallRecorder = new DefaultNavigationToolCallRecorder();
    // One handler serves both paths, so plain and device tools share its artifact writers.
    const afterToolCall = new DefaultAfterToolCallHandler();
    this.afterToolCall = afterToolCall;
    this.plainToolFinalizer = afterToolCall;
    this.planLifecycleManager = new DefaultPlanLifecycleManager(timer);
  }

  setToolCallRepositoryForTesting(repository: Pick<ToolCallRepository, "recordToolCall">): void {
    this.toolCallRepository = repository;
  }

  /** Snapshot injectable collaborators so tests can restore them. */
  getCollaboratorsForTesting(): ToolRegistryCollaborators {
    return {
      deviceReadiness: this.deviceReadiness,
      toolCallRepository: this.toolCallRepository,
      timer: this.timer,
      navigationToolCallRecorder: this.navigationToolCallRecorder,
      afterToolCall: this.afterToolCall,
    };
  }

  /** Replace named collaborators in tests, narrowing partial fakes here; omitted fields stay unchanged. */
  setCollaboratorsForTesting(overrides: {
    deviceReadiness?: Partial<DeviceReadiness>;
    toolCallRepository?: Pick<ToolCallRepository, "recordToolCall">;
    timer?: Timer;
    navigationToolCallRecorder?: Partial<NavigationToolCallRecorder>;
  }): void {
    if ("deviceReadiness" in overrides) {
      this.deviceReadiness = overrides.deviceReadiness as DeviceReadiness;
    }
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

  /** Register a new tool. @param registration - The handler, or `{ handler, ...options }`. */
  register<S extends ZodType>(
    name: string,
    description: string,
    inSchema: S,
    registration: ToolHandler<z.output<S>> | PlainToolRegistration<z.output<S>>,
  ): void {
    const { handler: inHandler, options: inOptions } = splitRegistration(registration);
    const { schema, handler, options } = erasePlain(inSchema, inHandler, inOptions);
    this.invalidateToolListing();
    if (this === ToolRegistry) {
      setToolTransportRecovery(name, options.transportRecovery);
    }
    this.tools.set(name, {
      name,
      description,
      schema,
      handler: async (args, progress, signal) => {
        await assertSessionBrokerToolCall(name, false, args);
        const response = await handler(args, progress, signal);
        if (isDeviceBindingTool(name)) {
          // Ingress binds and heartbeats the session these results name after the handler
          // returns (`runtime.session.sessionUuid`, `sessionUuid`), so they are never spilled.
          return response;
        }
        return this.plainToolFinalizer.finalizePlain({
          name,
          outputSchema: options.outputSchema,
          args,
          response,
          timer: this.timer,
        });
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
      selectsActiveDevice: options.selectsActiveDevice,
      hostInventory: options.hostInventory,
    });
  }

  /** Remove one test-only or dynamically registered tool without disturbing the registry. */
  unregister(name: string): void {
    this.invalidateToolListing(name);
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
    this.invalidateToolListing();
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

  /** Register a device-aware tool. @param registration - The handler, or `{ handler, ...options }`. */
  registerDeviceAware<S extends ZodType>(
    name: string,
    description: string,
    inSchema: S,
    registration: DeviceAwareToolHandler<z.output<S>> | DeviceAwareToolRegistration<z.output<S>>,
  ): void {
    const { handler: inHandler, options: inOptions } = splitRegistration(registration);
    // A UI interaction answers the device's system-alert policy first (#14106).
    const erased = eraseDeviceAware(inSchema, inHandler, inOptions);
    const { schema, handler, options } = gateUiInteraction(erased);
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
      const toolCallRecording = deviceCallRecording(name, selectionContext);
      return runRecordedToolCall(this.toolCallRepository, this.timer, name, {
        sessionUuid:
          typeof handlerArgs.sessionUuid === "string" ? handlerArgs.sessionUuid : undefined,
        handler: async (recording, toolStartMs) => {
          await assertSessionBrokerToolCall(name, true, handlerArgs);
          const resolvedTarget = await this.executionTargetResolver.resolveExecutionTarget({
            name,
            args: handlerArgs,
            options,
            deviceReadiness: this.deviceReadiness,
            signal,
            timer: this.timer,
          });
          recording.deviceId = resolvedTarget.device?.deviceId;
          signal?.throwIfAborted();
          recording.sessionUuid = resolvedTarget.sessionUuid;
          // Under an MCP task, keep this session alive until the task settles (#4668).
          holdSessionForCurrentTask(recording.sessionUuid);
          if (
            selectionContext?.execution &&
            !selectionContext.deviceAwareDispatch &&
            !recording.sessionUuid
          ) {
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
              // Per call (#15663): always set, so a nested call never inherits this one's.
              toolCallRecording,
              routingSessionUuid: resolvedTarget.sessionUuid,
              toolSelectionProfileUuid: selectionContext?.toolSelectionProfileUuid,
              // Handlers read this to stay on their read-only path (observe, snapshotOf).
              explicitObserveDeviceRead:
                (selectionContext?.explicitObserveDeviceRead === true &&
                  !handlerArgs.sessionUuid) ||
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
                    mutationRecording: this.mutationRecording,
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
                recording.durationMs = afterToolCallResult.durationMs;
                if (this.isResponseFailure(afterToolCallResult.finalizedResponse)) {
                  throwDeviceLostFromAbortSignal(signal);
                }
                succeeded = !this.isResponseFailure(afterToolCallResult.finalizedResponse);
                recording.outcome = toolCallOutcome(afterToolCallResult, name, succeeded);
                return afterToolCallResult.finalizedResponse;
              } catch (error) {
                recording.executionError = { error };
                throwDeviceLostFromAbortSignal(signal);
                const transportFailure = findDeviceTransportUnavailable(error);
                if (transportFailure) {
                  // Record the typed code (device_transport_unavailable), not the wrapper.
                  recording.executionError = { error: transportFailure };
                }
                throw toolExecutionError(error, name, resolvedTarget.device);
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
        },
      });
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

  /** @param request - Handler progress and abort signal, plus internal routing options. */
  async callInternal(
    tool: string | RegisteredTool,
    args: Record<string, unknown>,
    request: InternalToolCallRequest = {},
  ): Promise<unknown> {
    const { progress, signal, ...options } = request;
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
    const invocation = internalToolInvocationContext(
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
          invokeRecordedInternalTool(
            resolved,
            invocation.args,
            progress ?? getToolSelectionContext()?.planRequest?.progress,
            {
              signal,
              targetDevice: options.targetDevice,
              mutationRecording: this.mutationRecording,
            },
          ),
        false,
      ),
    );
  }

  private withAutolockPolicy(handler: ToolHandler): ToolHandler {
    return (args, progress, signal) =>
      runWithAutolockPolicy(this.env, () => handler(args, progress, signal));
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
    {
      progress,
      signal,
      options = {},
    }: {
      progress?: ProgressCallback;
      signal?: AbortSignal;
      options?: InternalToolCallOptions;
    } = {},
  ): Promise<StructuredToolResponse<InternalToolPayloads[K]> | undefined> {
    const response = await this.callInternal(name, args, { progress, signal, ...options });
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
          ...TOOL_ANNOTATIONS[tool.name],
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
    this.invalidateToolDefinitionSchemaCache();
    this.removalEpoch++;
    this.tools.clear();
  }

  /** Test-only: put a previously captured tool back under its own name, replacing any current one. */
  setRegisteredToolForTesting(tool: RegisteredTool): void {
    this.invalidateToolListing();
    this.tools.set(tool.name, tool);
  }

  /** Test-only: unregister one tool by name; a no-op when it was never registered. */
  removeToolForTesting(name: string): void {
    this.invalidateToolListing(name);
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
    return this.toolDefinitionSchemas.conversionCount;
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
    this.fanOutToolListChanged();
  }

  /**
   * A session binding or tool selection changed which tools a connection lists, not what any tool
   * advertises, so every cached schema stays valid. Same fan-out as {@link notifyToolListChanged}
   * without regenerating the whole catalog on the next listing (an acquisition lists it once to
   * report the session's gated tools, and used to rebuild it once per bind).
   */
  notifyToolSelectionChanged(): void {
    this.invalidateToolListing();
    this.fanOutToolListChanged();
  }

  private fanOutToolListChanged(): void {
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
  getToolDefinitions(options: ToolListingOptions = {}) {
    return new ToolDefinitionListing(
      (options) => this.getAllTools(options),
      (name) => this.isUserConfigurableTool(name),
      (tool, suppress, compact) => this.toolDefinitionSchemas.get(tool, suppress, compact),
    ).getToolDefinitions(options);
  }

  /** The tool list changed, not any tool's schema: see {@link ToolDefinitionSchemaCache}. */
  private invalidateToolListing(removedTool?: string): void {
    ListChangedBroadcaster.invalidate("tools");
    if (removedTool !== undefined) {
      this.toolDefinitionSchemas.forget(removedTool);
    }
  }

  private invalidateToolDefinitionSchemaCache(): void {
    ListChangedBroadcaster.invalidate("tools");
    this.toolDefinitionSchemas.clear();
  }

  /** Install the service owned by this process's composition root. */
  setDeviceReadiness(readiness: DeviceReadiness): void {
    this.deviceReadiness = readiness;
  }

  hasDeviceReadiness(): boolean {
    return this.deviceReadiness !== undefined;
  }

  setMutationRecording(recording: DeviceMutationRecording): void {
    this.mutationRecording = recording;
  }

  // Get the device session manager
  getDeviceReadiness(): DeviceReadiness {
    if (!this.deviceReadiness) {
      throw new ActionableError("Device readiness was not configured by the process entrypoint.");
    }
    return this.deviceReadiness;
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
      mutationRecording: this.mutationRecording,
      afterToolCall: this.afterToolCall,
      plainToolFinalizer: this.plainToolFinalizer,
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
    this.auditRunner = overrides.auditRunner ?? this.auditRunner;
    this.mutationRecording = overrides.mutationRecording ?? this.mutationRecording;
    this.afterToolCall = overrides.afterToolCall ?? this.afterToolCall;
    this.plainToolFinalizer = overrides.plainToolFinalizer ?? this.plainToolFinalizer;
    this.planLifecycleManager = overrides.planLifecycleManager ?? this.planLifecycleManager;

    return () => {
      this.env = previous.env;
      this.executionTargetResolver = previous.executionTargetResolver;
      this.auditRunner = previous.auditRunner;
      this.mutationRecording = previous.mutationRecording;
      this.afterToolCall = previous.afterToolCall;
      this.plainToolFinalizer = previous.plainToolFinalizer;
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

// Install one instance; the exported value below also enforces its typed payload contract.
const installedToolRegistry = installDaemonToolRegistryPort(
  new ToolRegistryClass(undefined, undefined, null),
);

// --- Compile-time enforcement of AC1 (issue #3222) ---
// This contract is checked by the src typecheck gate. It rejects both an `any`
// result and a result that no longer carries the concrete internal-tool payload.
type IsAny<T> = 0 extends 1 & T ? true : false;
type ResolvedTypedEnvelope = NonNullable<
  Awaited<ReturnType<typeof installedToolRegistry.callInternalTyped>>
>;
type ValidatedToolRegistry =
  IsAny<ResolvedTypedEnvelope> extends true
    ? never
    : ResolvedTypedEnvelope extends StructuredToolResponse<InternalToolPayloads[InternalToolName]>
      ? typeof installedToolRegistry
      : never;

export const ToolRegistry = installedToolRegistry satisfies ValidatedToolRegistry;

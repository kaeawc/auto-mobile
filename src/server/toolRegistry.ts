import { DUMPSYS_MAX_BUFFER } from "../utils/android-cmdline-tools/dumpsysLimits";
import {
  runWithPostActionCaptureScope,
  postActionCaptures,
} from "../utils/PostActionCaptureContext";
import { classifyToolResult } from "../utils/toolEnvelopePayload";
import { runWithToolDispatchReporter } from "../utils/ToolDispatchContext";
import type { NavigationToolCallHandle } from "../utils/interfaces/NavigationGraph";
import { runSessionDisplayPin } from "./sessionDisplayPin";
import { toActionableError } from "../models/ActionableError";
import {
  clearToolTransportRecovery,
  setToolTransportRecovery,
  type ToolTransportRecovery,
} from "./toolTransportRecovery";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJSONSchema, ZodType } from "zod/v4";
import { isAlwaysOnTool } from "../features/toolSelection/toolSelectionControl";
import {
  DeviceSessionManager,
  type ConnectedPlatformScan,
  type DeviceReadinessLevel,
} from "../devices/DeviceSessionManager";
import { ActionableError, BootedDevice, SomePlatform, type ViewHierarchyResult } from "../models";
import { NavigationGraphManager } from "../features/navigation/NavigationGraphManager";
import { UIStateExtractor } from "../features/navigation/UIStateExtractor";
import { RealObserveScreen } from "../features/observe/ObserveScreen";
import { RealSettleObserve } from "../features/observe/SettleObserve";
import type { SettleObserve } from "../features/observe/interfaces/SettleObserve";
import { settleEmbeddedObservationInResponse } from "./embeddedObservationSettle";
import { serverConfig } from "../utils/ServerConfig";
import { MemoryAudit } from "../features/memory/MemoryAudit";
import { TelemetryRecorder } from "../features/telemetry/TelemetryRecorder";
import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import {
  defaultDisplayInventoryProvider,
  type DisplayInventoryProvider,
} from "../devices/DisplayInventoryProvider";
import { AndroidCtrlProxyClient } from "../features/observe/android";
import { IOSCtrlProxyClient } from "../features/observe/ios";
import { createGlobalPerformanceTracker } from "../utils/PerformanceTracker";
import { logger, type Logger } from "../utils/logger";
import { errorMessage } from "../utils/describeUnknownError";
import { PLAN_AUTO_RELEASE_REASON } from "../daemon/sessionManager";
import { DaemonState } from "../daemon/daemonState";
import { assertInputRequesterHoldsDevice, TOOL_CALL_REMEDY } from "../daemon/inputDeviceOwnership";
import {
  defaultDeviceObservationAccess,
  sessionlessDeviceReadFor,
  type DeviceObservationAccess,
} from "./deviceObservationAccess";
import { createToolExecutionContext } from "./ToolExecutionContext";
import { resolveTransportDeadlineMs } from "./formTools";
import {
  type AppCleanupConfig,
  type AppCleanupStep,
  AppCleanupService,
  DefaultAppCleanupService,
} from "./AppCleanupService";
import { ToolCallRepository } from "../db/toolCallRepository";
import { getDeviceLabelMap, releaseDeviceLabelSessions } from "./deviceLabelMapping";
import { resolveDirectSessionDevice } from "./directSessionDeviceRegistry";
import type { Environment } from "../daemon/poolConfig";
import { captureAutolockPolicy, runWithAutolockPolicy } from "../daemon/deviceAutolockPolicy";
import { isDebugModeEnabled } from "../utils/debug";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";
import { INTERNAL_MCP_SESSION_PARAM } from "../daemon/constants";
import { getMcpRecorder } from "./mcpRecordingManager";
import { formatToolResultLog } from "./toolResultLog";
import { formatStructuredToolError } from "../utils/formatStructuredToolError";
import { flattenTopLevelUnion } from "./TopLevelUnionFlattener";
import { advertiseBoundsForCompact } from "./compactBoundsAdvertisement";
import {
  finalizeToolResponse,
  type ObservationArtifactWriter,
  type ObservationBaselineStore,
} from "./finalizeToolResponse";
import { INTERNAL_NO_DIFF_PARAM, markInternalToolCall } from "./internalToolCall";
import { ListChangedBroadcaster } from "./listChangedBroadcast";
import {
  getStructuredField,
  getStructuredPayload,
  StructuredToolResponse,
} from "../utils/toolUtils";
import { readToolEnvelopePayload } from "./toolEnvelopePayload";
import {
  APP_ID_MAX_LENGTH,
  APP_ID_PATTERN,
  applyJsonSchemaOverride,
  applyPostFlattenJsonSchemaOverride,
  enforceAnthropicToolSchemaSubset,
  isInjectedDeviceIdSchema,
} from "./toolSchemaHelpers";
import {
  InternalToolName,
  InternalToolPayloads,
  narrowInternalToolEnvelope,
} from "./internalToolPayloads";
import {
  JsonToolOutputArtifactWriter,
  type ToolOutputArtifactRetention,
} from "./toolOutputArtifactWriter";
import { toolOutputArtifactDetailsSchema } from "./toolOutputSchemas";
import { getDefaultToolOutputsDir } from "../utils/toolOutputArtifacts";
import type { SessionToolSelectionService } from "../features/toolSelection/SessionToolSelectionService";
import {
  getToolSelectionContext,
  runWithToolSelectionContext,
} from "../features/toolSelection/toolSelectionContext";
import { isDeviceLostError, throwDeviceLostFromAbortSignal } from "./deviceLossOutcome";
import { deviceLostErrorFromAbortSignal } from "../models/DeviceLostError";
import { getAbortSignal, isClientCancelled, runWithAbortSignal } from "../utils/AbortContext";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import { executionTracker } from "./executionTracker";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../features/toolSelection/toolSelectionControl";
import {
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
  stripNavigationToolParams,
  deleteInternalToolParams,
} from "../daemon/constants";

/**
 * Internal params a plan step inherits from its enclosing request. Listed once
 * so the "parent wins even when absent" strip in
 * `createInternalToolInvocationContext` cannot drift from the set it writes.
 */
const INHERITED_PLAN_REQUEST_PARAMS = [
  INTERNAL_MCP_REQUEST_DEADLINE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
  INTERNAL_EXECUTION_START_TIME_PARAM,
  INTERNAL_LIVE_DEADLINE_KEY_PARAM,
] as const;

/**
 * Overlay the enclosing request's metadata onto a plan step's args.
 *
 * Parent metadata wins even when absent: a passthrough step schema must not let
 * plan content choose another request's live deadline. An absent parent value
 * therefore DELETES the plan-supplied key rather than writing `undefined` over
 * it — an own property whose value is `undefined` is still an unrecognized key
 * to a `.strict()` tool schema (getAndroid/getApple/provisionDevice), which
 * would reject the step before it runs.
 */
function applyInheritedPlanRequestParams(
  args: Record<string, unknown>,
  request: {
    deadlineMs?: unknown;
    timeoutMs?: unknown;
    startTime?: unknown;
    liveDeadlineKey?: unknown;
  },
): Record<string, unknown> {
  const inherited: Record<string, unknown> = {
    ...args,
    [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: request.deadlineMs,
    [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: request.timeoutMs,
    [INTERNAL_EXECUTION_START_TIME_PARAM]: request.startTime,
    [INTERNAL_LIVE_DEADLINE_KEY_PARAM]: request.liveDeadlineKey,
  };
  for (const key of INHERITED_PLAN_REQUEST_PARAMS) {
    if (inherited[key] === undefined) {
      delete inherited[key];
    }
  }
  return inherited;
}

// Re-exported for backward compatibility; the implementation now lives in
// ./TopLevelUnionFlattener so the schema-flattening concern is independently testable.
export { flattenTopLevelUnion } from "./TopLevelUnionFlattener";

/**
 * A field with a default is never truly required — the default supplies it when
 * the caller omits it. zod v4's `toJSONSchema` nonetheless lists defaulted keys
 * in `required`, which reads to a client as "you must send `action` on every
 * tap" (issue #5870). Drop any `required` entry whose property carries a
 * `default`; runtime validation is unaffected (the default still applies).
 */
function dropDefaultedKeysFromRequired(jsonSchema: Record<string, unknown>): void {
  const required = jsonSchema.required;
  const properties = jsonSchema.properties as Record<string, unknown> | undefined;
  if (!Array.isArray(required) || !properties) {
    return;
  }
  const pruned = required.filter((key) => {
    const prop = properties[key as string];
    return !(prop && typeof prop === "object" && "default" in (prop as Record<string, unknown>));
  });
  if (pruned.length === required.length) {
    return;
  }
  if (pruned.length === 0) {
    delete jsonSchema.required;
  } else {
    jsonSchema.required = pruned;
  }
}

/** Apply the app ID contract after every per-node and whole-schema transformation. */
function constrainAdvertisedAppIdProperties(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(constrainAdvertisedAppIdProperties);
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }

  const jsonSchema = value as Record<string, unknown>;
  const properties = jsonSchema.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const appId = (properties as Record<string, unknown>).appId;
    if (appId && typeof appId === "object" && !Array.isArray(appId)) {
      const appIdSchema = appId as Record<string, unknown>;
      appIdSchema.minLength = 1;
      appIdSchema.maxLength = APP_ID_MAX_LENGTH;
      appIdSchema.pattern = APP_ID_PATTERN.source;
    }
  }

  Object.values(jsonSchema).forEach(constrainAdvertisedAppIdProperties);
}

function toAdvertisedJsonSchema(
  schema: any,
  options: { constrainAppIds: boolean; anthropicSubset?: boolean; exposeDeviceId?: boolean },
): Record<string, unknown> {
  const jsonSchema = toJSONSchema(schema, {
    override: ({ zodSchema, jsonSchema }) => {
      applyJsonSchemaOverride(zodSchema, jsonSchema);
      dropDefaultedKeysFromRequired(jsonSchema);
      if (isInjectedDeviceIdSchema(zodSchema) && !options.exposeDeviceId) {
        const properties = jsonSchema.properties as Record<string, unknown> | undefined;
        if (properties) {
          delete properties.deviceId;
        }
      }
    },
  });
  const flattened = flattenTopLevelUnion(jsonSchema);
  // Re-assert any wire contract that must survive union flattening (e.g. the
  // observe join keys required on the successful-observation arm, issue #7018):
  // per-node overrides only saw the pre-flatten arm, whose arm-only `required`
  // flattening reduces to the cross-arm intersection or re-homes under a branch
  // discriminator. No-op for schemas without a registered post-flatten override.
  applyPostFlattenJsonSchemaOverride(schema, flattened);
  if (options.constrainAppIds) {
    constrainAdvertisedAppIdProperties(flattened);
  }
  if (options.anthropicSubset) {
    enforceAnthropicToolSchemaSubset(flattened);
  }
  return flattened;
}

const advertisedToolOutputArtifactDetailsSchema = toJSONSchema(toolOutputArtifactDetailsSchema);

/**
 * A hard-ceiling spill retains required headline fields and appends an artifact
 * pointer. Runtime Zod output schemas deliberately keep their normal unknown-key
 * behavior, so advertise that one possible runtime addition without admitting
 * arbitrary top-level output fields.
 */
function addSpillArtifactToAdvertisedOutputSchema(
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> {
  const addArtifactProperty = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const objectNode = node as Record<string, unknown>;
    if (objectNode.type !== "object" || objectNode.additionalProperties !== false) {
      return;
    }
    const properties =
      objectNode.properties && typeof objectNode.properties === "object"
        ? (objectNode.properties as Record<string, unknown>)
        : {};
    if (Object.hasOwn(properties, "artifact")) {
      return;
    }
    objectNode.properties = {
      ...properties,
      artifact: advertisedToolOutputArtifactDetailsSchema,
    };
  };

  addArtifactProperty(jsonSchema);
  for (const unionKey of ["oneOf", "anyOf"] as const) {
    const branches = jsonSchema[unionKey];
    if (Array.isArray(branches)) {
      branches.forEach(addArtifactProperty);
    }
  }
  return jsonSchema;
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
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled">;
}

interface InternalToolInvocationContext {
  args: Record<string, unknown>;
  routingSessionUuid?: string;
  toolSelectionProfileUuid?: string;
  sessionToolSelectionService?: Pick<SessionToolSelectionService, "isEnabled">;
}

// Gate reason emitted for `planOnly` tools — hidden from discovery by design,
// expected in plans (so getToolForPlan does not warn about it).
const PLAN_ONLY_GATE_REASON = "plan-only tool";

// `McpServer.registerTool` requires a per-tool callback, but the SDK dispatcher
// that would call it is replaced by the shared `tools/call` handler (#6545).
// Fail loudly rather than run a tool without the real dispatch's guards.
async function shadowedSdkToolCallback(): Promise<never> {
  throw new ActionableError(
    "tools/call reached the SDK's per-tool callback; install the shared dispatcher with installToolCallDispatcher (issue #6545)",
  );
}

interface ToolRegistrationOptions {
  /** Built-in session default before startup or persisted exact-tool overrides. */
  defaultEnabled?: boolean;
  supportsProgress?: boolean;
  /** Loopback closure recovery: connect only, or replay after ambiguous delivery. */
  transportRecovery?: ToolTransportRecovery;
  debugOnly?: boolean;
  /**
   * Hidden from `tools/list` and discovery (`getAllTools` and
   * `registerWithServer`'s MCP-SDK registration). Still directly callable by
   * name via `tools/call` — for example, `startDevice` is called directly by
   * the session-acquisition flow and CLI despite not being advertised.
   */
  hidden?: boolean;
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

/** Resolves a device for a read without acquiring, readying or changing a device session. */
interface SessionlessDeviceRead {
  resolve(deviceId: string, signal?: AbortSignal): Promise<BootedDevice>;
  assertAuthorized(device: BootedDevice): void;
}

interface DeviceAwareToolOptions<T = any> extends ToolRegistrationOptions {
  shouldEnsureDevice?: (args: T) => boolean;
  /**
   * The tool only watches the device (#10730: watching is allowed on any device and is not use),
   * so a caller that does not hold a device another session holds may still run it. Every other
   * device-aware tool is refused on such a device (`device_owned_by_other_session`). A function
   * decides per call (sqlQuery: only a read-only statement watches).
   *
   * A sessionless call that would land on a device another session holds runs through the
   * read-only device path (`sessionlessDeviceRead`, or the registry's default): the target is
   * resolved from the booted-device list, with no readiness (no CtrlProxy setup, no current-device
   * pin, no settings writes), no navigation recording and no audit (#10830).
   */
  deviceReadOnly?: boolean | ((args: T) => boolean);
  /** Read an explicit device id without acquiring or changing a device session. */
  sessionlessDeviceRead?: SessionlessDeviceRead;
  deviceReadiness?: DeviceReadinessLevel | ((args: T) => DeviceReadinessLevel);
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
  /** Override the process default for one connection-scoped tools/list response. */
  suppressOutputSchema?: boolean;
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
  defaultEnabled: boolean;
  defaultDeclared: boolean;
  supportsProgress?: boolean;
  transportRecovery?: ToolTransportRecovery;
  requiresDevice?: boolean;
  deviceAwareHandler?: DeviceAwareToolHandler;
  debugOnly?: boolean;
  hidden?: boolean;
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
  signal?: AbortSignal;
}

interface ExecutionTargetContext {
  args: any;
  baseSessionUuid: string | undefined;
  device: BootedDevice | undefined;
  internalCall: boolean;
  sessionUuid: string | undefined;
  shouldResolveDevice: boolean;
  /** Resolved through the read-only device path: the handler runs without recording or audit. */
  deviceRead?: SessionlessDeviceRead;
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
  record(
    name: string,
    args: any,
    device: BootedDevice | undefined,
    sessionUuid: string | undefined,
  ): NavigationToolCallHandle | undefined;
}

/** Removes routing and execution implementation details before persisting a navigation edge. */
export function stripNavigationInternalParams(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return stripNavigationToolParams(args);
}

function withAmbientDeviceContext(
  args: Record<string, unknown>,
  routingSessionUuid: string | undefined,
  execution: { executionId: string; startTime: number } | undefined,
): Record<string, unknown> {
  const needsRoutingSession = routingSessionUuid && args.sessionUuid !== routingSessionUuid;
  const needsExecution =
    execution &&
    (args.__executionId !== execution.executionId ||
      args.__executionStartTime !== execution.startTime);
  if (!needsRoutingSession && !needsExecution) {
    return args;
  }
  return {
    ...args,
    ...(needsRoutingSession ? { sessionUuid: routingSessionUuid } : {}),
    ...(needsExecution
      ? {
          __executionId: execution!.executionId,
          __executionStartTime: execution!.startTime,
        }
      : {}),
  };
}

interface AfterToolCallInput {
  name: string;
  outputSchema: unknown;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJSONTextFailureContent(content: unknown): boolean {
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    !isRecord(content[0]) ||
    content[0].type !== "text" ||
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- This text is an MCP response envelope, not a UI selector.
    typeof content[0].text !== "string"
  ) {
    return false;
  }
  try {
    // oxlint-disable-next-line auto-mobile/no-raw-selector-field-read -- This text is an MCP response envelope, not a UI selector.
    const payload: unknown = JSON.parse(content[0].text);
    return isRecord(payload) && payload.success === false;
  } catch (error) {
    // Plain text is a valid response, so an invalid JSON envelope remains a non-failure.
    logger.debug(`[ToolRegistry] Response text is not JSON: ${error}`);
    return false;
  }
}

function isToolResponseFailure(response: unknown): boolean {
  if (!isRecord(response)) {
    return false;
  }
  if (response.isError === true || response.success === false) {
    return true;
  }
  const structuredContent = getStructuredPayload(response);
  if (isRecord(structuredContent) && typeof structuredContent.success === "boolean") {
    return structuredContent.success === false;
  }
  if (response.success === true) {
    return false;
  }
  return isJSONTextFailureContent(response.content);
}

function isViewHierarchyResult(value: unknown): value is ViewHierarchyResult {
  return isRecord(value) && isRecord(value.hierarchy);
}

/**
 * Read an unprojected observation hierarchy from a completed tool envelope.
 *
 * `observe` returns the ObserveResult as its top-level structured payload,
 * while action tools nest the same snapshot under `.observation`. This runs
 * before `finalizeToolResponse`, so it preserves the raw hierarchy even when
 * the client-facing response uses the compact skeleton projection.
 */
function getObservedHierarchy(
  name: string,
  response: { structuredContent?: unknown; content?: unknown } | undefined,
): ViewHierarchyResult | undefined {
  const payload = readToolEnvelopePayload(response)?.payload;
  if (!isRecord(payload)) {
    return undefined;
  }

  const observation = name === "observe" ? payload : payload.observation;
  if (!isRecord(observation) || !isViewHierarchyResult(observation.viewHierarchy)) {
    return undefined;
  }
  return observation.viewHierarchy;
}

type ObservationArtifactWriterFactory = (
  outputDirectory: string,
  timer: Timer,
  retention?: ToolOutputArtifactRetention,
) => ObservationArtifactWriter;

export const AUTOMATIC_TOOL_OUTPUT_RETENTION: ToolOutputArtifactRetention = {
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
  /** An enclosing plan owns cleanup and release for this invocation. */
  nestedInPlan?: boolean;
  /** The tool call returned a successful response (false when it failed or threw). */
  succeeded?: boolean;
  // Injected teardown for the server-side per-transport SessionToolBinding
  // (issue #4611 Gap D). Invoked AFTER a real release for every session freed —
  // base and derived label sessions alike — never optimistically.
  sessionBindingReleaseHandler?: SessionBindingReleaseHandler;
  /** Removes persisted tool overrides for sessions actually released. */
  sessionToolSelectionService?: Partial<Pick<SessionToolSelectionService, "deleteSession">>;
}

interface PlanLifecycleManager {
  afterExecution(input: PlanLifecycleInput): Promise<void>;
}

interface ToolRegistryPipelineOverrides {
  env?: Environment;
  executionTargetResolver?: ExecutionTargetResolver;
  displayInventory?: DisplayInventoryProvider;
  /** Booted-device listing for the read-only device path (#10830). */
  deviceReadAccess?: DeviceObservationAccess;
  auditRunner?: AuditRunner;
  afterToolCall?: AfterToolCallHandler;
  planLifecycleManager?: PlanLifecycleManager;
}

async function resolveSessionlessDeviceRead(
  input: ExecutionTargetInput,
  read: SessionlessDeviceRead,
  deviceId: string,
): Promise<ExecutionTargetContext> {
  const { args, signal } = input;
  signal?.throwIfAborted();
  const device = await read.resolve(deviceId, signal);
  if (args.platform && args.platform !== device.platform) {
    throw new ActionableError(
      `Device ${deviceId} is ${device.platform}, not requested platform ${args.platform}.`,
    );
  }
  return {
    args,
    baseSessionUuid: undefined,
    device,
    internalCall: args[INTERNAL_NO_DIFF_PARAM] === true,
    sessionUuid: undefined,
    shouldResolveDevice: true,
    deviceRead: read,
  };
}

function isDeviceReadOnlyCall(options: DeviceAwareToolOptions, args: unknown): boolean {
  return typeof options.deviceReadOnly === "function"
    ? options.deviceReadOnly(args)
    : options.deviceReadOnly === true;
}

/** A device another session holds: a live owner, or an autolock holder. */
function isDeviceHeld(deviceId: string): boolean {
  const daemonState = DaemonState.getInstance();
  return Boolean(
    daemonState.getSessionManager().getSessionForDevice(deviceId) ??
    daemonState.getDevicePool().getDevice(deviceId)?.autolockSessionId,
  );
}

class DefaultExecutionTargetResolver implements ExecutionTargetResolver {
  private readonly defaultDeviceRead: SessionlessDeviceRead;

  constructor(
    private readonly logger: Logger = logger,
    private readonly displayInventory: DisplayInventoryProvider = defaultDisplayInventoryProvider,
    deviceReadAccess: DeviceObservationAccess = defaultDeviceObservationAccess,
  ) {
    this.defaultDeviceRead = sessionlessDeviceReadFor(deviceReadAccess);
  }
  async resolveExecutionTarget(input: ExecutionTargetInput): Promise<ExecutionTargetContext> {
    if (
      input.options.sessionlessDeviceRead &&
      getToolSelectionContext()?.explicitObserveDeviceRead &&
      input.args.deviceId &&
      !input.args.sessionUuid
    ) {
      return resolveSessionlessDeviceRead(
        input,
        input.options.sessionlessDeviceRead,
        input.args.deviceId,
      );
    }
    return this.resolveNormalExecutionTarget(input);
  }

  private async resolveNormalExecutionTarget(
    input: ExecutionTargetInput,
  ): Promise<ExecutionTargetContext> {
    const autolockEnabled = captureAutolockPolicy();
    const { name, args, options, deviceSessionManager, signal } = input;
    signal?.throwIfAborted();
    let connectedPlatformsPromise: Promise<ConnectedPlatformScan> | undefined;
    const getConnectedPlatforms = (): Promise<ConnectedPlatformScan> => {
      connectedPlatformsPromise ??= deviceSessionManager.detectConnectedPlatformsWithStatus(signal);
      return connectedPlatformsPromise;
    };
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
    const execution =
      typeof args.__executionId === "string" && typeof args.__executionStartTime === "number"
        ? { executionId: args.__executionId, startTime: args.__executionStartTime }
        : undefined;
    // Internal tool-to-tool marker (#3053 / #3087): internal callers (PlanExecutor
    // steps, navigation/setup replays) set this via `markInternalToolCall` so a
    // plan/navigation step's finalized envelope is never diffed/stripped and never
    // advances the agent-facing diff baseline (a future internal
    // `.observation.viewHierarchy` reader stays correct).
    const internalCall = args[INTERNAL_NO_DIFF_PARAM] === true;
    let sessionUuid = baseSessionUuid;
    const keepScreenAwake =
      typeof args.keepScreenAwake === "boolean" ? args.keepScreenAwake : undefined;

    if (deviceLabel && shouldResolveDevice) {
      if (!DaemonState.getInstance().isInitialized()) {
        throw new ActionableError("Device labels require an active daemon session.");
      }
      if (!baseSessionUuid) {
        throw new ActionableError(
          `Device label '${deviceLabel}' requires sessionUuid to be provided.`,
        );
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
          `Device label '${deviceLabel}' is not allocated. Provide a devices list to executePlan before using device labels.`,
        );
      }

      if (providedDeviceId) {
        logger.warn(
          `[ToolRegistry] Ignoring deviceId because device label '${deviceLabel}' was provided.`,
        );
        providedDeviceId = undefined;
      }
    }

    // Extract platform from args, default to "either" for backward compatibility
    let platform: SomePlatform = args.platform || "either";

    if (shouldResolveDevice) {
      const implicitSessionUuid = this.resolveImplicitAutolockSession(
        platform,
        sessionUuid,
        providedDeviceId,
        mcpSessionId,
        execution,
        autolockEnabled,
      );
      if (implicitSessionUuid) {
        sessionUuid = implicitSessionUuid;
        if (execution) {
          executionTracker.setResolvedAutolockSessionUuid(
            execution.executionId,
            implicitSessionUuid,
          );
        }
        logger.info(
          `[ToolRegistry] Resolved implicit autolock session for MCP session ${mcpSessionId}: ${implicitSessionUuid}`,
        );
      }
      if (sessionUuid) {
        // Handlers must use the resolved label or implicit session, not the
        // caller's base session, so session-scoped state stays on the device
        // that ToolRegistry selected.
        args.sessionUuid = sessionUuid;
      }
      await this.enforceSessionUuidForMultipleDevices(
        platform,
        sessionUuid,
        providedDeviceId,
        deviceSessionManager,
        signal,
        getConnectedPlatforms,
      );
      await this.enforceSessionUuidForAutolock({
        platform,
        sessionUuid,
        providedDeviceId,
        deviceSessionManager,
        signal,
        getConnectedPlatforms,
        autolockEnabled,
      });
    }

    const readOnly = isDeviceReadOnlyCall(options, args);
    // A sessionless read-only call that would land on a held device watches it through the
    // read-only path: no readiness, pin or settings work on the holder's device (#10830).
    const watchedDeviceId = await this.heldDeviceToWatch({
      readOnly,
      shouldResolveDevice,
      sessionUuid,
      providedDeviceId,
      platform,
      deviceSessionManager,
      getConnectedPlatforms,
    });
    if (watchedDeviceId) {
      return resolveSessionlessDeviceRead(
        input,
        options.sessionlessDeviceRead ?? this.defaultDeviceRead,
        watchedDeviceId,
      );
    }

    // An explicit target held by another session is refused before admission or any device work,
    // so a non-holder (including an observer-only or sessionless caller) gets the typed code.
    assertToolCallerHoldsDevice(name, readOnly, providedDeviceId, sessionUuid, autolockEnabled);

    logger.info(
      `[ToolRegistry] Tool ${name} called, sessionUuid=${sessionUuid}, daemonInitialized=${DaemonState.getInstance().isInitialized()}`,
    );

    // If session UUID provided, resolve device from session
    if (shouldResolveDevice && sessionUuid && DaemonState.getInstance().isInitialized()) {
      logger.info(`[ToolRegistry] Entering session-based device assignment for ${sessionUuid}`);
      const sessionManager = DaemonState.getInstance().getSessionManager();
      const devicePool = DaemonState.getInstance().getDevicePool();
      // A terminal ID keeps its durable TerminalSessionError. Only an ID that
      // was live during daemon restart can reach context creation without a
      // live session; never-issued IDs are rejected before assignment.
      const admittedSession = await sessionManager.admitIssuedSessionForAutomation(
        sessionUuid,
        execution,
      );
      if (execution) {
        // Only an admitted call's end is session use (#10824).
        executionTracker.markSessionAdmitted(execution.executionId);
      }
      assertSessionDeviceRouting(
        name,
        providedDeviceId,
        sessionUuid,
        admittedSession?.assignedDevice,
      );
      const context = await createToolExecutionContext(
        sessionUuid,
        sessionManager,
        devicePool,
        {
          keepScreenAwake,
          requestDeadlineMs: resolveTransportDeadlineMs(args),
          platform: platform === "android" || platform === "ios" ? platform : undefined,
          // #6227: the persisted/daemon-session path must honor a tool's declared
          // deviceReadiness the same way the legacy/no-session path below does
          // (ensureDeviceReady's `readiness` option), so a `booted`-only tool
          // (e.g. listApps, videoRecordingTools) doesn't pay for (or fail on)
          // full CtrlProxy accessibility-service setup.
          deviceReadiness:
            typeof options.deviceReadiness === "function"
              ? options.deviceReadiness(args)
              : options.deviceReadiness,
        },
        execution,
        admittedSession,
        // #6069: defense-in-depth. On this path `admitIssuedSessionForAutomation`
        // above already partitions every state (throws for a never-issued id,
        // returns a live session so the fallback is skipped, returns undefined
        // only for a persisted non-terminal row — restart recovery — which the
        // createUnseenSession guard also admits), so this flag rejects nothing
        // admit does not already reject HERE. It exists so the pool-minting
        // primitive itself refuses to mint a never-issued id: if a future route
        // reaches createToolExecutionContext for a caller-provided sessionUuid
        // without going through admit, issuance is still enforced. See the PR
        // discussion for why the reported #6069 bound-connection bypass could not
        // be reproduced through any current public route in-harness.
        true,
        signal,
      );
      assertSessionDeviceRouting(name, providedDeviceId, sessionUuid, context.deviceId);
      if (context.deviceId && !providedDeviceId) {
        providedDeviceId = context.deviceId;
        logger.info(`[ToolRegistry] Resolved device from session: ${providedDeviceId}`);
      }
      if (context.devicePlatform) {
        platform = context.devicePlatform;
      }
    } else if (shouldResolveDevice && sessionUuid) {
      // Direct mode (--no-proxy): DaemonState is not initialized, so the
      // session-based branch above never runs. Recover the acquired device and
      // its platform from the direct-session registry (#5893) so a sessionUuid
      // is sufficient on its own — without this, a client that omits `platform`
      // (now optional) with both platforms connected falls through to
      // ensureDeviceReady("either", undefined) and hits an ambiguity error.
      const directSession = resolveDirectSessionDevice(sessionUuid);
      assertDeviceReadRouting(args, options, directSession?.device.deviceId);
      if (!directSession) {
        logger.warn(`[ToolRegistry] SessionUuid provided but DaemonState not initialized!`);
      } else if (!providedDeviceId) {
        providedDeviceId = directSession.device.deviceId;
        logger.info(
          `[ToolRegistry] Resolved device from direct session ${sessionUuid}: ${providedDeviceId}`,
        );
        // Adopt the session's platform only when we also adopted its device. An
        // explicitly-provided deviceId names the target unambiguously, so leave
        // platform as "either" and let ensureDeviceReady infer it from the id —
        // narrowing to the session's platform here would send an explicit
        // cross-platform deviceId to the wrong platform's search and fail
        // (mirrors the #5870 deviceId-resolves-platform rule).
        platform = directSession.device.platform;
      }
    } else if (sessionUuid) {
      logger.warn(`[ToolRegistry] SessionUuid provided but DaemonState not initialized!`);
    }

    let device: BootedDevice | undefined;
    if (shouldResolveDevice) {
      const hydrateDisplays = async (
        resolvedDevice: BootedDevice,
        identityToken: string,
      ): Promise<BootedDevice> => {
        try {
          return await this.displayInventory.hydrate(resolvedDevice, identityToken, signal);
        } catch (error) {
          this.logger.warn(
            `[ToolRegistry] Display inventory unavailable for ${resolvedDevice.deviceId}: ${error}`,
            error,
          );
          return resolvedDevice;
        }
      };
      if (sessionUuid && DaemonState.getInstance().isInitialized() && providedDeviceId) {
        // Daemon session path: device already resolved via createToolExecutionContext.
        // Construct BootedDevice directly to avoid mutating global DeviceSessionManager state.
        const resolvedPlatform =
          platform === "android" || platform === "ios" ? platform : "android";
        const pooledDevice = DaemonState.getInstance().getDevicePool().getDevice(providedDeviceId);
        device = {
          deviceId: providedDeviceId,
          name: pooledDevice?.name ?? providedDeviceId,
          platform: pooledDevice?.platform ?? resolvedPlatform,
          iosVersion: pooledDevice?.iosVersion,
        };
        device = await hydrateDisplays(
          device,
          `${pooledDevice?.incarnation ?? "unknown"}:${pooledDevice?.avdName ?? device.name}`,
        );
        logger.info(`[ToolRegistry] ${name}: Using session-resolved device ${device.deviceId}`);
      } else {
        // Legacy single-agent path or no session: use DeviceSessionManager (may set global state).
        // Readiness acts on the device it selects (CtrlProxy setup, the current-device pin,
        // settings), so a call without a deviceId is checked against the device it would land
        // on first: a refused call leaves the holder's device untouched (#10828).
        let readinessTarget = providedDeviceId;
        if (!providedDeviceId && !readOnly && DaemonState.getInstance().isInitialized()) {
          readinessTarget = await predictReadinessTarget(
            platform,
            deviceSessionManager,
            getConnectedPlatforms,
          );
        }
        // Check and mark in one turn, before readiness: a session acquiring the target while
        // readiness runs cancels this call, and readiness stops at its next device step (#10905).
        assertToolCallerHoldsDevice(name, readOnly, readinessTarget, sessionUuid, autolockEnabled);
        if (readinessTarget && execution && !sessionUuid && !readOnly) {
          executionTracker.markSessionlessDeviceUse(execution.executionId, readinessTarget);
        }
        logger.info(
          `[ToolRegistry] ${name}: Resolving device for platform=${platform}, providedDeviceId=${providedDeviceId}`,
        );
        device = await deviceSessionManager.ensureDeviceReady(platform, providedDeviceId, {
          sessionId: sessionUuid,
          skipCtrlProxyDownload: serverConfig.isSkipCtrlProxyDownloadEnabled(),
          readiness:
            typeof options.deviceReadiness === "function"
              ? options.deviceReadiness(args)
              : options.deviceReadiness,
          signal,
          getConnectedPlatforms,
        });
        if (readinessTarget && execution && readinessTarget !== device.deviceId) {
          // Readiness settled elsewhere: the post-resolution check below marks that device.
          executionTracker.unmarkSessionlessDeviceUse(execution.executionId, readinessTarget);
        }
        // Discovery re-stamps observedAt; the serial/UDID stays stable until
        // the daemon's removal/release hooks invalidate this device.
        device = await hydrateDisplays(device, device.deviceId);
        logger.info(`[ToolRegistry] ${name}: Using device ${device.deviceId}`);
      }
    } else {
      logger.info(`[ToolRegistry] ${name}: Skipping device resolution.`);
    }

    // The resolved target too: a call without a deviceId can land on a held device.
    assertToolCallerHoldsDevice(name, readOnly, device?.deviceId, sessionUuid, autolockEnabled);
    if (device && execution && !sessionUuid && !readOnly) {
      // Admitted on a device no session holds: a session acquiring it from here on cancels this
      // call, which may not keep driving the new holder's device (#10829).
      executionTracker.markSessionlessDeviceUse(execution.executionId, device.deviceId);
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
        this.logger.debug(
          `[ToolRegistry] Best-effort CtrlProxy session bind skipped for ${name}: ${error}`,
        );
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

  /**
   * The held device a sessionless read-only call would land on: its explicit deviceId, or the
   * device readiness would select. Undefined when the call has a session, is not read-only, or its
   * target is not held; that call takes the normal path.
   */
  private async heldDeviceToWatch(input: {
    readOnly: boolean;
    shouldResolveDevice: boolean;
    sessionUuid: string | undefined;
    providedDeviceId: string | undefined;
    platform: SomePlatform;
    deviceSessionManager: DeviceSessionManager;
    getConnectedPlatforms: () => Promise<ConnectedPlatformScan>;
  }): Promise<string | undefined> {
    if (
      !input.readOnly ||
      !input.shouldResolveDevice ||
      input.sessionUuid ||
      !DaemonState.getInstance().isInitialized()
    ) {
      return undefined;
    }
    const target =
      input.providedDeviceId ??
      (await predictReadinessTarget(
        input.platform,
        input.deviceSessionManager,
        input.getConnectedPlatforms,
      ));
    return target && isDeviceHeld(target) ? target : undefined;
  }

  private async enforceSessionUuidForMultipleDevices(
    platform: SomePlatform,
    sessionUuid: string | undefined,
    providedDeviceId: string | undefined,
    deviceSessionManager: DeviceSessionManager,
    signal: AbortSignal | undefined,
    getConnectedPlatforms: () => Promise<ConnectedPlatformScan>,
  ): Promise<void> {
    if (sessionUuid || providedDeviceId) {
      return;
    }

    signal?.throwIfAborted();
    const scan = await getConnectedPlatforms();
    const connectedPlatforms = scan.devices;
    const explicitPin = this.getValidExplicitPin(deviceSessionManager, scan);
    if (this.hasActiveDeviceForNamedPlatform(platform, explicitPin)) {
      return;
    }
    const detectedPlatforms = new Set(connectedPlatforms.map((device) => device.platform));
    // Mixed-platform ambiguity belongs to ensureDeviceReady, including its
    // intentional setActiveDevice/current-device bypass (#5870).
    if (platform === "either" && detectedPlatforms.size > 1) {
      return;
    }

    const candidatePlatform = platform === "either" ? connectedPlatforms[0]?.platform : platform;
    if (!candidatePlatform) {
      return;
    }

    const candidateCount = connectedPlatforms.filter(
      (device) => device.platform === candidatePlatform,
    ).length;
    if (candidateCount <= 1) {
      return;
    }

    throw new ActionableError(
      candidatePlatform === "ios"
        ? "Multiple iOS simulators detected. Provide sessionUuid to target a specific simulator."
        : "Multiple Android devices detected. Provide sessionUuid to target a specific device.",
    );
  }

  private hasActiveDeviceForNamedPlatform(
    platform: SomePlatform,
    explicitPin: BootedDevice | undefined,
  ): boolean {
    return Boolean(explicitPin && platform !== "either" && explicitPin.platform === platform);
  }

  private getValidExplicitPin(
    deviceSessionManager: DeviceSessionManager,
    scan: ConnectedPlatformScan,
  ): BootedDevice | undefined {
    const explicitPin = deviceSessionManager.getExplicitDevicePin();
    if (!explicitPin) {
      return undefined;
    }
    if (
      scan.devices.some(
        (device) =>
          device.deviceId === explicitPin.deviceId && device.platform === explicitPin.platform,
      )
    ) {
      return explicitPin;
    }
    if (scan.scanned[explicitPin.platform]) {
      deviceSessionManager.clearExplicitDevicePin(explicitPin.deviceId);
      return undefined;
    }
    return explicitPin;
  }

  private resolveImplicitAutolockSession(
    platform: SomePlatform,
    sessionUuid: string | undefined,
    providedDeviceId: string | undefined,
    mcpSessionId: string | undefined,
    execution: import("../daemon/sessionManager").SessionExecutionMetadata | undefined,
    autolockEnabled: boolean,
  ): string | undefined {
    if (sessionUuid) {
      return undefined;
    }
    if (!autolockEnabled || !DaemonState.getInstance().isInitialized()) {
      return undefined;
    }

    const platformFilter = platform === "android" || platform === "ios" ? platform : undefined;
    const sessionId = DaemonState.getInstance()
      .getDevicePool()
      .resolveAutolockSessionForMcpSession(
        mcpSessionId,
        platformFilter,
        execution,
        providedDeviceId,
      );
    if (!sessionId) {
      return undefined;
    }

    if (!providedDeviceId) {
      return sessionId;
    }

    const session = DaemonState.getInstance().getSessionManager().getSession(sessionId);
    return session?.assignedDevice === providedDeviceId ? sessionId : undefined;
  }

  private async enforceSessionUuidForAutolock({
    platform,
    sessionUuid,
    providedDeviceId,
    deviceSessionManager,
    signal,
    getConnectedPlatforms,
    autolockEnabled,
  }: {
    platform: SomePlatform;
    sessionUuid: string | undefined;
    providedDeviceId: string | undefined;
    deviceSessionManager: DeviceSessionManager;
    signal: AbortSignal | undefined;
    getConnectedPlatforms: () => Promise<ConnectedPlatformScan>;
    autolockEnabled: boolean;
  }): Promise<void> {
    if (!autolockEnabled) {
      return;
    }
    if (sessionUuid || providedDeviceId) {
      return;
    }

    signal?.throwIfAborted();
    const scan = await getConnectedPlatforms();
    const connectedPlatforms = scan.devices;
    const explicitPin = this.getValidExplicitPin(deviceSessionManager, scan);
    if (explicitPin && (platform === "either" || platform === explicitPin.platform)) {
      return;
    }
    const candidates =
      platform === "either"
        ? connectedPlatforms
        : connectedPlatforms.filter((device) => device.platform === platform);

    if (candidates.length <= 1) {
      return;
    }

    throw new ActionableError(
      "Device pool autolock is enabled and multiple devices are available. " +
        "Call getAndroid or getApple first from this MCP session, or provide the returned sessionUuid (or a deviceId) to target a specific device.",
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
      this.log.warn(
        `[ToolRegistry] Could not determine foreground app, skipping memory audit for ${name}`,
      );
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
      perf,
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
        "shell dumpsys window | grep mCurrentFocus",
        undefined,
        DUMPSYS_MAX_BUFFER,
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
  "tapOn",
  "swipeOn",
  "pinchOn",
  "dragAndDrop",
  "pressButton",
  "sendKeys",
]);

/**
 * Tools that always end an app's process. `appLifecycle` `killBackgrounded` is deliberately not
 * here: it is the state-preserving kill, so the app comes back on the screen it was left on.
 */
const APP_STOPPING_TOOLS: ReadonlySet<string> = new Set([
  "terminateApp",
  "crashApp",
  "uninstallApp",
]);

/**
 * Tools that replace a process without naming the app in their arguments: `installApp` takes an
 * artifact path, and installing over a running app restarts it, so every remembered screen is
 * forgotten rather than guessing which app it was (#10206 review).
 */
const PROCESS_REPLACING_TOOLS: ReadonlySet<string> = new Set(["installApp"]);

/**
 * The app a tool call is about to stop or reset, so the navigation graph forgets the screen it
 * was on (#10193): a fresh process must not get an edge from a stale screen. `launchApp` only
 * counts when it asks for a cold boot or cleared data.
 */
function appStoppedByToolCall(name: string, args: any): string | undefined {
  const stops =
    APP_STOPPING_TOOLS.has(name) ||
    (name === "launchApp" && (args?.coldBoot === true || args?.clearAppData === true));
  const appId = args?.appId ?? args?.packageName;
  return stops && typeof appId === "string" && appId.length > 0 ? appId : undefined;
}

class DefaultNavigationToolCallRecorder implements NavigationToolCallRecorder {
  record(
    name: string,
    args: any,
    device: BootedDevice | undefined,
    sessionUuid: string | undefined,
  ): NavigationToolCallHandle | undefined {
    const stoppedApp = appStoppedByToolCall(name, args);
    if (stoppedApp) {
      this.navigationManager(sessionUuid).forgetAppScreen(stoppedApp);
    }
    if (PROCESS_REPLACING_TOOLS.has(name)) {
      this.navigationManager(sessionUuid).forgetAllAppScreens();
    }
    // Record tool call for navigation graph correlation before the handler mutates UI state.
    if (!NAVIGATION_RELEVANT_TOOLS.has(name)) {
      return;
    }

    const cachedResult = device
      ? RealObserveScreen.getRecentCachedResultForDevice(device.deviceId)
      : RealObserveScreen.getRecentCachedResult();
    const uiState = new UIStateExtractor().extractFromObservation(cachedResult);
    return this.navigationManager(sessionUuid).recordToolCall(
      name,
      stripNavigationInternalParams(args),
      uiState,
      device?.deviceId,
    );
  }

  private navigationManager(sessionUuid: string | undefined): NavigationGraphManager {
    return sessionUuid
      ? NavigationGraphManager.getInstanceForSession(sessionUuid)
      : NavigationGraphManager.getInstance();
  }
}

function unwrapToolResponse(response: unknown, toolName: string): any {
  // Client calls permit unstructured text. Step executors enforce the strict
  // policy; logging keeps its existing fallback for uninterpretable envelopes.
  const result = classifyToolResult(response, toolName, null);
  return result.kind === "payload" && "success" in result.payload ? result.payload : response;
}

/**
 * Build the settle delegate the embedded-observation stability gate (#6866)
 * re-observes with. Injected so tests drive the gate on a FakeObserveScreen +
 * FakeTimer instead of a device.
 */
export type SettleObserveFactory = (
  device: BootedDevice,
  timer: Timer,
) => SettleObserve | undefined;

export class DefaultAfterToolCallHandler implements AfterToolCallHandler {
  // One writer per (timer, resolved directory), built lazily through the factory.
  // The writer's directory-validation cache and 60s prune throttle are instance
  // state, so a writer per tool call defeated both (issue #10079). Keyed by timer
  // identity too because the writer captures its timer; production passes one.
  private readonly artifactWriters = new WeakMap<Timer, Map<string, ObservationArtifactWriter>>();

  constructor(
    private readonly createArtifactWriter: ObservationArtifactWriterFactory = (
      outputDirectory,
      timer,
      retention,
    ) => new JsonToolOutputArtifactWriter({ outputDirectory, timer, retention }),
    private readonly createSettleObserve: SettleObserveFactory = (device, timer) =>
      new RealSettleObserve(new RealObserveScreen(device), timer),
  ) {}

  private getArtifactWriter(outputDirectory: string, timer: Timer): ObservationArtifactWriter {
    let writersByDirectory = this.artifactWriters.get(timer);
    if (!writersByDirectory) {
      writersByDirectory = new Map();
      this.artifactWriters.set(timer, writersByDirectory);
    }
    const key = resolvePathFromDaemonLaunchWorkingDirectory(outputDirectory);
    let writer = writersByDirectory.get(key);
    if (!writer) {
      writer = this.createArtifactWriter(outputDirectory, timer, AUTOMATIC_TOOL_OUTPUT_RETENTION);
      writersByDirectory.set(key, writer);
    }
    return writer;
  }

  async handle(input: AfterToolCallInput): Promise<AfterToolCallResult> {
    const {
      name,
      outputSchema,
      args,
      internalCall,
      device,
      response,
      sessionUuid,
      shouldResolveDevice,
      signal,
      timer,
      toolStartMs,
    } = input;

    // Unwrap MCP response envelope to get the inner result for success/error checks.
    // Tools may return { content: [{ type: "text", text: '{"success":false,...}' }] }
    // instead of a plain { success, error } object.
    const unwrapped = unwrapToolResponse(response, name);

    const toolSuccess =
      unwrapped && typeof unwrapped === "object" && "success" in unwrapped
        ? unwrapped.success !== false
        : true;
    const toolError =
      unwrapped && typeof unwrapped === "object" && "error" in unwrapped
        ? (formatStructuredToolError(unwrapped.error) ?? String(unwrapped.error ?? ""))
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

    // Issue #6866: a navigation-class action's embedded observation can be
    // captured before the destination screen finishes inflating, so the client's
    // first look misses a not-yet-attached child (the Settings `switchWidget`)
    // and the parent row's content-derived `s2-…` id changes on the next
    // observe. Gate that capture on hierarchy stability HERE — before the
    // session hierarchy cache, the diff baseline and the skeleton projection all
    // read it — so every downstream consumer sees the settled screen. In-place,
    // scroll and unknown classes are untouched and keep their current latency.
    //
    // Invoked unconditionally, including for `success: false`: the helper owns
    // that distinction and short-circuits a failed action to a plain
    // `settled: false` stamp WITHOUT re-observing, so guarding on the tool's
    // success here only made that stamp unreachable and left a failed action's
    // observation carrying no stability verdict at all.
    await settleEmbeddedObservationInResponse(response, {
      name,
      args: typeof args === "object" && args !== null ? args : undefined,
      internal: internalCall,
      signal,
      timer,
      createSettleObserve: () => (device ? this.createSettleObserve(device, timer) : undefined),
    });

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
      if (
        getStructuredField(swipeEnvelope, "success") &&
        getStructuredField(swipeEnvelope, "found")
      ) {
        const scrollPosition = UIStateExtractor.createScrollPosition(args);
        if (scrollPosition) {
          const scrollNavManager = sessionUuid
            ? NavigationGraphManager.getInstanceForSession(sessionUuid)
            : NavigationGraphManager.getInstance();
          scrollNavManager.updateScrollPosition(scrollPosition);
        }
      }
    }

    if (
      shouldResolveDevice &&
      sessionUuid &&
      !(name === "observe" && args.display === "all") &&
      DaemonState.getInstance().isInitialized()
    ) {
      const sessionManager = DaemonState.getInstance().getSessionManager();
      const observedHierarchy = getObservedHierarchy(name, response);
      if (observedHierarchy) {
        sessionManager.setLastHierarchy(sessionUuid, observedHierarchy);
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
            get: (uuid) =>
              DaemonState.getInstance().getSessionManager().getLastRenderedObservation(uuid),
            set: (uuid, observation, displayRevision) =>
              DaemonState.getInstance()
                .getSessionManager()
                .setLastRenderedObservation(uuid, observation, displayRevision),
            getActionMetadata: (uuid, deviceId) =>
              DaemonState.getInstance().getSessionManager().getLastActionMetadata(uuid, deviceId),
            setActionMetadata: (uuid, deviceId, blocks) =>
              DaemonState.getInstance()
                .getSessionManager()
                .setLastActionMetadata(uuid, deviceId, blocks),
            setDisplayRevision: (uuid, revision, key, generation) =>
              DaemonState.getInstance()
                .getSessionManager()
                .setLastRenderedDisplayRevision(uuid, revision, key, generation),
          }
        : undefined;
    const configuredArtifactDirectory = serverConfig.getToolOutputsDir();
    const artifactMode = configuredArtifactDirectory ? "always" : "oversized";
    const artifactDirectory = configuredArtifactDirectory ?? getDefaultToolOutputsDir();
    const artifactWriter = !internalCall
      ? this.getArtifactWriter(artifactDirectory, timer)
      : undefined;

    const finalizedResponse = finalizeToolResponse(response, {
      name,
      outputSchema,
      args,
      sessionUuid,
      baselineStore,
      actionsCompactMetadata: getToolSelectionContext()?.actionsCompactMetadata,
      internal: internalCall,
      artifactWriter,
      artifactMode,
      // A call the client cancelled or timed out has its response discarded by the
      // transport, so it must not advance the diff baseline or metadata snapshot
      // (#10081). A daemon-side abort (device loss, session release) does not
      // discard a completed success, which is still returned to the client, so only
      // a failure is treated as undelivered when the combined signal aborted.
      delivered: !isClientCancelled(signal) && (toolSuccess || !signal?.aborted),
    });

    const telemetryArgs = { ...args };
    deleteInternalToolParams(telemetryArgs);
    TelemetryRecorder.getInstance().recordToolCallEvent({
      timestamp: toolStartMs,
      toolName: name,
      durationMs,
      success: toolSuccess,
      error: toolError,
      args: typeof args === "object" ? telemetryArgs : null,
    });

    if (toolSuccess) {
      getMcpRecorder({ connectionId: args[INTERNAL_MCP_SESSION_PARAM] })?.record(name, args);
    }

    return {
      durationMs,
      finalizedResponse,
    };
  }
}

/**
 * Upper bound on one executePlan's whole app cleanup, which runs under a private
 * signal because the request signal may already have aborted. Sized above a normal
 * terminate / `pm clear` and far below ClearAppData's own 60s action bound.
 */
export const PLAN_APP_CLEANUP_CAP_MS = 20_000;

/**
 * Deadline for one background app-cleanup retry (device-health recovery). The retry is a
 * full cleanup, so it gets the cleanup's own cap plus a margin: the cap's clean failure
 * must win the race, and a slow-but-successful retry must be able to clear the marker.
 */
export const PLAN_APP_CLEANUP_RETRY_DEADLINE_MS = PLAN_APP_CLEANUP_CAP_MS + 1_000;

/** One device whose app cleanup did not complete; `step` is absent when the service rejected. */
export interface PlanCleanupFailure {
  deviceId: string;
  step?: AppCleanupStep;
  reason: string;
}

/** What an executePlan app cleanup visibly did not do (the service logs its own soft failures). */
export interface PlanCleanupOutcome {
  /** Devices whose cleanup reported `failed` or rejected. */
  failures: PlanCleanupFailure[];
  /** Devices still running when {@link PLAN_APP_CLEANUP_CAP_MS} cut the cleanup short. */
  unfinishedDeviceIds: string[];
  /** The cleanup hit {@link PLAN_APP_CLEANUP_CAP_MS} and was cut short. */
  capExceeded: boolean;
}

// Exported for focused unit coverage (issue #3208). Production wires this via
// the ToolRegistry constructor; tests instantiate it directly to exercise
// executePlan cleanup and the auto-release guard without a live daemon session.
export class DefaultPlanLifecycleManager implements PlanLifecycleManager {
  private getCleanupDevices(
    primaryDevice: BootedDevice,
    baseSessionUuid: string | undefined,
  ): BootedDevice[] {
    const signal = getAbortSignal();
    const lostDeviceId = signal?.aborted
      ? deviceLostErrorFromAbortSignal(signal)?.deviceId
      : undefined;
    const isNotLost = (device: BootedDevice): boolean => {
      if (device.deviceId === lostDeviceId) {
        logger.debug(`[PlanLifecycle] Skipping cleanup for lost device ${device.deviceId}`);
        return false;
      }
      return true;
    };
    const state = DaemonState.getInstance();
    if (!baseSessionUuid || !state.isInitialized()) {
      return [primaryDevice].filter(isNotLost);
    }

    const sessionManager = state.getSessionManager();
    const devicePool = state.getDevicePool();
    const sessions = new Set([
      baseSessionUuid,
      ...Object.values(getDeviceLabelMap(baseSessionUuid) ?? {}),
    ]);
    const devices = [...sessions].flatMap((sessionUuid): BootedDevice[] => {
      const session = sessionManager.getSession(sessionUuid);
      const pooledDevice = session ? devicePool.getDevice(session.assignedDevice) : null;
      if (!session || !pooledDevice || !sessionManager.isAdmittedForAutomation(session)) {
        logger.debug(
          `[PlanLifecycle] Skipping cleanup for unavailable session ${sessionUuid} / device ${session?.assignedDevice ?? "unknown"}`,
        );
        return [];
      }
      try {
        // Reuse the admission gate for device loss, recovery, shutdown and
        // identity quarantine; cleanup must not act on a retired runtime.
        devicePool.assertSessionReadyForAutomation(sessionUuid);
      } catch (error) {
        if (isDeviceLostError(error) || error instanceof ActionableError) {
          logger.debug(`[PlanLifecycle] Skipping cleanup for fenced session ${sessionUuid}`, error);
        } else {
          logger.warn(`[PlanLifecycle] Cleanup admission failed for session ${sessionUuid}`, error);
        }
        return [];
      }
      return [
        pooledDevice.id === primaryDevice.deviceId
          ? primaryDevice
          : {
              deviceId: pooledDevice.id,
              name: pooledDevice.name,
              platform: pooledDevice.platform,
              iosVersion: pooledDevice.iosVersion,
            },
      ];
    });
    return [...new Map(devices.map((device) => [device.deviceId, device])).values()].filter(
      isNotLost,
    );
  }

  constructor(private readonly timer: Timer = defaultTimer) {}

  /**
   * Cleans independent devices concurrently and drains them all before any session is
   * released. The request signal is often already aborted here (request deadline,
   * client cancel, a sibling device lost), so every adb call under it would fail at
   * once and leave the app running on a device about to return to the pool. Cleanup
   * therefore runs under its own signal, bounded by {@link PLAN_APP_CLEANUP_CAP_MS} so
   * a dead device cannot hang the release; reaching the cap aborts that private signal,
   * which fails the remaining adb calls. Every failure is logged at warn and returned
   * as a {@link PlanCleanupOutcome} so the caller can say what the cleanup did not do.
   */
  private async cleanupDevicesShielded(
    devices: BootedDevice[],
    cleanupService: AppCleanupService,
    config: AppCleanupConfig,
  ): Promise<PlanCleanupOutcome> {
    const shield = new AbortController();
    const failures: PlanCleanupFailure[] = [];
    const finished = new Set<string>();
    const cleanOne = async (cleanupDevice: BootedDevice): Promise<void> => {
      const { deviceId } = cleanupDevice;
      try {
        const result = await cleanupService.cleanup(cleanupDevice, config);
        if (result.status === "failed") {
          failures.push({ deviceId, step: result.step, reason: result.reason });
        }
      } catch (error) {
        failures.push({ deviceId, reason: errorMessage(error) });
        logger.warn(`[PlanLifecycle] App cleanup failed for device ${deviceId}`, error);
      }
      finished.add(deviceId);
    };
    try {
      await runWithAbortSignal(shield.signal, () =>
        raceWithDeadline(() => Promise.allSettled(devices.map(cleanOne)), {
          timer: this.timer,
          timeoutMs: PLAN_APP_CLEANUP_CAP_MS,
          label: "Plan app cleanup",
          onTimeout: () => shield.abort(new ActionableError("Plan app cleanup exceeded its cap")),
        }),
      );
      return { failures, unfinishedDeviceIds: [], capExceeded: false };
    } catch (error) {
      logger.warn(
        `[PlanLifecycle] App cleanup did not finish for ${devices.map((d) => d.deviceId).join(", ")}; releasing anyway`,
        error,
      );
      const unfinishedDeviceIds = devices
        .map((d) => d.deviceId)
        .filter((deviceId) => !finished.has(deviceId));
      return { failures, unfinishedDeviceIds, capExceeded: true };
    }
  }

  /**
   * The plan's response was finalized (envelope, spill, structuredContent) and the plan's
   * outcome decided before this runs, so an incomplete cleanup cannot be added to it. State
   * that once, at warn, so the daemon log shows that the reported outcome does not cover it.
   */
  private reportIncompleteCleanup(
    outcome: PlanCleanupOutcome,
    appId: string,
    sessionUuid: string | undefined,
  ): void {
    if (outcome.failures.length === 0 && !outcome.capExceeded) {
      return;
    }
    const failed = outcome.failures.map(
      ({ deviceId, step, reason }) => `${deviceId} (${step ?? "cleanup"}: ${reason})`,
    );
    const problems = [
      failed.length > 0 ? `failed on ${failed.join(", ")}` : "",
      outcome.unfinishedDeviceIds.length > 0
        ? `unfinished on ${outcome.unfinishedDeviceIds.join(", ")}`
        : "",
      outcome.capExceeded ? `did not finish within ${PLAN_APP_CLEANUP_CAP_MS}ms` : "",
    ].filter(Boolean);
    logger.warn(
      `[PlanLifecycle] executePlan app cleanup for ${appId} was incomplete (${problems.join("; ")}); ` +
        `the plan result was already finalized and does not report this (session ${sessionUuid ?? "none"})`,
    );
  }

  /**
   * A device whose cleanup did not complete must not return to the pool looking clean. Mark
   * it with the pool's existing device-health marker (it cannot be allocated while marked)
   * and let the session manager's bounded health recovery retry the cleanup once the device
   * is idle. The retry gets its own capped signal because recovery runs detached from this
   * call but inherits its ambient (often aborted) request signal.
   */
  private markIncompleteCleanupDevices(
    outcome: PlanCleanupOutcome,
    devices: BootedDevice[],
    cleanupService: AppCleanupService,
    config: AppCleanupConfig,
  ): void {
    const dirty = new Set([
      ...outcome.failures.map((failure) => failure.deviceId),
      ...outcome.unfinishedDeviceIds,
    ]);
    if (dirty.size === 0 || !DaemonState.getInstance().isInitialized()) {
      return;
    }
    const sessionManager = DaemonState.getInstance().getSessionManager();
    for (const cleanupDevice of devices.filter((d) => dirty.has(d.deviceId))) {
      sessionManager.markDeviceNeedsAppCleanup(
        cleanupDevice.deviceId,
        async () => {
          const retry = await this.cleanupDevicesShielded([cleanupDevice], cleanupService, config);
          if (retry.failures.length > 0 || retry.capExceeded) {
            throw new ActionableError(
              `App cleanup retry for ${config.appId} did not complete on ${cleanupDevice.deviceId}`,
            );
          }
        },
        PLAN_APP_CLEANUP_RETRY_DEADLINE_MS,
      );
    }
  }

  /**
   * A failed executePlan whose caller asked to keep its session (`holdSessionOnFailure`) keeps the
   * session and its device, so the caller's recovery and the resumed plan run on a device no other
   * session can take in between (#10834). The caller owns the session from here: the resumed plan
   * releases it, or the caller releases it (or stops heartbeating) when it gives up. A plan with
   * device labels is released as before: its derived label sessions have no caller-side owner.
   */
  private holdsFailedPlanSessionForRecovery(
    input: PlanLifecycleInput,
    releaseSessionUuid: string,
  ): boolean {
    if (input.args?.holdSessionOnFailure !== true || input.succeeded !== false) {
      return false;
    }
    if (Object.keys(getDeviceLabelMap(releaseSessionUuid) ?? {}).length > 0) {
      logger.info(
        `[PlanLifecycle] holdSessionOnFailure ignored for ${releaseSessionUuid}: a plan with ` +
          "device labels is always released",
      );
      return false;
    }
    logger.info(
      `[PlanLifecycle] Keeping session ${releaseSessionUuid} and its device after a failed ` +
        "executePlan (holdSessionOnFailure) for the caller's recovery",
    );
    return true;
  }

  async afterExecution(input: PlanLifecycleInput): Promise<void> {
    if (input.name === "executePlan" && input.nestedInPlan) {
      // The enclosing plan is still using these sessions and devices.
      return;
    }
    const {
      name,
      args,
      baseSessionUuid,
      cleanupService,
      device,
      sessionUuid,
      shouldResolveDevice,
      sessionBindingReleaseHandler,
      sessionToolSelectionService,
    } = input;
    if (device && name === "executePlan" && args?.cleanupAppId) {
      // Resolved under the request signal: a device-loss abort names the lost device
      // to skip. A deadline or client cancel aborts it too but names no device, so
      // those plans still clean every device they own (#10022).
      const devices = this.getCleanupDevices(device, baseSessionUuid ?? sessionUuid);
      const cleanupConfig = { appId: args.cleanupAppId, clearAppData: args.cleanupClearAppData };
      const outcome = await this.cleanupDevicesShielded(devices, cleanupService, cleanupConfig);
      this.reportIncompleteCleanup(outcome, args.cleanupAppId, baseSessionUuid ?? sessionUuid);
      this.markIncompleteCleanupDevices(outcome, devices, cleanupService, cleanupConfig);
    }

    if (
      shouldResolveDevice &&
      sessionUuid &&
      name === "executePlan" &&
      DaemonState.getInstance().isInitialized() &&
      !this.holdsFailedPlanSessionForRecovery(input, baseSessionUuid ?? sessionUuid)
    ) {
      try {
        const sessionManager = DaemonState.getInstance().getSessionManager();
        const devicePool = DaemonState.getInstance().getDevicePool();
        const releaseSessionUuid = baseSessionUuid ?? sessionUuid;
        // Track exactly which sessions this release actually frees so the
        // server-side transport binding is torn down for each (issue #4611 Gap
        // D) — coupled to the REAL release, never cleared optimistically.
        const releasedSessionUuids: string[] = [];
        if (releaseSessionUuid) {
          releasedSessionUuids.push(...(await releaseDeviceLabelSessions(releaseSessionUuid)));
        }

        const session = releaseSessionUuid ? sessionManager.getSession(releaseSessionUuid) : null;
        if (session) {
          const deviceId = session.assignedDevice;
          // Await the release so its onSessionRelease callbacks (CtrlProxy binding +
          // detector cleanup) complete — and any rejection is caught by this try —
          // before the device is freed (#4984).
          await sessionManager.releaseSession(session.sessionId, PLAN_AUTO_RELEASE_REASON);
          await devicePool.releaseDevice(deviceId, session.sessionId);
          NavigationGraphManager.releaseSession(releaseSessionUuid);
          // CtrlProxy client binding + detector cleanup for the released session is
          // handled centrally in the daemon's onSessionRelease hook (#4984), which
          // covers every release path and each derived label session on its device.
          RealObserveScreen.clearCache(deviceId);
          releasedSessionUuids.push(releaseSessionUuid);
          logger.info(
            `Auto-released session ${session.sessionId} and freed device ${deviceId} after executePlan`,
          );
        }

        // Clear the per-transport SessionToolBinding for every freed session so a
        // later sessionless tools/list or tools/call stops enforcing a released
        // profile (issue #4611 Gap D). Best-effort: the handler swallows its own
        // failures, but the release itself has already succeeded regardless.
        for (const releasedUuid of releasedSessionUuids) {
          sessionBindingReleaseHandler?.onSessionReleased(releasedUuid);
          await sessionToolSelectionService?.deleteSession?.(releasedUuid);
        }
      } catch (releaseError) {
        logger.warn(`Failed to auto-release session ${sessionUuid}: ${releaseError}`);
      }
    }
  }
}

/**
 * Copy an advertised array-field schema with `enum` applied to its items.
 * Preserves the field's own description and constraints; only the item
 * vocabulary is added.
 */
function withItemsEnum(
  field: Record<string, unknown> | undefined,
  values: string[],
): Record<string, unknown> {
  return {
    ...field,
    items: {
      ...(field?.items as Record<string, unknown> | undefined),
      enum: values,
    },
  };
}

function deviceAwareHandlerArgs(
  args: Record<string, unknown>,
  options: DeviceAwareToolOptions,
  context: ReturnType<typeof getToolSelectionContext>,
  name: string,
): Record<string, unknown> {
  const routingSession =
    options.sessionlessDeviceRead &&
    context?.explicitObserveDeviceRead &&
    args.deviceId &&
    !args.sessionUuid
      ? undefined
      : context?.routingSessionUuid;
  const handlerArgs = withAmbientDeviceContext(args, routingSession, context?.execution);
  if (name === "tapAt") {
    handlerArgs.__tapAtRecordingContext = handlerArgs.__tapAtPlanContext ?? {};
  }
  return handlerArgs;
}

/**
 * Daemon-mode contract (#8602, #9945): a `deviceId` sent alongside a session is
 * a routing hint and must name the session's own device, for every device-aware
 * tool. `providedDeviceId` is the post-label value, so a `device` label (which
 * deliberately drops a stray `deviceId`) and a call with no `deviceId` are not
 * checked. Tools registered with `ToolRegistry.register` (setActiveDevice,
 * startDevice, killDevice, listDevices, ...) never reach this resolver and keep
 * naming other devices freely; killDevice and deleteDevice check device ownership
 * themselves (`assertLifecycleCallerHoldsDevice`, #10785).
 */
function assertSessionDeviceRouting(
  toolName: string,
  providedDeviceId: string | undefined,
  sessionUuid: string,
  sessionDeviceId: string | undefined,
): void {
  if (providedDeviceId && sessionDeviceId && providedDeviceId !== sessionDeviceId) {
    throw new ActionableError(
      `${toolName} deviceId '${providedDeviceId}' does not match session '${sessionUuid}' device '${sessionDeviceId}'.`,
    );
  }
}

/**
 * Device ownership for tool calls (#10698, #10730), matching `input/*`: a device another live
 * session holds runs device-aware tools only for its holder (a derived `${base}:${label}` session
 * counts as its base). Sessionless calls are refused on a held device; unheld devices stay open.
 * Tools flagged `deviceReadOnly` only watch, which is allowed on any device.
 */
function assertToolCallerHoldsDevice(
  toolName: string,
  readOnly: boolean,
  deviceId: string | undefined,
  sessionUuid: string | undefined,
  autolockEnabled: boolean,
): void {
  if (!deviceId || !DaemonState.getInstance().isInitialized()) {
    return;
  }
  if (readOnly) {
    return;
  }
  // An autolocked device is governed by autolock's own check and remedies. Like the general check,
  // it runs before readiness touches the device (#10833).
  const devicePool = DaemonState.getInstance().getDevicePool();
  if (autolockEnabled && devicePool.getDevice(deviceId)?.autolockSessionId) {
    devicePool.assertAutolockAccess(deviceId, sessionUuid, autolockEnabled);
    return;
  }
  const sessionManager = DaemonState.getInstance().getSessionManager();
  assertInputRequesterHoldsDevice({
    action: toolName,
    deviceId,
    ownerSessionUuid: sessionManager.getSessionForDevice(deviceId) ?? undefined,
    requesterSessionUuid: sessionUuid,
    sessionManager,
    remedy: TOOL_CALL_REMEDY,
  });
}

/**
 * The device `ensureDeviceReady` would select for a call without a deviceId, read from the scan
 * the call already shares and the session manager's selections, without touching a device
 * (#10828). It mirrors readiness selection: the explicit `setActiveDevice` pin, then the current
 * device, then the only candidate on the platform. Undefined when readiness would not settle on a
 * connected device; the post-resolution ownership check still covers that call.
 */
async function predictReadinessTarget(
  platform: SomePlatform,
  deviceSessionManager: DeviceSessionManager,
  getConnectedPlatforms: () => Promise<ConnectedPlatformScan>,
): Promise<string | undefined> {
  const { devices } = await getConnectedPlatforms();
  const pin = deviceSessionManager.getExplicitDevicePin();
  const current = deviceSessionManager.getCurrentDevice();
  const platforms = new Set(devices.map((device) => device.platform));
  const targetPlatform =
    platform !== "either"
      ? platform
      : platforms.size > 1
        ? (pin?.platform ?? deviceSessionManager.getCurrentPlatform())
        : devices[0]?.platform;
  const candidates = devices.filter((device) => device.platform === targetPlatform);
  const connected = (deviceId: string | undefined) =>
    candidates.find((device) => device.deviceId === deviceId)?.deviceId;
  return (
    connected(pin?.deviceId) ??
    connected(current?.deviceId) ??
    (candidates.length === 1 ? candidates[0]!.deviceId : undefined)
  );
}

function assertDeviceReadRouting(
  args: Record<string, unknown>,
  options: DeviceAwareToolOptions,
  sessionDeviceId: string | undefined,
): void {
  if (
    options.sessionlessDeviceRead &&
    typeof args.deviceId === "string" &&
    typeof args.sessionUuid === "string" &&
    sessionDeviceId &&
    args.deviceId !== sessionDeviceId
  ) {
    throw new ActionableError(
      `observe deviceId '${args.deviceId}' does not match session '${args.sessionUuid}' device '${sessionDeviceId}'.`,
    );
  }
}

// Reuse the display capability across registrations and internal dispatch without
// retaining schemas after their tools are removed.
const sessionDisplaySchemaCapabilities = new WeakMap<ZodType, boolean>();

function schemaAcceptsSessionDisplay(schema: unknown): boolean {
  if (!(schema instanceof ZodType)) {
    return false;
  }
  const cached = sessionDisplaySchemaCapabilities.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const acceptsDisplay = Object.hasOwn(
    toAdvertisedJsonSchema(schema, { constrainAppIds: false }).properties ?? {},
    "display",
  );
  sessionDisplaySchemaCapabilities.set(schema, acceptsDisplay);
  return acceptsDisplay;
}

function sessionDisplayPinnedHandler(input: {
  name: string;
  schema: unknown;
  handler: DeviceAwareToolHandler;
}): DeviceAwareToolHandler {
  const acceptsDisplay = schemaAcceptsSessionDisplay(input.schema);
  return (device, args, progress, signal) =>
    runSessionDisplayPin({
      name: input.name,
      acceptsDisplay,
      device,
      args,
      sessionUuid: getToolSelectionContext()?.routingSessionUuid ?? args.sessionUuid,
      invoke: (effectiveArgs) => input.handler(device, effectiveArgs, progress, signal),
    });
}

/** Run a tool so the action it executes can report its dispatch to the recorded call. */
function runReportingDispatch<T>(
  call: NavigationToolCallHandle | undefined,
  run: () => Promise<T>,
): Promise<T> {
  return runWithToolDispatchReporter(call?.markDispatched, run);
}

async function invokeResolvedDeviceHandler(input: {
  target: ExecutionTargetContext & { device: BootedDevice };
  name: string;
  args: Record<string, unknown>;
  handler: DeviceAwareToolHandler;
  progress?: ProgressCallback;
  signal?: AbortSignal;
  auditRunner: AuditRunner;
  navigationRecorder: NavigationToolCallRecorder;
}): Promise<any> {
  const { target, name, args, handler, progress, signal } = input;
  if (target.deviceRead) {
    // A read-only device read is not this caller's use of the device: no navigation recording
    // and no audit run on a device the caller may not hold (#10830).
    return handler(target.device, args, progress, signal);
  }
  const withdraw = input.navigationRecorder.record(name, args, target.device, target.sessionUuid);
  const onAbort = () => withdraw?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  let succeeded = false;
  try {
    // The dispatch boundary: a call cancelled since admission (for instance because another
    // session acquired its device, #10829) never reaches the device. `finally` withdraws it.
    signal?.throwIfAborted();
    // The action reports when its gesture goes out, so a tool that waited for its target
    // is attributed from the dispatch, not from the start (#10196).
    const response = await runReportingDispatch(withdraw, () =>
      input.auditRunner.run({
        name,
        args,
        device: target.device,
        handler,
        progress,
        signal,
      }),
    );
    succeeded = !isToolResponseFailure(response);
    return response;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!succeeded) {
      withdraw?.();
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
    onSessionReleased: (sessionUuid) => this.notifySessionBindingReleased(sessionUuid),
  };
  private deviceSessionManager: DeviceSessionManager;
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
  private toolDefinitionSchemaCache: Map<string, CachedToolDefinitionSchemas> = new Map();

  constructor(timer: Timer = defaultTimer, loggerInstance: Logger = logger) {
    this.deviceSessionManager = DeviceSessionManager.getInstance();
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
  register(
    name: string,
    description: string,
    schema: any,
    handler: ToolHandler,
    options: ToolRegistrationOptions = {},
  ): void {
    this.invalidateToolDefinitionSchemaCache();
    if (this === ToolRegistry) {
      setToolTransportRecovery(name, options.transportRecovery);
    }
    this.tools.set(name, {
      name,
      description,
      schema,
      handler,
      defaultEnabled: options.defaultEnabled ?? true,
      defaultDeclared: options.defaultEnabled !== undefined,
      supportsProgress: options.supportsProgress ?? false,
      transportRecovery: options.transportRecovery,
      requiresDevice: false,
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
  registerDeviceAware(
    name: string,
    description: string,
    schema: any,
    handler: DeviceAwareToolHandler,
    options: DeviceAwareToolOptions = {},
  ): void {
    const pinnedHandler = sessionDisplayPinnedHandler({ name, schema, handler });
    // Device-aware tools may reconnect before dispatch. Replaying an ambiguous
    // delivery requires an explicit per-tool opt-in.
    const transportRecovery = this.prepareDeviceAwareRegistration(name, options);
    // Create a wrapper that handles device ID injection
    const wrappedHandler: ToolHandler = async (
      args: any,
      progress?: ProgressCallback,
      signal?: AbortSignal,
    ) => {
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
        const resolvedTarget = await this.executionTargetResolver.resolveExecutionTarget({
          name,
          args: handlerArgs,
          options,
          deviceSessionManager: this.deviceSessionManager,
          signal,
        });
        signal?.throwIfAborted();
        sessionUuid = resolvedTarget.sessionUuid;
        if (selectionContext?.execution && !sessionUuid) {
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
              let response: any | undefined;
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
              if (isToolResponseFailure(afterToolCallResult.finalizedResponse)) {
                throwDeviceLostFromAbortSignal(signal);
              }
              succeeded = !isToolResponseFailure(afterToolCallResult.finalizedResponse);
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
        void Promise.resolve()
          .then(() =>
            this.toolCallRepository.recordToolCall({
              toolName: name,
              timestamp: toolCallTimestamp,
              sessionUuid,
              durationMs: toolDurationMs ?? this.timer.now() - toolStartMs,
            }),
          )
          .catch((error: unknown) => {
            logger.warn(`[ToolRegistry] Failed to record tool call for ${name}: ${error}`);
          });
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
      debugOnly: options.debugOnly ?? false,
      embeddedSdkOnly: options.embeddedSdkOnly ?? false,
      planExecutable: options.planExecutable ?? false,
      planOnly: options.planOnly ?? false,
      hidden: options.hidden ?? false,
      acceptsPlanLockNamespace: options.acceptsPlanLockNamespace ?? false,
      outputSchema: options.outputSchema,
      appUiResourceUri: options.appUiResourceUri,
    });
  }

  // Get all registered tools
  getAllTools(options: ToolListingOptions = {}): RegisteredTool[] {
    const tools = Array.from(this.tools.values());
    return tools.filter((tool) => this.toolReachable(tool, "list", options));
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
  async callInternal(
    tool: string | RegisteredTool,
    args: Record<string, unknown>,
    progress?: ProgressCallback,
    signal?: AbortSignal,
    options: InternalToolCallOptions = {},
  ): Promise<any> {
    const resolved =
      typeof tool === "string"
        ? options.forPlan
          ? this.getToolForPlan(tool)
          : this.getTool(tool)
        : tool;
    if (!resolved) {
      throw new ActionableError(`Tool not found: ${tool}`);
    }
    const invocation = this.createInternalToolInvocationContext(args, options);

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
    const sessionUuid =
      options.sessionUuid ??
      context?.routingSessionUuid ??
      (typeof args.sessionUuid === "string" ? args.sessionUuid : undefined);
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
  ): Promise<any> {
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
  registerWithServer(server: McpServer): void {
    // Retained so runtime changes that alter tool definitions can emit
    // notifications/tools/list_changed (issue #2963) to EVERY live session, not
    // just the most recently created one (issue #3223), mirroring how
    // ResourceRegistry retains its servers for resources/list_changed.
    this.trackServer(server);

    this.tools.forEach((tool) => {
      if (!this.toolReachable(tool, "register")) {
        return;
      }

      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.schema,
          ...(process.env.AUTOMOBILE_ALWAYS_LOAD_TOOLS === "true" && {
            _meta: { "anthropic/alwaysLoad": true },
          }),
        },
        shadowedSdkToolCallback,
      );
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
        logger.warn(
          `[ToolRegistry] session-binding release handler failed for ${sessionUuid}: ${error}`,
        );
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

  // Get a map of all schema
  getSchemaMap(): Record<string, any> {
    const schemaMap: Record<string, any> = {};
    this.getAllTools().forEach((tool) => {
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

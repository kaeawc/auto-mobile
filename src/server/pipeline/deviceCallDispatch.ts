import { internalExecutionId, internalExecutionStartTime } from "../internalToolParams";
import { runWithToolDispatchReporter } from "../../utils/ToolDispatchContext";
import type { NavigationToolCallHandle } from "../../utils/interfaces/NavigationGraph";
import { runSessionDisplayPin } from "../sessionDisplayPin";
import { toActionableError } from "../../models/ActionableError";
import { DeviceOutsideBoundSessionError } from "../../daemon/deviceOutsideBoundSessionRefusal";
import { ZodType } from "zod/v4";
import {
  DeviceReadiness,
  type ConnectedPlatformScan,
} from "../../daemon/readiness/DeviceReadiness";
import { BootedDevice, type Platform, SomePlatform } from "../../models";
import { logger } from "../../utils/logger";
import { errorMessage } from "../../utils/describeUnknownError";
import { defaultDaemonContext, type DevicePoolReads } from "../../daemon/daemonContext";
import { reconcileDiscoveryObservation } from "../../daemon/discoveryReconcile";
import { PlatformDeviceManagerFactory } from "../../utils/factories/PlatformDeviceManagerFactory";
import { hasRecentReadTransportListingFailure } from "../../daemon/toolCallDeviceIdentity";
import {
  assertFrameTargetIdentityProven,
  frameHeldSessionsFrom,
} from "../../daemon/frameDeviceIdentity";
import { didSourceSucceedForDevice } from "../../utils/discoverySource";
import {
  brokerConnectionControlRefusal,
  brokerConnectionPlainToolRefusal,
} from "../../daemon/sessionBroker/connectionScope";
import { bindingPoolGate } from "../../daemon/sessionBroker/provisioning/poolGate";
import { BINDING_INPUT_SNAPSHOT_MAX_AGE_MS } from "../../daemon/inputDeviceOwnership";
import { resolveToolSelectionBaseSessionUuid } from "../../features/toolSelection/selectionSessionResolver";
import type { DevicePool } from "../../daemon/devicePool";
import {
  assertControlNotOnForeignDaemonDevice,
  assertInputRequesterHoldsDevice,
  TOOL_CALL_REMEDY,
} from "../../daemon/inputDeviceOwnership";
import { getToolSelectionContext } from "../../features/toolSelection/toolSelectionContext";
import {
  isControlCallOnNamedSession,
  refuseControlOnForeignOwnedSession,
} from "../foreignOwnedSessionRefusal";
import { nonBlankSessionUuid } from "../planCallerIdentity";
import { executionTracker } from "../../daemon/executionTracker";
import { deviceActionClock } from "./deviceActionClock";
import { assertToolSupportsDevicePlatform } from "../watchOsToolSupport";
import { toAdvertisedJsonSchema } from "./advertisedSchema";
import type {
  ProgressCallback,
  DeviceAwareToolHandler,
  ToolTraits,
  DeviceAwareToolOptions,
  RegisteredTool,
} from "../toolRegistry";
import type { ExecutionTargetContext } from "./executionTarget";
import type { AuditRunner } from "./audit";
import type { NavigationToolCallRecorder } from "./navigationRecording";
import type { DeviceMutationRecording } from "../deviceMutationRecording";

export function journaledDeviceHandler(
  name: string,
  handler: DeviceAwareToolHandler,
  recording: DeviceMutationRecording,
): DeviceAwareToolHandler {
  return async (device, args, progress, signal) => {
    const sessionUuid =
      typeof args.sessionUuid === "string"
        ? args.sessionUuid
        : getToolSelectionContext()?.routingSessionUuid;
    await recording.beforeToolCall(name, args, device, { sessionUuid, signal });
    signal?.throwIfAborted();
    return handler(device, args, progress, signal);
  };
}

/**
 * Tell the tracker what kind of device call runs under `executionId`. A read is not use of the
 * session it runs under, so it is never echoed as routed (#10974) and never vetoes its release
 * (#11322); but nested calls share their outer call's execution, so only the top-level call's own
 * read marks it, and any control step, nested or not, makes the execution a control call.
 */
export function markDeviceCallKind(executionId: string, toolName: string, readOnly: boolean): void {
  if (readOnly) {
    executionTracker.markDeviceReadCall(executionId, toolName);
  } else {
    executionTracker.markDeviceControlCall(executionId);
    deviceActionClock.markControl(executionId);
  }
}

function withAmbientDeviceContext(
  args: Record<string, unknown>,
  routingSessionUuid: string | undefined,
  execution: { executionId: string; startTime: number } | undefined,
): Record<string, unknown> {
  const needsRoutingSession = routingSessionUuid && args.sessionUuid !== routingSessionUuid;
  const needsExecution =
    execution &&
    (internalExecutionId(args) !== execution.executionId ||
      internalExecutionStartTime(args) !== execution.startTime);
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

/**
 * #11469: a blank `sessionUuid` names no session. Dropped before target resolution so a blank
 * plan session neither masks the ambient routing session nor reaches the plan's steps as one.
 */
function withoutBlankSessionUuid(args: Record<string, unknown>): Record<string, unknown> {
  if (typeof args.sessionUuid !== "string" || nonBlankSessionUuid(args.sessionUuid)) {
    return args;
  }
  const rest = { ...args };
  delete rest.sessionUuid;
  return rest;
}

export function deviceAwareHandlerArgs(
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
  const handlerArgs = withAmbientDeviceContext(
    withoutBlankSessionUuid(args),
    nonBlankSessionUuid(routingSession),
    context?.execution,
  );
  if (name === "tapAt") {
    handlerArgs.__tapAtRecordingContext = handlerArgs.__tapAtPlanContext ?? {};
  }
  if (name === "swipeAt") {
    // Filled by the handler with the screen the endpoints resolved against (#12878).
    handlerArgs.__swipeAtRecordingContext = {};
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
export function assertSessionDeviceRouting(
  toolName: string,
  providedDeviceId: string | undefined,
  sessionUuid: string,
  { sessionDeviceId, sessionPlatform }: { sessionDeviceId?: string; sessionPlatform?: string } = {},
): void {
  if (providedDeviceId && sessionDeviceId && providedDeviceId !== sessionDeviceId) {
    // The same refusal a pinned connection gets for a foreign device (#11351), typed so clients
    // branch on `device_outside_bound_session`; the long-standing wording is kept.
    throw new DeviceOutsideBoundSessionError(
      sessionUuid,
      { deviceId: sessionDeviceId, platform: sessionPlatform ?? "unknown" },
      { deviceId: providedDeviceId },
      `${toolName} deviceId '${providedDeviceId}' does not match session '${sessionUuid}' device '${sessionDeviceId}'.`,
    );
  }
}

/**
 * The refusals a control call can be answered with before it is admitted to the session it
 * names (#11558): its `deviceId` is not the session's device, or the session's device cannot be
 * driven now (lost, recovering from an ADB reset, shutting down, identity unresolved). Admission
 * is use: it restarts the session's idle window, and an admitted call's end restarts it again.
 * A call refused here drives nothing, so it must move neither, or a client repeating a stale
 * `deviceId` holds its device for ever. Both checks run again after admission, where they judge
 * the session the call was actually admitted on.
 */
export function refuseControlCallBeforeAdmission(
  toolName: string,
  providedDeviceId: string | undefined,
  sessionUuid: string,
): void {
  const session = defaultDaemonContext.sessionManager()?.getSession(sessionUuid);
  assertSessionDeviceRouting(toolName, providedDeviceId, sessionUuid, {
    sessionDeviceId: session?.assignedDevice,
    sessionPlatform: session?.platform,
  });
  defaultDaemonContext.devicePool()?.assertSessionReadyForAutomation(sessionUuid);
}

interface ToolTargetIdentityInput {
  deviceId: string | undefined;
  platform: unknown;
  device?: BootedDevice;
}

/**
 * Only an unassignable Android transport needs discovery. Its raw adb transport id carries the
 * pool's distinguishing evidence; a synthetic row must never replace an available real row.
 * The cached listing matches direct input frames; an unavailable row stays conservative.
 */
export async function unidentifiedToolTargetRow(
  input: ToolTargetIdentityInput & ({ readOnly: true; now: number } | { readOnly: false }),
  signal?: AbortSignal,
): Promise<BootedDevice | undefined> {
  const pool = input.deviceId ? defaultDaemonContext.devicePool() : undefined;
  if (!input.deviceId || !pool) {
    return undefined;
  }
  const knownDevice = input.device ?? pool.getDevice(input.deviceId);
  // Only an Android transport id needs a synthetic row. A watch is skipped only when the pool
  // knows the device is one; a caller's "watchos" label alone must never bypass the identity check.
  if (input.platform === "ios" || (knownDevice && knownDevice.platform !== "android")) {
    return undefined;
  }
  const synthetic: BootedDevice = {
    deviceId: input.deviceId,
    name: input.deviceId,
    platform: "android",
  };
  if (pool.isAndroidTransportAssignable?.(synthetic) !== false) {
    return undefined;
  }
  const reusableRow = (): BootedDevice | undefined => {
    if (input.device) {
      return input.device;
    }
    if (
      input.readOnly &&
      hasRecentReadTransportListingFailure(pool, synthetic.deviceId, input.now)
    ) {
      return synthetic;
    }
    return undefined;
  };
  const cachedRow = reusableRow();
  if (cachedRow) {
    return cachedRow;
  }
  return reconciledUnidentifiedToolTargetRow(pool, synthetic, signal);
}

/** Cached alias mapping adds no probes; completed listings reconcile before the identity verdict. */
async function reconciledUnidentifiedToolTargetRow(
  pool: Pick<DevicePool, "mapAndroidDiscovery">,
  synthetic: BootedDevice,
  signal?: AbortSignal,
): Promise<BootedDevice> {
  const listing = await PlatformDeviceManagerFactory.getInstance()
    .getBootedDevicesDetailed("android", { signal })
    .catch((error: unknown) => {
      // Missing discovery evidence is safe: the shared rule conservatively checks every possible hold.
      logger.debug(
        `[ToolRegistry] Identity listing unavailable for ${synthetic.deviceId}: ${errorMessage(error)}`,
      );
      return undefined;
    });
  if (!listing || !didSourceSucceedForDevice(listing, "android", undefined)) {
    return synthetic;
  }
  const rows = pool.mapAndroidDiscovery(listing.devices);
  try {
    // FUNNEL 1: the held-alias rule reads pooled identity only after this observation (#6863).
    await reconcileDiscoveryObservation(rows, "tools/call:identity-gate", { signal });
  } catch (error) {
    throw toActionableError(
      error,
      `Failed to reconcile identity listing for ${synthetic.deviceId}`,
    );
  }
  return rows.find((row) => row.deviceId === synthetic.deviceId) ?? synthetic;
}

/** Async identity gate beside broker binding checks; the synchronous holder/mark turn stays intact. */
export async function assertToolControlTargetIdentity(
  input: ToolTargetIdentityInput & { toolName: string; readOnly: boolean; sessionUuid?: string },
  signal?: AbortSignal,
): Promise<void> {
  if (input.readOnly) {
    return;
  }
  const device = await unidentifiedToolTargetRow({ ...input, readOnly: false }, signal);
  if (!device) {
    return;
  }
  const sessionManager = defaultDaemonContext.requireSessionManager();
  await assertFrameTargetIdentityProven(
    defaultDaemonContext.devicePool(),
    device,
    input.toolName,
    Boolean(sessionManager.getSessionForDevice(device.deviceId)),
    {
      sessions: frameHeldSessionsFrom(sessionManager),
      requesterSessionUuid: input.sessionUuid,
      sessionManager,
    },
  );
}

/**
 * Device ownership for tool calls (#10698, #10730), matching `input/*`: a device another live
 * session holds runs device-aware tools only for its holder (a derived `${base}:${label}` session
 * counts as its base). Sessionless calls are refused on a held device; unheld devices stay open.
 * Tools flagged `deviceReadOnly` only watch, which is allowed on any device.
 */
export function assertToolCallerHoldsDevice(
  toolName: string,
  readOnly: boolean,
  deviceId: string | undefined,
  { sessionUuid, autolockEnabled }: { sessionUuid?: string; autolockEnabled: boolean },
): void {
  const devicePool = defaultDaemonContext.devicePool();
  const sessionManager = defaultDaemonContext.sessionManager();
  if (!deviceId || !devicePool || !sessionManager) {
    return;
  }
  if (readOnly) {
    return;
  }
  // An autolocked device is governed by autolock's own check and remedies. Like the general check,
  // it runs before readiness touches the device (#10833).
  if (autolockEnabled && devicePool.getDevice(deviceId)?.autolockSessionId) {
    devicePool.assertAutolockAccess(deviceId, sessionUuid, autolockEnabled);
    return;
  }
  const ownerSessionUuid = sessionManager.getSessionForDevice(deviceId) ?? undefined;
  assertInputRequesterHoldsDevice({
    action: toolName,
    deviceId,
    ownerSessionUuid,
    requesterSessionUuid: sessionUuid,
    sessionManager,
    remedy: TOOL_CALL_REMEDY,
  });
}

/**
 * Broker bindings (#11178), beside the session-holder check: a control call may not act on a device
 * another broker binding holds, idle or not, unless it runs as that binding's execution
 * (`device_assigned_to_binding`); and a managed connection may control only its own binding
 * devices and sessions (`device_outside_broker_grant`). Nor may it act on a device no local session
 * holds while another daemon claims it (`device_owned_by_other_daemon`, #11349). Reads stay open
 * everywhere (Q6).
 */
export async function assertBindingControlAccess(input: {
  toolName: string;
  readOnly: boolean;
  deviceId: string | undefined;
  sessionUuid: string | undefined;
  mcpSessionId: string | undefined;
  platform: unknown;
  remedy?: string;
}): Promise<void> {
  const sessionManager = input.readOnly ? undefined : defaultDaemonContext.sessionManager();
  const connectionScopes = defaultDaemonContext.brokerConnectionScopes();
  if (!sessionManager || !connectionScopes) {
    return;
  }
  const requesterSessionUuid = input.sessionUuid
    ? (resolveToolSelectionBaseSessionUuid(input.sessionUuid, sessionManager) ?? input.sessionUuid)
    : undefined;
  // An internal call (plan step, nested tool) carries no socket session id: its connection is
  // recognized by the broker session it runs on (#11397).
  const connectionRefusal = brokerConnectionControlRefusal({
    binding:
      connectionScopes.get(input.mcpSessionId) ??
      connectionScopes.forGrantedSession(requesterSessionUuid),
    action: input.toolName,
    deviceId: input.deviceId,
    requesterSessionUuid,
    grantedDeviceOf: (grantedSessionUuid) =>
      sessionManager.findSession(grantedSessionUuid)?.assignedDevice ?? undefined,
  });
  if (connectionRefusal) {
    throw connectionRefusal;
  }
  const deviceId = input.deviceId;
  const pool = defaultDaemonContext.devicePool();
  if (deviceId && pool) {
    await assertBindingPoolAccess(pool, { ...input, deviceId }, requesterSessionUuid);
  }
}

async function assertBindingPoolAccess(
  pool: DevicePoolReads,
  input: { toolName: string; deviceId: string; platform: unknown; remedy?: string },
  requesterSessionUuid: string | undefined,
): Promise<void> {
  const { deviceId } = input;
  for (const platform of bindingPlatformsFor(pool.getDevice(deviceId)?.platform, input.platform)) {
    await bindingPoolGate(pool).assertNotAssignedToBinding?.({
      action: input.toolName,
      deviceId,
      platform,
      requesterSessionUuid,
      maxAgeMs: BINDING_INPUT_SNAPSHOT_MAX_AGE_MS,
    });
    // A device no local session holds may be another daemon's (#11349).
    await assertControlNotOnForeignDaemonDevice({
      deviceId,
      platform,
      gate: pool,
      remedy: input.remedy,
    });
  }
}

/**
 * #11469: an internal call (plan step, nested tool) runs for the connection of the call that
 * started it, so a session the call itself names is judged by the owner rule a direct call from
 * that connection gets at the MCP ingress (#11344), before any bind, device move or input. A
 * plan's own session or the ambient routing session that actually replaced the named one was
 * judged when the enclosing call was admitted, so the check is skipped only when the session the
 * call runs on differs from the one it named; a blank plan session replaces nothing. Which calls
 * are judged is the ingress's own predicate (#11555), so a plain control tool (killDevice,
 * deleteDevice) is judged like a device call and reads and acquisitions are never refused. A call
 * with no originating connection (daemon housekeeping, a direct-mode server) carries no identity
 * and is left to the device-holder check.
 */
export function refuseInternalControlOnForeignOwnedSession(
  tool: RegisteredTool,
  namedSessionUuid: string | undefined,
  invocation: { args: Record<string, unknown>; routingSessionUuid?: string },
): void {
  const callerMcpSessionId = getToolSelectionContext()?.callerMcpSessionId;
  if (
    !callerMcpSessionId ||
    namedSessionUuid === undefined ||
    invocation.routingSessionUuid !== namedSessionUuid ||
    !isControlCallOnNamedSession(tool, invocation.args)
  ) {
    return;
  }
  refuseControlOnForeignOwnedSession(
    tool.name,
    namedSessionUuid,
    callerMcpSessionId,
    invocation.args,
  );
}

/**
 * The managed-connection gate for internal calls (#11397). The MCP ingress refuses a managed
 * connection's lifecycle tools and off-binding `setActiveDevice`, but a plan step or nested tool call
 * never passes the ingress and carries no socket session id. It is recognized by the binding session
 * it runs on, so a plan on a binding session cannot acquire, boot, stop or delete a device either.
 * Binding acquisition's own provisioning runs on no binding session and is unaffected.
 */
export function assertInternalCallWithinBrokerGrant(
  toolName: string,
  invocation: { args: Record<string, unknown>; routingSessionUuid?: string },
): void {
  const sessionManager = invocation.routingSessionUuid
    ? defaultDaemonContext.sessionManager()
    : undefined;
  const connectionScopes = defaultDaemonContext.brokerConnectionScopes();
  if (!invocation.routingSessionUuid || !sessionManager || !connectionScopes) {
    return;
  }
  const requesterSessionUuid =
    resolveToolSelectionBaseSessionUuid(invocation.routingSessionUuid, sessionManager) ??
    invocation.routingSessionUuid;
  const refusal = brokerConnectionPlainToolRefusal({
    binding: connectionScopes.forGrantedSession(requesterSessionUuid),
    toolName,
    args: invocation.args,
    requesterSessionUuid,
    grantedDeviceOf: (grantedSessionUuid) =>
      sessionManager.findSession(grantedSessionUuid)?.assignedDevice ?? undefined,
  });
  if (refusal) {
    throw refusal;
  }
}

/**
 * The platforms a target may be on: the pool's record, else the call's platform, else Android and
 * iOS. A call names watchOS to reach a watch at all, so an unpooled watch it names is judged
 * against watch ownership (#14908); a call naming no platform never lands on a watch.
 */
export function bindingPlatformsFor(
  pooledPlatform: Platform | undefined,
  requestedPlatform: unknown,
): Platform[] {
  if (pooledPlatform) {
    return [pooledPlatform];
  }
  return requestedPlatform === "android" ||
    requestedPlatform === "ios" ||
    requestedPlatform === "watchos"
    ? [requestedPlatform]
    : ["android", "ios"];
}

/**
 * The device `ensureDeviceReady` would select for a call without a deviceId, read from the scan
 * the call already shares and the session manager's selections, without touching a device
 * (#10828). It mirrors readiness selection: this connection's explicit `setActiveDevice` pin,
 * then the only candidate on the platform. Undefined when readiness would not settle on a
 * connected device; the post-resolution ownership check still covers that call.
 */
export async function predictReadinessTarget(
  platform: SomePlatform,
  deviceReadiness: DeviceReadiness,
  getConnectedPlatforms: () => Promise<ConnectedPlatformScan>,
  connectionId?: string,
): Promise<string | undefined> {
  const { devices } = await getConnectedPlatforms();
  const pin = deviceReadiness.getExplicitDevicePin(connectionId);
  const platforms = new Set(devices.map((device) => device.platform));
  const targetPlatform =
    platform !== "either" ? platform : platforms.size > 1 ? pin?.platform : devices[0]?.platform;
  const candidates = devices.filter((device) => device.platform === targetPlatform);
  const connected = (deviceId: string | undefined) =>
    candidates.find((device) => device.deviceId === deviceId)?.deviceId;
  return (
    connected(pin?.deviceId) ?? (candidates.length === 1 ? candidates[0]!.deviceId : undefined)
  );
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

export function sessionDisplayPinnedHandler(input: {
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
      sessionUuid:
        getToolSelectionContext()?.routingSessionUuid ??
        (typeof args.sessionUuid === "string" ? args.sessionUuid : undefined),
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

export async function invokeResolvedDeviceHandler(input: {
  target: ExecutionTargetContext & { device: BootedDevice };
  name: string;
  args: Record<string, unknown>;
  handler: DeviceAwareToolHandler;
  progress?: ProgressCallback;
  signal?: AbortSignal;
  auditRunner: AuditRunner;
  navigationRecorder: NavigationToolCallRecorder;
  mutationRecording: DeviceMutationRecording;
  traits?: ToolTraits;
  isResponseFailure: (response: unknown) => boolean;
}): Promise<any> {
  const { target, name, args, handler, progress, signal, navigationRecorder, traits } = input;
  // Fail closed: a watch never reaches a tool that has not opted in (#14899).
  assertToolSupportsDevicePlatform(name, target.device);
  if (target.deviceRead) {
    // A read-only device read is not this caller's use of the device: no navigation recording
    // and no audit run on a device the caller may not hold (#10830).
    return handler(target.device, args, progress, signal);
  }
  deviceActionClock.recordDispatch(
    internalExecutionId(args),
    internalExecutionStartTime(args),
    target.device.deviceId,
  );
  const withdraw = navigationRecorder.record(name, args, target.device, target.sessionUuid, traits);
  const onAbort = () => withdraw?.();
  signal?.addEventListener("abort", onAbort, { once: true });
  let succeeded = false;
  try {
    // The dispatch boundary: a call cancelled since admission (for instance because another
    // session acquired its device, #10829) never reaches the device. `finally` withdraws it.
    signal?.throwIfAborted();
    await input.mutationRecording.beforeToolCall(name, args, target.device, {
      sessionUuid: target.sessionUuid,
      signal,
    });
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
    succeeded = !input.isResponseFailure(response);
    return response;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!succeeded) {
      withdraw?.();
    }
  }
}

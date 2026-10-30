import { brokerConnectionPlatformRefusal } from "../../../daemon/sessionBroker/connectionScope";
import {
  defaultDaemonContext,
  type DaemonContext,
  type DevicePoolReads,
} from "../../../daemon/daemonContext";
import {
  resolveToolSelectionBaseSessionUuid,
  type ToolSelectionSessionManager,
} from "../../../features/toolSelection/selectionSessionResolver";
import { getRemovedToolHint } from "../../../utils/removedTools";
import { assertBrokerConnectionPlainToolCall } from "../../brokerConnectionToolGate";
import { SessionOutsideBoundSessionError } from "../../../daemon/deviceOutsideBoundSessionRefusal";
import { isDeviceInventoryTool } from "../../../daemon/daemonMcpProxy";
import { isDeviceSessionAcquisitionTool } from "../../../daemon/deviceSessionResult";
import { resolveDirectSessionDevice } from "../../../utils/directSessionDeviceRegistry";
import type { McpServerOptions } from "../../index";
import type { SessionToolBinding } from "../../SessionToolBinding";
import { ToolRegistry } from "../../toolRegistry";
import { ToolUnavailableError, UnknownToolError } from "../../../daemon/toolUnavailableError";
import {
  assertUserConfigurableToolNames,
  requestedToolNamesFromSetToolEnabledArgs,
  SET_TOOL_ENABLED_TOOL_NAME,
} from "../../toolSelectionTools";
import type { ToolSelectionProfileRegistry } from "../../../daemon/toolSelectionProfileRegistry";
import {
  resolveActionsCompactMetadata,
  resolveToolResultsNoStructuredContent,
  rememberActionsCompactMetadata,
  rememberToolResultsNoStructuredContent,
} from "./connectionPresentation";
import type { Platform } from "../../../models";
import type { CallContext } from "./callContext";
import { namesLiveSessionOfBoundPlan } from "./namesLiveSessionOfBoundPlan";

export type ResolvedTool = NonNullable<ReturnType<typeof ToolRegistry.getTool>>;

/** What the routing stages need to know about the connection the call arrived on. */
export interface RoutingScope {
  readonly name: string;
  readonly tool: ResolvedTool;
  readonly toolParams: Record<string, unknown>;
  readonly sessionId: string | undefined;
  readonly daemonMode: boolean;
  readonly context: CallContext;
  readonly sessionToolBinding: SessionToolBinding;
  /** The connection identity an implicit autolock is keyed by. */
  readonly implicitAutolockMcpSessionId: string | undefined;
}

/**
 * Resolve the registered tool a call names. A tool that is registered but gated
 * is reported structurally so the daemon proxy does not mistake it for a stale
 * daemon and reset the shared connection (#10177).
 */
export function resolveTool(name: string, toolParams: Record<string, unknown>): ResolvedTool {
  const tool = ToolRegistry.getTool(name);
  if (!tool) {
    const registeredTool = ToolRegistry.getRegisteredTool(name);
    if (registeredTool) {
      throw new ToolUnavailableError(
        name,
        ToolRegistry.getToolAvailabilityGateReasons(registeredTool),
      );
    }
    throw new UnknownToolError(name, getRemovedToolHint(name));
  }
  if (name === SET_TOOL_ENABLED_TOOL_NAME) {
    const selectionArgs = toolParams as { toolName?: unknown; toolNames?: unknown };
    // The handler's Zod schema remains the authority for malformed requests.
    // Valid requests are checked here so a rejected hidden tool cannot mint a
    // connection profile before the handler reaches the same validation.
    if (
      (typeof selectionArgs.toolName === "string" && selectionArgs.toolNames === undefined) ||
      (Array.isArray(selectionArgs.toolNames) &&
        selectionArgs.toolNames.every((toolName) => typeof toolName === "string"))
    ) {
      assertUserConfigurableToolNames(
        requestedToolNamesFromSetToolEnabledArgs(
          selectionArgs as {
            toolName?: string;
            toolNames?: readonly string[];
          },
        ),
      );
    }
  }
  return tool;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export interface DeviceRouting {
  readonly routingSessionUuid: string | undefined;
  /** Set when an implicit autolock resolved the routing session. */
  readonly resolvedImplicitAutolockSessionUuid: string | undefined;
}

/** Route a call with no explicit target through the session this connection holds via autolock. */
export function routeViaAutolock(
  scope: Pick<RoutingScope, "tool" | "implicitAutolockMcpSessionId">,
  rawArgs: Record<string, unknown>,
  pool: Pick<DevicePoolReads, "resolveAutolockSessionForMcpSession">,
): DeviceRouting {
  // Loopback MCP clients are reused by execution scope, not by socket.
  // Their local bindings are partial; only the pool owns all acquisitions.
  const { tool, implicitAutolockMcpSessionId } = scope;
  const platform = knownPlatform(rawArgs.platform);
  const deviceId = typeof rawArgs.deviceId === "string" ? rawArgs.deviceId : undefined;
  let routingSessionUuid = pool.resolveAutolockSessionForMcpSession(
    implicitAutolockMcpSessionId,
    platform,
    undefined,
    deviceId,
  );
  if (!routingSessionUuid && tool.selectsActiveDevice === true) {
    routingSessionUuid = pool.resolveAutolockSessionForMcpSession(implicitAutolockMcpSessionId);
  }
  return { routingSessionUuid, resolvedImplicitAutolockSessionUuid: routingSessionUuid };
}

function knownPlatform(value: unknown): "android" | "ios" | undefined {
  return value === "android" || value === "ios" ? value : undefined;
}

function grantedPlatformOfSession(sessionUuid: string): Platform | undefined {
  const session = defaultDaemonContext.sessionManager()?.peekSession(sessionUuid);
  return session?.assignedDevice
    ? defaultDaemonContext.devicePool()?.getDevice(session.assignedDevice)?.platform
    : undefined;
}

function admittedSessionDevice(id: string) {
  const manager = defaultDaemonContext.sessionManager();
  const pool = defaultDaemonContext.devicePool();
  if (!manager || !pool) {
    return resolveDirectSessionDevice(id)?.device;
  }
  const session = manager.getSession(id);
  if (!session || !manager.isAdmittedForAutomation(session) || !session.assignedDevice) {
    return undefined;
  }
  const device = pool.getDevice(session.assignedDevice);
  return device ? { deviceId: device.id, platform: device.platform } : undefined;
}

function routeViaBinding(scope: RoutingScope, rawArgs: Record<string, unknown>): DeviceRouting {
  const { name, tool, toolParams, sessionId, daemonMode, sessionToolBinding } = scope;
  const requestMcpSessionId = scope.context.requestMcpSessionId;
  const managedBinding = daemonMode
    ? defaultDaemonContext.brokerConnectionScopes()?.get(requestMcpSessionId)
    : undefined;
  const refusal = brokerConnectionPlatformRefusal({
    binding:
      !rawArgs.deviceId && !rawArgs.device && !rawArgs.sessionUuid ? managedBinding : undefined,
    action: name,
    platform: knownPlatform(rawArgs.platform),
    grantedPlatformOf: grantedPlatformOfSession,
  });
  if (refusal) {
    throw refusal;
  }
  const readOnly = tool.isDeviceReadOnlyCall?.(toolParams) === true;
  const routingSessionUuid = sessionToolBinding.resolveDeviceSessionUuid(
    sessionId,
    toolParams,
    admittedSessionDevice,
    {
      selectingActiveDevice: tool.selectsActiveDevice === true,
      deferForeignDevice:
        tool.selectsActiveDevice !== true && (readOnly || managedBinding !== undefined),
      readOnly,
    },
  );
  return { routingSessionUuid, resolvedImplicitAutolockSessionUuid: undefined };
}

/**
 * Route a device-bound call (and `setActiveDevice`) to its session. A call with
 * no explicit target on a daemon connection resolves through the pool's
 * autolock; otherwise the connection's own binding decides.
 */
export function routeDeviceSession(
  scope: RoutingScope,
  initialRoutingSessionUuid: string | undefined,
  hasLocalBinding: boolean,
): DeviceRouting {
  const { name, tool, toolParams, daemonMode, implicitAutolockMcpSessionId } = scope;
  const unrouted = {
    routingSessionUuid: initialRoutingSessionUuid,
    resolvedImplicitAutolockSessionUuid: undefined,
  };
  if (tool.selectsActiveDevice === true) {
    // Refused here, before session routing: a bound session that does not match the target would
    // otherwise surface as a generic routing error instead of the typed refusal (#11268).
    assertBrokerConnectionPlainToolCall({
      daemonMode,
      requiresDevice: false,
      toolName: name,
      mcpSessionId: scope.context.requestMcpSessionId,
      args: toolParams,
      sessionUuid: nonBlankString(toolParams.sessionUuid),
    });
  }
  if (
    !(
      (tool.requiresDevice && !isDeviceSessionAcquisitionTool(name)) ||
      tool.selectsActiveDevice === true
    )
  ) {
    return unrouted;
  }
  const rawArgs = toolParams;
  const pool = defaultDaemonContext.devicePool();
  if (
    pool &&
    implicitAutolockMcpSessionId &&
    !hasLocalBinding &&
    !rawArgs.sessionUuid &&
    !rawArgs.device
  ) {
    return routeViaAutolock(scope, rawArgs, pool);
  }
  return routeViaBinding(scope, rawArgs);
}

/** The session this connection holds in the pool through autolock, when a call names one. */
function autolockSessionOf(
  explicitSessionUuid: string | undefined,
  implicitAutolockMcpSessionId: string | undefined,
): string | undefined {
  return explicitSessionUuid
    ? defaultDaemonContext
        .devicePool()
        ?.resolveAutolockSessionForMcpSession(implicitAutolockMcpSessionId)
    : undefined;
}

/**
 * #6069: enforce connection ownership on the DEVICE-routing path. If this
 * connection already holds an active device session (seeded at construction,
 * acquired mid-connection via getAndroid/getApple, or held in the pool through
 * autolock, #6729), a control tool that names a DIFFERENT `sessionUuid` is
 * rejected. Reads pass read-only without changing the binding. Scoped to
 * `requiresDevice` tools on purpose: `effectiveSessionUuid`'s own cross-routing
 * throw fires for every tool and is limited to construction-seeded bindings,
 * leaving plain tools free to carry any sessionUuid (e.g. a tool-selection
 * profile). Acquisition tools are excluded: they legitimately mint/rebind.
 *
 * Returns whether the call is a read outside the bound session.
 */
export function enforceConnectionOwnership(scope: RoutingScope): boolean {
  const { name, tool, toolParams, sessionId, sessionToolBinding } = scope;
  if (!tool.requiresDevice || isDeviceSessionAcquisitionTool(name)) {
    return false;
  }
  const explicitSessionUuid = nonBlankString(toolParams.sessionUuid);
  const boundDeviceSessionUuid =
    sessionToolBinding.boundDeviceSessionUuid(sessionId) ??
    autolockSessionOf(explicitSessionUuid, scope.implicitAutolockMcpSessionId);
  if (
    !boundDeviceSessionUuid ||
    !explicitSessionUuid ||
    explicitSessionUuid === boundDeviceSessionUuid ||
    sessionToolBinding.ownsSession(sessionId, explicitSessionUuid) ||
    // #11602: a derived `${base}:${label}` session counts as its base, so a connection bound
    // to the base or to one of its labels may name any live session of that plan. It is no
    // second device: the session is already allocated. Whose base it is stays the owner
    // rule's question below.
    namesLiveSessionOfBoundPlan(explicitSessionUuid, boundDeviceSessionUuid)
  ) {
    return false;
  }
  if (tool.isDeviceReadOnlyCall?.(toolParams) === true) {
    return true;
  }
  throw new SessionOutsideBoundSessionError(boundDeviceSessionUuid, explicitSessionUuid);
}

export interface ConnectionPresentation {
  readonly connectionProfileUuid: string | undefined;
  readonly toolResultsNoStructuredContent: boolean;
  readonly actionsCompactMetadata: boolean;
}

export interface SelectionRouting extends ConnectionPresentation {
  readonly requestedDeviceLabel: string | undefined;
  readonly routingBaseSessionUuid: string | undefined;
  readonly derivedLabelSessionUuid: string | undefined;
  readonly labelSessionUuids: string[];
}

export interface SelectionRoutingInput {
  readonly scope: RoutingScope;
  readonly options: McpServerOptions;
  readonly toolSelectionProfileRegistry: ToolSelectionProfileRegistry;
  readonly routingSessionUuid: string | undefined;
  /** The connection's profile as read before device routing ran. */
  readonly initialConnectionProfileUuid: string | undefined;
}

/**
 * Resolve the connection's tool-selection profile and its presentation
 * preferences. An omitted `setToolEnabled` target always belongs to an
 * independent transport-local profile, even after device routing binds:
 * device-session release must not erase choices for a still-open MCP connection.
 */
export function resolveConnectionPresentation(
  input: SelectionRoutingInput,
): ConnectionPresentation & { readonly requestedToolSelectionProfileUuid: string | undefined } {
  const { scope, toolSelectionProfileRegistry } = input;
  const { name, toolParams, sessionId, sessionToolBinding, context } = scope;
  const isSetToolEnabled = name === SET_TOOL_ENABLED_TOOL_NAME;
  const requestedToolSelectionProfileUuid =
    typeof toolParams.sessionUuid === "string" ? toolParams.sessionUuid : undefined;
  let connectionProfileUuid = input.initialConnectionProfileUuid;
  if (
    isSetToolEnabled &&
    !connectionProfileUuid &&
    !requestedToolSelectionProfileUuid?.trim().length
  ) {
    connectionProfileUuid = sessionToolBinding.createAndBindToolSelectionProfile(sessionId);
    toolSelectionProfileRegistry.record(connectionProfileUuid);
  }
  rememberToolResultsNoStructuredContent(
    toolSelectionProfileRegistry,
    connectionProfileUuid,
    isSetToolEnabled ? context.requestedToolResultsNoStructuredContent : undefined,
  );
  rememberActionsCompactMetadata(
    toolSelectionProfileRegistry,
    connectionProfileUuid,
    isSetToolEnabled ? context.requestedActionsCompactMetadata : undefined,
  );
  return {
    connectionProfileUuid,
    requestedToolSelectionProfileUuid,
    toolResultsNoStructuredContent: resolveToolResultsNoStructuredContent(
      toolSelectionProfileRegistry,
      connectionProfileUuid,
    ),
    actionsCompactMetadata: resolveActionsCompactMetadata(
      toolSelectionProfileRegistry,
      connectionProfileUuid,
    ),
  };
}

/**
 * Resolve the base and derived `${base}:${label}` sessions for device routing
 * and post-acquisition `tools/list` enrichment. Per-connection selection
 * curates discovery only; every registered, available MCP tool remains
 * callable regardless of that selection.
 *
 * The derived-label candidate is gated to DEVICE-AWARE tools only. A plain tool
 * strips the `device` field via its `z.object` schema and always executes under
 * the base session, so consulting `base:label`'s profile would let a caller
 * borrow the label's grants for a base-disabled plain tool. For a plain tool,
 * enforcement is base-only; only a `requiresDevice` tool uses the device field.
 */
function selectionSessionManagerOf(
  options: McpServerOptions,
  daemon: DaemonContext = defaultDaemonContext,
): ToolSelectionSessionManager | undefined {
  return options.toolSelectionSessionManager ?? daemon.sessionManager();
}

function labelLookupSessionUuid(
  scope: RoutingScope,
  presentation: ReturnType<typeof resolveConnectionPresentation>,
  routingSessionUuid: string | undefined,
): string | undefined {
  const { connectionProfileUuid, requestedToolSelectionProfileUuid } = presentation;
  return scope.name === SET_TOOL_ENABLED_TOOL_NAME &&
    requestedToolSelectionProfileUuid !== undefined &&
    requestedToolSelectionProfileUuid === connectionProfileUuid
    ? (scope.sessionToolBinding.boundDeviceSessionUuid(scope.sessionId) ?? routingSessionUuid)
    : routingSessionUuid;
}

export function resolveSelectionRouting(input: SelectionRoutingInput): SelectionRouting {
  const { scope, options, routingSessionUuid } = input;
  const { name, tool, toolParams } = scope;
  const presentation = resolveConnectionPresentation(input);
  const { connectionProfileUuid } = presentation;
  const requestedDeviceLabel = nonBlankString(toolParams.device);
  const selectionSessionManager = selectionSessionManagerOf(options);
  // `setToolEnabled` is a plain tool, so an explicit connection-profile UUID
  // remains its routing session. Its readback still has to enumerate labels
  // from this connection's acquired device session, not from that profile.
  const routingSessionUuidForLabelLookup = labelLookupSessionUuid(
    scope,
    presentation,
    routingSessionUuid,
  );
  const inventoryTool = isDeviceInventoryTool(name);
  const routingBaseSessionUuid = inventoryTool
    ? routingSessionUuidForLabelLookup
    : resolveToolSelectionBaseSessionUuid(
        routingSessionUuidForLabelLookup,
        selectionSessionManager,
      );
  const deviceLabels = routingBaseSessionUuid
    ? selectionSessionManager?.getDeviceLabels(routingBaseSessionUuid)
    : undefined;
  return {
    connectionProfileUuid,
    toolResultsNoStructuredContent: presentation.toolResultsNoStructuredContent,
    actionsCompactMetadata: presentation.actionsCompactMetadata,
    requestedDeviceLabel,
    routingBaseSessionUuid,
    derivedLabelSessionUuid:
      tool.requiresDevice && requestedDeviceLabel
        ? deviceLabels?.[requestedDeviceLabel]
        : undefined,
    labelSessionUuids: inventoryTool ? [] : Array.from(new Set(Object.values(deviceLabels ?? {}))),
  };
}

import { defaultDaemonContext, type DaemonContext } from "../../../daemon/daemonContext";
import type { SessionManager } from "../../../daemon/sessionManager";
import { isDeviceInventoryTool } from "../../../daemon/daemonMcpProxy";
import { SessionReleaseBroadcaster } from "../../../daemon/sessionReleaseBroadcast";
import {
  getActiveDeviceSelectionFromResult,
  isDeviceSessionAcquisitionTool,
} from "../../../daemon/deviceSessionResult";
import { resolveDirectSessionDevice } from "../../../utils/directSessionDeviceRegistry";
import { executionTracker, sessionExecutionMetadataOf } from "../../../daemon/executionTracker";
import {
  isSessionOwnedByAnotherConnection,
  namedSessionAccess,
} from "../../foreignOwnedSessionRefusal";
import { getAbortSignal } from "../../../utils/AbortContext";
import { sessionForToolBinding } from "../../sessionForToolBinding";
import { ToolRegistry } from "../../toolRegistry";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../../toolSelectionTools";
import type { ToolSelectionProfileRegistry } from "../../../daemon/toolSelectionProfileRegistry";
import type { InvocationPlan } from "./invoke";

/**
 * Admit a plain tool that names a session, so it passes the same refusals as
 * every sibling plain session tool. Device-aware tools carry their admitted
 * identity into execution in ToolRegistry; acquisition, active-device selection and a
 * profile-minted `setToolEnabled` are exempt.
 */
export async function admitNamedSession(
  plan: InvocationPlan,
  input: {
    readonly daemonMode: boolean;
    readonly plainReadCall: boolean;
    readonly toolSelectionProfileRegistry: ToolSelectionProfileRegistry;
  },
): Promise<void> {
  const { name, tool, providedSessionUuid, execution } = plan;
  if (
    !input.daemonMode ||
    !providedSessionUuid ||
    tool.requiresDevice ||
    isDeviceSessionAcquisitionTool(name) ||
    tool.selectsActiveDevice === true ||
    // #6148 (#6069 residual): setToolEnabled is exempt ONLY when the explicit
    // sessionUuid is a profile THIS DAEMON PROCESS itself minted
    // (toolSelectionProfileRegistry.has, populated only alongside
    // createAndBindToolSelectionProfile). The registry is process-wide, so it
    // survives the daemon-proxy loopback hop where the mint call and a later
    // explicit reaffirm route through different internal clients, each with
    // its own createMcpServer()/SessionToolBinding. It is deliberately narrower
    // than `connectionProfileUuid`, which also falls back to the unauthenticated
    // `initialToolSelectionProfileUuid` threaded from a caller-controlled HTTP
    // header (DAEMON_TOOL_SELECTION_PROFILE_HEADER, see src/daemon/daemon.ts):
    // a fabricated value is never recorded in the registry, so it still fails
    // this check. The cross-connection resume path never puts the profile in
    // `arguments.sessionUuid`, so it never reaches this branch. Any other
    // explicit sessionUuid clears the same admission check every sibling plain
    // session tool enforces.
    (name === SET_TOOL_ENABLED_TOOL_NAME &&
      input.toolSelectionProfileRegistry.has(providedSessionUuid))
  ) {
    return;
  }
  // #11555: naming a session another connected client owns is not use of it, for any
  // plain tool the owner rule lets through (`setToolEnabled`). Such a call passes the
  // same refusals as the owner's, but neither its admission nor its end stamps the
  // session, and while in flight it holds the session no more than a read does.
  const namesForeignOwnedSession = isSessionOwnedByAnotherConnection(
    providedSessionUuid,
    plan.context.requestMcpSessionId,
  );
  await defaultDaemonContext
    .requireSessionManager()
    .admitIssuedSessionForAutomation(providedSessionUuid, sessionExecutionMetadataOf(execution), {
      ...namedSessionAccess(input.plainReadCall, namesForeignOwnedSession),
      signal: getAbortSignal(),
    });
  if (namesForeignOwnedSession) {
    executionTracker.markReadOnlySessionAccess(execution.id);
  } else {
    // Only an admitted call's end is session use (#10824).
    executionTracker.markSessionAdmitted(execution.id);
  }
}

/**
 * The release identities seen while a device-acquisition handler runs. A
 * handler can mint and release a session before returning its UUID, so they are
 * retained for this call only, through publication.
 */
export function trackAcquisitionReleases(name: string): {
  readonly released: Set<string>;
  readonly cleanup: (() => void) | undefined;
} {
  const released = new Set<string>();
  if (!isDeviceSessionAcquisitionTool(name)) {
    return { released, cleanup: undefined };
  }
  const onSessionReleased = (sessionUuid: string) => {
    released.add(sessionUuid);
  };
  const unregister = ToolRegistry.registerSessionBindingReleaseHandler({ onSessionReleased });
  const unsubscribe = SessionReleaseBroadcaster.subscribe(onSessionReleased);
  return {
    released,
    cleanup: () => {
      try {
        unregister();
      } finally {
        unsubscribe();
      }
    },
  };
}

/** Bind a successful active-device selection (`setActiveDevice`) result to the connection. */
export function bindActiveDeviceResult(
  plan: InvocationPlan,
  result: { isError?: boolean } | undefined,
): void {
  if (
    plan.tool.selectsActiveDevice === true &&
    !result?.isError &&
    plan.sessionToolBinding.bind(
      plan.sessionId,
      getActiveDeviceSelectionFromResult(result)?.sessionUuid ?? plan.routingSessionUuid,
    )
  ) {
    ToolRegistry.notifyToolSelectionChanged();
  }
}

function isRecordingStopById(name: string, parsedParams: unknown): boolean {
  if (name !== "videoRecording" || !parsedParams || typeof parsedParams !== "object") {
    return false;
  }
  const params = parsedParams as Record<string, unknown>;
  return params.action === "stop" && typeof params.recordingId === "string";
}

type DaemonSessionManager = SessionManager;

/** Whether the named session is one this call may bind: admitted for automation, or a direct session. */
function namedSessionIsBindable(
  sessionUuid: string,
  daemonSessionManager: DaemonSessionManager | undefined,
  sessionForBinding: ReturnType<typeof sessionForToolBinding> | undefined,
): boolean {
  if (!daemonSessionManager) {
    return resolveDirectSessionDevice(sessionUuid) !== undefined;
  }
  return (
    sessionForBinding !== null &&
    sessionForBinding !== undefined &&
    daemonSessionManager.isAdmittedForAutomation(sessionForBinding)
  );
}

/**
 * Bind the connection to the explicitly named session after a successful call,
 * and attach it to the pool for a device control call. Reads exempted from
 * either bound-session routing refusal never bind or adopt, a foreign-owned
 * session never binds this connection (#11235), and neither does an
 * acquisition, inventory or recording-id cleanup call.
 */
export async function bindNamedSession(
  plan: InvocationPlan,
  input: {
    readonly result: { isError?: boolean } | undefined;
    readonly readOutsideBoundSession: boolean;
  },
): Promise<void> {
  const { name, tool, providedSessionUuid, sessionId, sessionToolBinding } = plan;
  const { implicitAutolockMcpSessionId } = plan;
  const isRecordingIdCleanup = isRecordingStopById(name, plan.parsedParams);
  const daemonSessionManager = currentSessionManager();
  const readOnlyCall = tool.isDeviceReadOnlyCall?.(plan.parsedParams) === true;
  const sessionForBinding = lookupSessionForBinding(plan, {
    daemonSessionManager,
    skip: input.readOutsideBoundSession || isRecordingIdCleanup,
    readOnlyCall,
  });
  if (
    !providedSessionUuid ||
    callNeverBinds(name, input, isRecordingIdCleanup) ||
    // Ownership first (#11235): a foreign-owned session never binds this connection.
    (daemonSessionManager !== undefined &&
      ownedByOtherConnection(providedSessionUuid, implicitAutolockMcpSessionId)) ||
    !namedSessionIsBindable(providedSessionUuid, daemonSessionManager, sessionForBinding)
  ) {
    return;
  }
  if (sessionToolBinding.bind(sessionId, providedSessionUuid)) {
    ToolRegistry.notifyToolSelectionChanged();
  }
  if (tool.requiresDevice && !readOnlyCall && daemonSessionManager) {
    await attachToPool(providedSessionUuid, implicitAutolockMcpSessionId);
  }
}

async function attachToPool(sessionUuid: string, mcpSessionId: string | undefined): Promise<void> {
  if (mcpSessionId) {
    await defaultDaemonContext
      .requireDevicePoolWrites()
      .attachExplicitSessionUuidCall(sessionUuid, mcpSessionId);
  }
}

function ownedByOtherConnection(sessionUuid: string, mcpSessionId: string | undefined): boolean {
  return defaultDaemonContext
    .requireFullDevicePool()
    .isSessionOwnedByOtherConnection(sessionUuid, mcpSessionId);
}

function callNeverBinds(
  name: string,
  input: {
    readonly result: { isError?: boolean } | undefined;
    readonly readOutsideBoundSession: boolean;
  },
  isRecordingIdCleanup: boolean,
): boolean {
  return (
    isBindExempt(name) ||
    input.readOutsideBoundSession ||
    Boolean(input.result?.isError) ||
    isRecordingIdCleanup
  );
}

/** Acquisition, inventory and tool-selection calls never bind the connection to a named session. */
function isBindExempt(name: string): boolean {
  return (
    isDeviceSessionAcquisitionTool(name) ||
    isDeviceInventoryTool(name) ||
    name === SET_TOOL_ENABLED_TOOL_NAME
  );
}

function lookupSessionForBinding(
  plan: InvocationPlan,
  input: {
    readonly daemonSessionManager: DaemonSessionManager | undefined;
    readonly skip: boolean;
    readonly readOnlyCall: boolean;
  },
) {
  const { daemonSessionManager } = input;
  return daemonSessionManager &&
    plan.providedSessionUuid &&
    !input.skip &&
    !isDeviceInventoryTool(plan.name)
    ? sessionForToolBinding(
        daemonSessionManager,
        plan.providedSessionUuid,
        sessionExecutionMetadataOf(plan.execution),
        input.readOnlyCall,
      )
    : undefined;
}

function currentSessionManager(
  daemon: DaemonContext = defaultDaemonContext,
): DaemonSessionManager | undefined {
  return daemon.sessionManager();
}

import { DaemonState } from "../daemon/daemonState";
import { DeviceOwnedByOtherDaemonError } from "../daemon/deviceAcquisitionRefusals";
import { INTERNAL_MCP_SESSION_PARAM } from "../daemon/constants";
import { assertInputRequesterHoldsDevice } from "../daemon/inputDeviceOwnership";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import type { Platform } from "../models";
import { logger } from "../utils/logger";
import { managedSlotPoolGate } from "../daemon/managedSlots/managedSlotPoolGate";

/** Remedy text for a refused device lifecycle call (killDevice, deleteDevice). */
export const LIFECYCLE_TOOL_REMEDY =
  "call it with the holding session's sessionUuid, wait for the holder to release the device, " +
  "or pass force: true to stop it anyway.";

/** Who is asking: the call's routing session and the MCP connection it came over. */
export interface LifecycleRequester {
  sessionUuid: string | undefined;
  mcpSessionId: string | undefined;
}

/**
 * The requester of a plain (`ToolRegistry.register`) tool call. Such tools never pass through
 * device-aware target resolution, so the routing session (an explicit, admitted `sessionUuid` or
 * the connection's bound session) comes from the ambient tool-selection context.
 */
export function lifecycleRequester(args: object): LifecycleRequester {
  const mcpSessionId: unknown = Reflect.get(args, INTERNAL_MCP_SESSION_PARAM);
  const explicitSessionUuid: unknown = Reflect.get(args, "sessionUuid");
  return {
    sessionUuid:
      getToolSelectionContext()?.routingSessionUuid ??
      (typeof explicitSessionUuid === "string" && explicitSessionUuid.trim().length > 0
        ? explicitSessionUuid
        : undefined),
    mcpSessionId: typeof mcpSessionId === "string" ? mcpSessionId : undefined,
  };
}

/**
 * Device ownership for lifecycle tools that stop a running device (#10785). These tools are
 * registered without device routing, so `ToolRegistry`'s device-aware ownership check
 * (#10698, #10783) never sees them. A device another live session holds may be stopped only by
 * its holder (a derived `${base}:${label}` session counts as its base, and an autolocked
 * device's owning MCP connection counts as its holder), or by an explicit user `force`, which is
 * logged. Unheld devices, and calls with no initialized daemon, are unaffected.
 *
 * Throws `InputDeviceOwnedError` (code `device_owned_by_other_session`), or
 * `DeviceAssignedToManagedSlotError` (code `device_assigned_to_managed_slot`) for a device a
 * managed slot holds, idle or not, unless the requester is that slot's execution (#11174).
 */
export function assertLifecycleCallerHoldsDevice(input: {
  toolName: string;
  device: { deviceId: string; platform: Platform };
  requester: LifecycleRequester;
  force: boolean;
  /** Extra stable identities of the target (an AVD name the caller resolved). */
  stableIds?: ReadonlyArray<string | undefined>;
}): void {
  const { toolName, device, requester, force } = input;
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const sessionManager = daemonState.getSessionManager();
  const base = (uuid: string) => resolveToolSelectionBaseSessionUuid(uuid, sessionManager) ?? uuid;
  assertNotForeignManagedSlotFromSnapshot(daemonState, input);
  const owner = sessionManager.getSessionForDevice(device.deviceId) ?? undefined;
  if (!owner) {
    return;
  }
  if (requester.sessionUuid && base(requester.sessionUuid) === base(owner)) {
    return;
  }
  const pool = daemonState.getDevicePool();
  if (
    requester.mcpSessionId &&
    pool.getDevice(device.deviceId)?.autolockSessionId === owner &&
    pool.resolveAutolockSessionForMcpSession(
      requester.mcpSessionId,
      device.platform,
      undefined,
      device.deviceId,
    ) === owner
  ) {
    return;
  }
  if (force) {
    logger.warn(
      `[DeviceTools] ${toolName} force-stopping device '${device.deviceId}' held by session ` +
        `${owner}; requester session ${requester.sessionUuid ?? "none"} does not hold it.`,
    );
    return;
  }
  assertInputRequesterHoldsDevice({
    action: toolName,
    deviceId: device.deviceId,
    ownerSessionUuid: owner,
    requesterSessionUuid: requester.sessionUuid,
    sessionManager,
    remedy: LIFECYCLE_TOOL_REMEDY,
  });
}

/** Remedy text for a lifecycle call refused because another live daemon holds the device. */
export const LIFECYCLE_TOOL_FOREIGN_DAEMON_REMEDY =
  "Stop it through the daemon that holds it, wait for that daemon to release it, " +
  "or pass force: true to stop it anyway.";

/**
 * Cross-daemon half of the lifecycle guard (#11200). {@link assertLifecycleCallerHoldsDevice}
 * only sees this daemon's sessions; a device a live peer daemon holds (its allocation claim is
 * published and its control socket reports a session on it) reads as unheld there. Refuse to stop
 * such a device unless the user forces it, which is logged. A device this daemon holds is judged
 * by the local guard instead.
 *
 * The daemon state is read synchronously, before the first await, so the check runs against the
 * daemon that received the call.
 *
 * Throws `DeviceOwnedByOtherDaemonError` (code `device_owned_by_other_daemon`).
 */
export function assertLifecycleTargetNotHeldByOtherDaemon(input: {
  toolName: string;
  device: { deviceId: string; platform: Platform };
  force: boolean;
}): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return Promise.resolve();
  }
  return checkForeignHolder(daemonState.getDevicePool(), input);
}

async function checkForeignHolder(
  pool: Pick<ReturnType<DaemonState["getDevicePool"]>, "assertNotClaimedByForeignDaemon">,
  input: {
    toolName: string;
    device: { deviceId: string; platform: Platform };
    force: boolean;
  },
): Promise<void> {
  const { toolName, device, force } = input;
  try {
    await pool.assertNotClaimedByForeignDaemon(
      device.deviceId,
      device.platform,
      LIFECYCLE_TOOL_FOREIGN_DAEMON_REMEDY,
    );
  } catch (error) {
    if (!force || !(error instanceof DeviceOwnedByOtherDaemonError)) {
      throw error;
    }
    logger.warn(
      `[DeviceTools] ${toolName} force-stopping device '${device.deviceId}' held by another ` +
        `AutoMobile daemon${error.ownerPid === undefined ? "" : ` (PID ${error.ownerPid})`}.`,
    );
  }
}

/**
 * A managed slot's device, idle or not, stops only for that slot's execution; `force` does not
 * override it (#11174). This synchronous re-check reads the snapshot the entry check refreshed.
 */
function assertNotForeignManagedSlotFromSnapshot(
  daemonState: DaemonState,
  input: {
    toolName: string;
    device: { deviceId: string; platform: Platform };
    requester: LifecycleRequester;
    stableIds?: ReadonlyArray<string | undefined>;
  },
): void {
  const managedRefusal = managedSlotPoolGate(daemonState.getDevicePool()).managedSlotRefusalFor?.({
    action: input.toolName,
    deviceId: input.device.deviceId,
    platform: input.device.platform,
    stableIds: input.stableIds,
    requesterSessionUuid: baseRequesterSession(daemonState, input.requester),
  });
  if (managedRefusal) {
    throw managedRefusal;
  }
}

function baseRequesterSession(
  daemonState: DaemonState,
  requester: LifecycleRequester,
): string | undefined {
  if (!requester.sessionUuid) {
    return undefined;
  }
  return (
    resolveToolSelectionBaseSessionUuid(requester.sessionUuid, daemonState.getSessionManager()) ??
    requester.sessionUuid
  );
}

/**
 * Entry check for a lifecycle tool on a device a managed slot may hold (#11174): refreshes the
 * registry snapshot and refuses any caller but the slot's own execution, idle device or not, with
 * `device_assigned_to_managed_slot`. Covers stopped devices too (deleteDevice of an AVD), which the
 * session-holder check never sees. Calls with no initialized daemon are unaffected.
 */
export async function assertLifecycleCallerNotOnForeignManagedSlot(input: {
  toolName: string;
  device: { deviceId: string; platform: Platform };
  requester: LifecycleRequester;
  stableIds?: ReadonlyArray<string | undefined>;
}): Promise<void> {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const requesterSessionUuid = baseRequesterSession(daemonState, input.requester);
  await managedSlotPoolGate(daemonState.getDevicePool()).assertNotAssignedToManagedSlot?.({
    action: input.toolName,
    deviceId: input.device.deviceId,
    platform: input.device.platform,
    stableIds: input.stableIds,
    requesterSessionUuid,
  });
}

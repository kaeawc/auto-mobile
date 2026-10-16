import { holderOf } from "../daemon/deviceBinding";
import { DaemonState } from "../daemon/daemonState";
import { DeviceOwnedByOtherDaemonError } from "../daemon/deviceAcquisitionRefusals";
import { INTERNAL_MCP_SESSION_PARAM } from "../daemon/constants";
import {
  assertInputRequesterHoldsDevice,
  InputDeviceOwnedError,
} from "../daemon/inputDeviceOwnership";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import type { RestartStopIdentity } from "../daemon/devicePool";
import {
  androidLifecycleDiscoveryIncomplete,
  POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS,
  type DeviceToolsDependencies,
} from "../features/deviceLifecycle/deviceLifecycleCore";
import { isUnresolvedAndroidEmulatorName } from "../devices/deviceIdentityEvidence";
import type { BootedDevice, Platform } from "../models";
import { logger } from "../utils/logger";
import { bindingPoolGate } from "../daemon/sessionBroker/provisioning/poolGate";

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

/** Resolve once before synchronous stop guards; shutdown reuses this evidence for its capture. */
export async function resolveRestartStopIdentity(input: {
  device: BootedDevice;
  dependencies: DeviceToolsDependencies;
  deadlineMs: number;
  signal?: AbortSignal;
  /** Identity of an already-stopped image from teardown's existing target resolution. */
  stoppedStableId?: string;
}): Promise<RestartStopIdentity | undefined> {
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return undefined;
  }
  const pool = daemonState.getDevicePool();
  const { device, dependencies, deadlineMs, signal, stoppedStableId } = input;
  if (!pool.hasRestartHandoffReservation?.(device.platform)) {
    return undefined;
  }
  const known =
    stoppedStableId ?? pool.restartStopConfirmedPooledIdentity?.(device.deviceId, device.platform);
  if (known !== undefined && known.trim() !== "") {
    return { confirmed: known };
  }
  const timeoutMs = Math.min(
    POOLED_AVD_NAME_VERIFICATION_TIMEOUT_MS,
    deadlineMs - dependencies.timer.now(),
  );
  if (timeoutMs <= 0) {
    return { unconfirmed: true };
  }
  try {
    const name = await dependencies.resolveRunningAndroidAvdName(device, timeoutMs, signal);
    return name && !isUnresolvedAndroidEmulatorName({ ...device, name })
      ? { confirmed: name }
      : { unconfirmed: true };
  } catch (error) {
    logger.warn(`[DeviceTools] Stop identity probe failed for ${device.deviceId}`, error);
    return { unconfirmed: true };
  }
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
 * `DeviceAssignedToBindingError` (code `device_assigned_to_binding`) for a device a
 * broker binding holds, idle or not, unless the requester is that binding's execution (#11174).
 */
export function assertLifecycleCallerHoldsDevice(input: {
  toolName: string;
  device: { deviceId: string; platform: Platform };
  requester: LifecycleRequester;
  force: boolean;
  /** Caller labels are hints for an unresolved target, never reservation identity. */
  stableIds?: ReadonlyArray<string | undefined>;
  stopIdentity?: RestartStopIdentity;
  /** Stop tools also fence a restart hold's original connection, even with force. */
  checkRestartHold?: boolean;
}): void {
  const { toolName, device, requester, force } = input;
  const daemonState = DaemonState.getInstance();
  if (!daemonState.isInitialized()) {
    return;
  }
  const sessionManager = daemonState.getSessionManager();
  const base = (uuid: string) => resolveToolSelectionBaseSessionUuid(uuid, sessionManager) ?? uuid;
  assertNotForeignBindingFromSnapshot(daemonState, input);
  const pool = daemonState.getDevicePool();
  assertLifecycleCallerMayStopRestartReservation(input);
  const owner = sessionManager.getSessionForDevice(device.deviceId) ?? undefined;
  if (!owner) {
    return;
  }
  if (requester.sessionUuid && base(requester.sessionUuid) === base(owner)) {
    return;
  }
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

/** Stopped images need only the restart guard; live-holder and broker snapshot checks stay separate. */
export function assertLifecycleCallerMayStopRestartReservation({
  toolName,
  device,
  requester,
  checkRestartHold,
  stableIds,
  stopIdentity,
}: Parameters<typeof assertLifecycleCallerHoldsDevice>[0]): void {
  const daemonState = DaemonState.getInstance();
  if (!checkRestartHold || !daemonState.isInitialized()) {
    return;
  }
  const pool = daemonState.getDevicePool();
  const identity = {
    platform: device.platform,
    stableIds: stableIds?.filter((id): id is string => id !== undefined),
    stopIdentity,
  };
  assertRestartStopIdentityConfirmed(pool, device, requester, identity);
  const reservation = pool.restartReservationForStop?.(device.deviceId, requester, identity);
  if (
    reservation?.foreignConnection ||
    pool.isRestartReservationOwnedByOtherConnection?.(device.deviceId, requester, identity)
  ) {
    throw new InputDeviceOwnedError(
      toolName,
      device.deviceId,
      requester.sessionUuid,
      undefined,
      `${toolName} refused: device '${device.deviceId}' is reserved for session ` +
        `${requester.sessionUuid}'s device-restart recovery, and this connection did not own ` +
        "that session when the device restarted. Call from the owning connection, or wait for " +
        "the recovery window to end. force: true does not override naming another client's session.",
    );
  }
  assertNotStoppingAnotherRestartHold(pool, { toolName, device, requester }, reservation);
}

function assertRestartStopIdentityConfirmed(
  pool: ReturnType<DaemonState["getDevicePool"]>,
  device: { deviceId: string; platform: Platform },
  requester: LifecycleRequester,
  identity: {
    platform: Platform;
    stableIds?: readonly string[];
    stopIdentity?: RestartStopIdentity;
  },
): void {
  const unconfirmed = identity.stopIdentity
    ? "unconfirmed" in identity.stopIdentity
    : pool.restartStopConfirmedPooledIdentity?.(device.deviceId, device.platform) === undefined;
  if (
    unconfirmed &&
    pool.hasUnconfirmedRestartStopReservation?.(device.deviceId, requester, identity)
  ) {
    throw androidLifecycleDiscoveryIncomplete(device.deviceId, undefined);
  }
}

function assertNotStoppingAnotherRestartHold(
  pool: ReturnType<DaemonState["getDevicePool"]>,
  {
    toolName,
    device,
    requester,
  }: Pick<
    Parameters<typeof assertLifecycleCallerHoldsDevice>[0],
    "toolName" | "device" | "requester"
  >,
  reservation: ReturnType<ReturnType<DaemonState["getDevicePool"]>["restartReservationForStop"]>,
): void {
  if (!reservation || reservation.owned) {
    return;
  }
  const differentSession =
    requester.sessionUuid !== undefined ||
    pool.restartStopConnectionHasLiveSession?.(requester.mcpSessionId);
  if (!differentSession) {
    return;
  }
  throw new InputDeviceOwnedError(
    toolName,
    device.deviceId,
    requester.sessionUuid,
    undefined,
    `${toolName} refused: device '${device.deviceId}' is reserved for session ` +
      `${reservation.sessionUuid}'s device-restart recovery. ` +
      (requester.sessionUuid
        ? `Session ${requester.sessionUuid} does not hold it. `
        : "This connection holds another device session. ") +
      `Retry in ${reservation.retryAfterMs}ms, once the recovery window ends. ` +
      "force: true does not override a reservation held for another session.",
    reservation.retryAfterMs,
  );
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
 * A broker binding's device, idle or not, stops only for that binding's execution; `force` does not
 * override it (#11174). On a failed read, preserve the entry check's admission of the session
 * already holding this device in the pool; a current snapshot still judges the registry first.
 */
function assertNotForeignBindingFromSnapshot(
  daemonState: DaemonState,
  input: {
    toolName: string;
    device: { deviceId: string; platform: Platform };
    requester: LifecycleRequester;
    stableIds?: ReadonlyArray<string | undefined>;
  },
): void {
  const pool = daemonState.getDevicePool();
  const gate = bindingPoolGate(pool);
  const requesterSessionUuid = baseRequesterSession(daemonState, input.requester);
  const managedRefusal = gate.bindingRefusalFor?.({
    action: input.toolName,
    deviceId: input.device.deviceId,
    platform: input.device.platform,
    stableIds: input.stableIds,
    requesterSessionUuid,
  });
  if (managedRefusal) {
    if (
      gate.bindingSnapshotRetainedAfterFailedRead?.() &&
      requesterSessionUuid &&
      holderOf(pool.getDevice(input.device.deviceId)) === requesterSessionUuid
    ) {
      logger.debug(`[DeviceTools] ${input.toolName} preserves failed-read holder admission.`);
      return;
    }
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
 * Entry check for a lifecycle tool on a device a broker binding may hold (#11174): refreshes the
 * registry snapshot and refuses any caller but the binding's own execution, idle device or not, with
 * `device_assigned_to_binding`. Covers stopped devices too (deleteDevice of an AVD), which the
 * session-holder check never sees. Calls with no initialized daemon are unaffected.
 */
export async function assertLifecycleCallerNotOnForeignBinding(input: {
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
  await bindingPoolGate(daemonState.getDevicePool()).assertNotAssignedToBinding?.({
    action: input.toolName,
    deviceId: input.device.deviceId,
    platform: input.device.platform,
    stableIds: input.stableIds,
    requesterSessionUuid,
  });
}

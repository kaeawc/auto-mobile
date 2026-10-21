import { ActionableError, type BootedDevice } from "../models";
import { isAndroidTransportAddressSerial } from "../utils/androidSerial";
import type { ToolSelectionSessionManager } from "../features/toolSelection/selectionSessionResolver";
import { InputDeviceOwnedError, isSameHolderSession } from "./inputDeviceOwnership";
import { DeviceAssignedToBindingError } from "./sessionBroker/provisioning/refusal";
import type { ManagedDeviceEntry } from "./sessionBroker/registry/bindingRegistry";

/**
 * The pool's Android transport fold, as a direct socket frame needs it. Every member is optional:
 * direct mode has no pool, and older socket-state fakes carry none of them.
 */
export interface FrameDeviceIdentityPool {
  mapAndroidDiscovery?(devices: readonly BootedDevice[]): BootedDevice[];
  resolveAndroidCanonicalId?(deviceId: string): string;
  normalizeAndroidDiscovery?(
    devices: readonly BootedDevice[],
    assignmentLockHeld?: boolean,
    isCurrent?: () => boolean,
    completeAndroidSnapshot?: boolean,
  ): Promise<BootedDevice[]>;
  getAllDevices?(): readonly { id: string }[];
  isAndroidTransportAssignable?(device: BootedDevice): boolean;
  androidTransportMayAliasDevice?(transport: BootedDevice, heldDeviceId?: string): boolean;
  androidBindingHold?(
    heldDeviceIds: readonly string[],
  ): Promise<{ entry?: ManagedDeviceEntry } | undefined>;
}

/** A direct frame's discovery and device id, in the ids the pool and its sessions are keyed on. */
export interface CanonicalFrameDiscovery {
  devices: BootedDevice[];
  /** The frame's `deviceId` as the pool's canonical id; undefined when the frame named none. */
  deviceId: string | undefined;
}

/**
 * The pooled canonical id for a device id that arrived on a direct frame. One handset reachable
 * over USB and wireless debugging is ONE pooled device (#10201) held under one id; a frame may
 * name it by either. Identity for iOS, for an id the pool has not folded, and in direct mode.
 */
export function canonicalFrameDeviceId(
  pool: FrameDeviceIdentityPool | undefined,
  deviceId: string,
): string {
  return pool?.resolveAndroidCanonicalId?.(deviceId) ?? deviceId;
}

/**
 * Resolve a direct frame's raw discovery rows and `deviceId` to pooled canonical ids BEFORE any
 * holder, broker binding or admission decision reads them (#11596): those decisions are keyed on the
 * canonical id, so a frame naming a held handset by its other transport id would otherwise find no
 * holder. Uses the pool's own fold (`mapAndroidDiscovery` / `resolveAndroidCanonicalId`), as
 * `resourceDeviceResolver.ts` does.
 *
 * A transport address the pool has never folded (a wireless id first seen on this frame) proves
 * nothing about which handset answers on it, so it is probed and folded additively first, exactly
 * as the disconnect monitor folds a new wireless row: an additive fold never prunes alias groups.
 * Only a row the frame can target is worth a probe: the one it names, or any when it names none.
 * A row the fold still cannot prove is checked against held devices by
 * {@link assertFrameTargetIdentityProven}.
 */
export async function canonicalizeFrameDiscovery(
  pool: FrameDeviceIdentityPool | undefined,
  platform: "android" | "ios",
  rawDevices: readonly BootedDevice[],
  deviceId: string | undefined,
): Promise<CanonicalFrameDiscovery> {
  if (!pool || platform !== "android") {
    return { devices: [...rawDevices], deviceId };
  }
  let devices = pool.mapAndroidDiscovery?.(rawDevices) ?? [...rawDevices];
  if (pool.normalizeAndroidDiscovery && hasUnfoldedTransport(pool, devices, deviceId)) {
    devices = await pool.normalizeAndroidDiscovery(rawDevices, false, () => true, false);
  }
  return {
    devices,
    deviceId: deviceId === undefined ? undefined : canonicalFrameDeviceId(pool, deviceId),
  };
}

/**
 * A mapped row the frame can target that is still a bare transport address the pool does not hold
 * as a device.
 */
function hasUnfoldedTransport(
  pool: FrameDeviceIdentityPool,
  mapped: readonly BootedDevice[],
  deviceId: string | undefined,
): boolean {
  const pooledIds = new Set((pool.getAllDevices?.() ?? []).map((device) => device.id));
  return mapped.some(
    (device) =>
      device.platform === "android" &&
      (deviceId === undefined || device.deviceId === deviceId) &&
      isAndroidTransportAddressSerial(device.deviceId) &&
      !pooledIds.has(device.deviceId),
  );
}

/**
 * An absent held id represents an unknown broker binding device. Only positive pool evidence
 * distinguishes devices; older pool fakes without the evidence seam report possible aliases.
 */
export function androidTransportCouldAliasHeldDevice(
  pool: FrameDeviceIdentityPool | undefined,
  transport: BootedDevice,
  heldDeviceId?: string,
): boolean {
  return pool?.androidTransportMayAliasDevice?.(transport, heldDeviceId) !== false;
}

export interface FrameHeldSession {
  sessionId: string;
  assignedDevice: string;
  stableDeviceId?: string;
  platform: string;
}

/** The reverse-map holders, including expired/releasing sessions; older fakes use live sessions. */
export function frameHeldSessionsFrom(sessionManager: {
  getHeldDeviceSessions?: () => readonly {
    deviceId: string;
    sessionId: string;
    stableDeviceId?: string;
    platform: string;
  }[];
  getAllSessions?: () => readonly FrameHeldSession[];
}): readonly FrameHeldSession[] {
  return sessionManager.getHeldDeviceSessions
    ? sessionManager.getHeldDeviceSessions().map(({ deviceId, ...session }) => ({
        ...session,
        assignedDevice: deviceId,
      }))
    : (sessionManager.getAllSessions?.() ?? []);
}

/**
 * The one definition of could-alias-a-held-device, shared by direct frames and MCP calls. Sessions
 * represent the device reverse-map holders, including expired and releasing sessions until
 * ownership is removed; unrepresented managed holds share one unknown identity, read through
 * the same one-second snapshot as the input broker binding gate.
 */
export async function aliasableHeldAndroidDevices(
  pool: FrameDeviceIdentityPool | undefined,
  device: BootedDevice,
  sessions: readonly FrameHeldSession[],
) {
  const androidSessions = sessions.filter((session) => session.platform === "android");
  const managed = await pool?.androidBindingHold?.(
    androidSessions.flatMap((session) =>
      session.stableDeviceId
        ? [session.assignedDevice, session.stableDeviceId]
        : [session.assignedDevice],
    ),
  );
  return {
    sessions: androidSessions.filter((session) =>
      androidTransportCouldAliasHeldDevice(pool, device, session.assignedDevice),
    ),
    managed: managed && androidTransportCouldAliasHeldDevice(pool, device) ? managed : undefined,
  };
}

/** Non-throwing identity verdict shared by control gates and sessionless read routing (#11596). */
export async function heldDevicesUnidentifiedTransportCouldAlias(
  pool: FrameDeviceIdentityPool | undefined,
  device: BootedDevice,
  heldBySession: boolean,
  sessions: readonly FrameHeldSession[],
) {
  if (
    heldBySession ||
    device.platform !== "android" ||
    pool?.isAndroidTransportAssignable?.(device) !== false
  ) {
    return undefined;
  }
  const held = await aliasableHeldAndroidDevices(pool, device, sessions);
  return held.sessions.length > 0 || held.managed ? held : undefined;
}

/** Unidentifiable control is refused only while it could alias a held Android device (#11596). */
export async function assertFrameTargetIdentityProven(
  pool: FrameDeviceIdentityPool | undefined,
  device: BootedDevice,
  action: string,
  heldBySession: boolean,
  ownership: {
    sessions: readonly FrameHeldSession[];
    requesterSessionUuid?: string;
    /** Input's existing autolock fallback is resolved only if a held device needs it. */
    requester?: () => string | undefined;
    sessionManager?: ToolSelectionSessionManager;
  },
): Promise<void> {
  const held = await heldDevicesUnidentifiedTransportCouldAlias(
    pool,
    device,
    heldBySession,
    ownership.sessions,
  );
  if (!held) {
    return;
  }
  const { sessions: aliasable, managed } = held;
  const requesterSessionUuid = ownership.requester?.() ?? ownership.requesterSessionUuid;
  if (
    !managed &&
    aliasable.every((session) =>
      isSameHolderSession(session.sessionId, requesterSessionUuid, ownership.sessionManager),
    )
  ) {
    throw new ActionableError(
      `${action} refused: Android transport '${device.deviceId}' has no proven identity, so it ` +
        "cannot be told apart from a device another session holds; nothing was sent. The device " +
        "pool does not pool this transport either. Address the device by a transport whose serial " +
        "can be read (its USB serial or emulator-NNNN id), or reconnect it and refresh devices.",
    );
  }
  throw frameAliasOwnershipError(action, device.deviceId, requesterSessionUuid, managed);
}

function frameAliasOwnershipError(
  action: string,
  deviceId: string,
  requesterSessionUuid: string | undefined,
  managed: { entry?: ManagedDeviceEntry } | undefined,
): ActionableError {
  if (managed?.entry) {
    return new DeviceAssignedToBindingError(action, deviceId, managed.entry);
  }
  return new InputDeviceOwnedError(
    action,
    deviceId,
    requesterSessionUuid,
    "This transport cannot be told apart from a device another session holds; " +
      "address the device by its USB serial or emulator-NNNN id. Nothing was sent.",
  );
}

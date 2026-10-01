import type { BootedDevice } from "../models";
import { ActionableError } from "../models/ActionableError";
import { DaemonState } from "../daemon/daemonState";
import { getToolSelectionContext } from "../features/toolSelection/toolSelectionContext";
import { resolveToolSelectionBaseSessionUuid } from "../features/toolSelection/selectionSessionResolver";
import { listBootedDevicesForResource } from "./resourceDeviceResolver";

/** An owned device requires a binding to the caller's MCP connection. */
export function hasObservationReadAccess(
  ownerSessionUuid: string | undefined,
  callerSessionUuid: string | undefined,
  ownsSession: ((sessionUuid: string) => boolean) | undefined,
): boolean {
  return Boolean(
    !ownerSessionUuid ||
    (ownerSessionUuid === callerSessionUuid && ownsSession?.(ownerSessionUuid)),
  );
}

export interface DeviceObservationAccess {
  listBooted(signal: AbortSignal | undefined): Promise<BootedDevice[]>;
  isAuthorized(device: BootedDevice): boolean;
}

export const defaultDeviceObservationAccess: DeviceObservationAccess = {
  listBooted: (signal) =>
    listBootedDevicesForResource("either", "observe", { signal, requireFresh: true }),
  isAuthorized: (device) => {
    const daemon = DaemonState.getInstance();
    if (!daemon.isInitialized()) {
      return true;
    }
    const owner = daemon.getDevicePool().getDevice(device.deviceId)?.sessionId;
    const context = getToolSelectionContext();
    const caller = resolveToolSelectionBaseSessionUuid(
      context?.routingSessionUuid,
      daemon.getSessionManager(),
    );
    return hasObservationReadAccess(owner ?? undefined, caller, context?.ownsDeviceSession);
  },
};

/** Resolve a read-only target without session creation or device-pool ownership changes. */
export async function resolveDeviceForObservationRead(
  deviceId: string,
  signal: AbortSignal | undefined,
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
): Promise<BootedDevice> {
  const devices = await access.listBooted(signal);
  signal?.throwIfAborted();
  const matches = devices.filter(
    (device) => device.deviceId === deviceId || device.name === deviceId,
  );
  if (matches.length !== 1) {
    throw new ActionableError(
      `Expected one booted device for '${deviceId}'; found ${matches.length}.`,
    );
  }
  assertObservationReadAccess(matches[0], access);
  return matches[0];
}

export function assertObservationReadAccess(
  device: BootedDevice,
  access: DeviceObservationAccess = defaultDeviceObservationAccess,
): void {
  if (!access.isAuthorized(device)) {
    throw new ActionableError("Observation access denied.");
  }
}

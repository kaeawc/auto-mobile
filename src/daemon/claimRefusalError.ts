import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";

/**
 * The typed refusal for a claim {@link ForeignDeviceOwnership.claim} just refused. When the
 * host-wide table only could not decide it (#11811, fail closed) and no live owner is known, the
 * message says so instead of naming another daemon; otherwise it names the live owner, if known.
 */
export function claimRefusalError(
  ownership: Pick<ForeignDeviceOwnership, "claimDeferred" | "foreignOwnerPid"> | undefined,
  deviceId: string,
  remedy?: string,
): DeviceOwnedByOtherDaemonError {
  const ownerPid = ownership?.foreignOwnerPid(deviceId);
  // A live owner seen by another signal (a CtrlProxy forward lease) outranks the registry wording.
  if (ownerPid === undefined && ownership?.claimDeferred?.(deviceId) === true) {
    return DeviceOwnedByOtherDaemonError.registryUnusable(deviceId);
  }
  return new DeviceOwnedByOtherDaemonError(deviceId, ownerPid, remedy);
}

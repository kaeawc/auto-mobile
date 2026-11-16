import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import type { ForeignDeviceOwnership } from "./foreignDeviceOwnership";

/**
 * The typed refusal for a claim {@link ForeignDeviceOwnership.claim} just refused. When the
 * host-wide table only could not decide it (#11811, fail closed), the message says so instead of
 * naming another daemon; otherwise it names the live owner, if known.
 */
export function claimRefusalError(
  ownership: Pick<ForeignDeviceOwnership, "claimDeferred" | "foreignOwnerPid"> | undefined,
  deviceId: string,
  remedy?: string,
): DeviceOwnedByOtherDaemonError {
  if (ownership?.claimDeferred?.(deviceId) === true) {
    return DeviceOwnedByOtherDaemonError.registryUnusable(deviceId);
  }
  return new DeviceOwnedByOtherDaemonError(deviceId, ownership?.foreignOwnerPid(deviceId), remedy);
}

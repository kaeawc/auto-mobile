import { CtrlProxyForwardOwnershipUnreadableError } from "../models/CtrlProxyForwardOwnershipUnreadableError";
import { DeviceOwnedByOtherDaemonError } from "../models/deviceAcquisitionRefusals";
import type { ForeignCtrlProxyForwardVerdict } from "../models/ForeignCtrlProxyForwardEvidence";

/** Map a non-clean forward verdict to the refusal the caller throws. */
export function foreignForwardError(
  deviceId: string,
  finding: Exclude<ForeignCtrlProxyForwardVerdict, { kind: "none" }>,
): Error {
  const ports = finding.ports.join(", ");
  if (finding.kind === "foreign") {
    return new DeviceOwnedByOtherDaemonError(
      deviceId,
      finding.clientPids[0],
      `CtrlProxy adb forward on port${finding.ports.length === 1 ? "" : "s"} ${ports} ` +
        `is owned by another process. ${finding.message}`,
    );
  }
  if (finding.ports.length === 0) {
    return new CtrlProxyForwardOwnershipUnreadableError(deviceId, finding.reason);
  }
  // finding.message already carries the probe failure and the removal remedy (#18985).
  return new DeviceOwnedByOtherDaemonError(
    deviceId,
    undefined,
    `CtrlProxy forward ownership could not be established: ${finding.message}`,
  );
}

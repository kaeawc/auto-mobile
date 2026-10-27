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
        `is owned by another process. ${finding.message} Stop the owning daemon or use ` +
        "another device.",
    );
  }
  if (finding.ports.length === 0) {
    return new CtrlProxyForwardOwnershipUnreadableError(deviceId, finding.reason);
  }
  const remedy = finding.ports
    .map((port) => `\`adb -s ${deviceId} forward --remove tcp:${port}\``)
    .join(", ");
  return new DeviceOwnedByOtherDaemonError(
    deviceId,
    undefined,
    `CtrlProxy forward ownership could not be established (${finding.reason}); ` +
      `${finding.message} If no other daemon uses this device, remove the stale forward with ` +
      `${remedy} and retry.`,
  );
}

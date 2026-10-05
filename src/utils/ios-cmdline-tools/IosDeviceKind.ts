import { isIosPhysicalUdid, isIosSimulatorUdid } from "./iosDeviceType";

export type IosDeviceKind = "simulator" | "physical";

/** Read backend kind without constructing unrelated device transports. */
export function resolveIosDeviceKind(options: { deviceId: string }): IosDeviceKind {
  return isIosSimulatorUdid(options.deviceId) ? "simulator" : "physical";
}

/** Cold launch checks need a known listing kind; unknown IDs must skip the check. */
export function resolveIosColdAppCheckKind(options: {
  deviceId: string;
}): IosDeviceKind | undefined {
  if (resolveIosDeviceKind(options) === "simulator") {
    return "simulator";
  }
  // Match app-list routing: only positively physical UDIDs use the physical lister.
  return isIosPhysicalUdid(options.deviceId) ? "physical" : undefined;
}

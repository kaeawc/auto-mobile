import { isIosSimulatorUdid } from "./iosDeviceType";

export type IosDeviceKind = "simulator" | "physical";

/** Read backend kind without constructing unrelated device transports. */
export function resolveIosDeviceKind(options: { deviceId: string }): IosDeviceKind {
  return isIosSimulatorUdid(options.deviceId) ? "simulator" : "physical";
}

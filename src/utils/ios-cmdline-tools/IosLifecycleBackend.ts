import { type BootedDevice, type DeviceInfo } from "../../models";
import { isIosPhysicalUdid } from "./iosDeviceType";
import type { SimCtlClient } from "./SimCtlClient";
import { PhysicalIosLifecycleBackend } from "./PhysicalIosLifecycleBackend";
export { PhysicalIosLifecycleBackend } from "./PhysicalIosLifecycleBackend";

/**
 * Device lifecycle operations whose simulator path is simctl and whose
 * physical-device path has no remote equivalent (issue #8348). Only the two
 * operations `MultiPlatformDeviceManager` branches on today; grow it when a
 * second consumer needs more.
 */
export interface IosLifecycleBackend {
  readonly kind: "simulator" | "physical";
  shutdown(
    device: BootedDevice,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void>;
  /** `assumeBooted` is set on the cold-boot path, where `bootstatus -b` already ran. */
  waitForReady(
    device: DeviceInfo & { deviceId: string },
    timeoutMs: number,
    options: { assumeBooted: boolean },
  ): Promise<BootedDevice>;
}

export interface IosLifecycleBackendDeps {
  simctl: Pick<SimCtlClient, "killSimulator" | "waitForSimulatorReady">;
}

export class SimulatorIosLifecycleBackend implements IosLifecycleBackend {
  readonly kind = "simulator";

  constructor(private readonly simctl: IosLifecycleBackendDeps["simctl"]) {}

  async shutdown(
    device: BootedDevice,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<void> {
    await this.simctl.killSimulator(device, options);
  }

  async waitForReady(
    device: DeviceInfo & { deviceId: string },
    timeoutMs: number,
    options: { assumeBooted: boolean },
  ): Promise<BootedDevice> {
    return this.simctl.waitForSimulatorReady(device.deviceId, timeoutMs, options);
  }
}

/**
 * Only a positively physical UDID takes the physical path; every other ID
 * (simulator or unrecognized) keeps the existing simctl behaviour.
 */
export function resolveIosLifecycleBackend(
  deviceId: string | undefined,
  deps: IosLifecycleBackendDeps,
): IosLifecycleBackend {
  return deviceId && isIosPhysicalUdid(deviceId)
    ? new PhysicalIosLifecycleBackend()
    : new SimulatorIosLifecycleBackend(deps.simctl);
}

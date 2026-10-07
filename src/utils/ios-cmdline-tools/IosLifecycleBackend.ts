import { ActionableError, type BootedDevice, type DeviceInfo } from "../../models";
import { isIosPhysicalUdid } from "./iosDeviceType";
import type { SimCtlClient } from "./SimCtlClient";

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

export class PhysicalIosLifecycleBackend implements IosLifecycleBackend {
  readonly kind = "physical";

  async shutdown(device: BootedDevice): Promise<void> {
    // Physical devices are discoverable (issue #5620), so a kill request can
    // reach one. `simctl shutdown` cannot act on a physical UDID — it would
    // fail with an opaque CoreSimulator error — and there is no devicectl
    // equivalent of shutting a device down, so say so plainly.
    throw new ActionableError(
      `Cannot shut down physical iOS device ${device.deviceId}: only simulators have a ` +
        `remote shutdown path. Disconnect or power the device off manually.`,
    );
  }

  async waitForReady(device: DeviceInfo & { deviceId: string }): Promise<BootedDevice> {
    // A connected physical device has no simulator lifecycle: `simctl
    // bootstatus` cannot answer for its UDID, and discovery already proved it
    // reachable. Treat successful discovery as readiness (issue #5620).
    return {
      name: device.name,
      platform: "ios",
      deviceId: device.deviceId,
      ...(device.iosVersion ? { iosVersion: device.iosVersion } : {}),
      ...(device.osVersion ? { osVersion: device.osVersion } : {}),
      ...(device.formFactor ? { formFactor: device.formFactor } : {}),
    };
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

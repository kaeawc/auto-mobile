import { ActionableError, type BootedDevice, type DeviceInfo } from "../../models";
import type { IosLifecycleBackend } from "./IosLifecycleBackend";

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

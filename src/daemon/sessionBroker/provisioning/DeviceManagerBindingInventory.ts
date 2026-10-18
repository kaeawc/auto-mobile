import { AndroidEmulatorUnavailableError } from "../../../utils/android-cmdline-tools/AndroidEmulatorClient";
import { SimctlUnavailableError } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import type { PlatformDeviceManager } from "../../../devices/deviceUtils";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { type BindingInventory, type BindingInventorySnapshot } from "./reconciler";
import type { BindingPlatform } from "../registry/bindingRegistry";

/** Configured devices (AVDs, simulators) of one platform; a failed listing is incomplete. */
export class DeviceManagerBindingInventory implements BindingInventory {
  constructor(private readonly deviceManager: Pick<PlatformDeviceManager, "listDeviceImages">) {}

  async list(
    platform: BindingPlatform,
    options: { signal?: AbortSignal },
  ): Promise<BindingInventorySnapshot> {
    try {
      const devices = await this.deviceManager.listDeviceImages(platform, options.signal);
      return { complete: true, devices };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (
        (platform === "android" && error instanceof AndroidEmulatorUnavailableError) ||
        (platform === "ios" && error instanceof SimctlUnavailableError)
      ) {
        // An optional platform's lister is expected to be absent on single-platform hosts.
        logger.debug(`[Bindings] ${platform} toolchain not installed: ${errorMessage(error)}`);
        return { complete: false, devices: [], toolchain: "not_installed" };
      }
      // Incomplete discovery is never authoritative absence; the reconciler refuses to act on it.
      logger.warn(`[Bindings] ${platform} device inventory failed: ${errorMessage(error)}`, error);
      return { complete: false, devices: [] };
    }
  }
}

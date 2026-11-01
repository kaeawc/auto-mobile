import type { DeviceInfo } from "../../../models/index";
import { isAndroidEmulatorSerial } from "../../../utils/androidSerial";
import { AndroidEmulatorUnavailableError } from "../../../utils/android-cmdline-tools/AndroidEmulatorClient";
import { SimctlUnavailableError } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import type { WatchSimulatorInventory } from "../../../utils/ios-cmdline-tools/WatchSimulatorInventory";
import type { PlatformDeviceManager } from "../../../devices/deviceUtils";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { type BindingInventory, type BindingInventorySnapshot } from "./reconciler";
import type { BindingPlatform } from "../registry/bindingRegistry";

/** The Apple Watch simulator listing; the iOS simulator listing never includes watches. */
export type WatchBindingInventorySource = Pick<WatchSimulatorInventory, "listWatchSimulators">;

/** Configured devices (AVDs, simulators) of one platform; a failed listing is incomplete. */
export class DeviceManagerBindingInventory implements BindingInventory {
  /**
   * `watches` is the host's watch listing. It is absent where simulators cannot exist (not
   * macOS), and watchos then reports its toolchain as not installed.
   */
  constructor(
    private readonly deviceManager: Pick<PlatformDeviceManager, "listDeviceImages"> &
      Partial<Pick<PlatformDeviceManager, "getBootedDevicesDetailed">>,
    private readonly watches?: WatchBindingInventorySource,
  ) {}

  private async listImages(platform: BindingPlatform, signal?: AbortSignal): Promise<DeviceInfo[]> {
    if (platform !== "watchos") {
      return await this.deviceManager.listDeviceImages(platform, signal);
    }
    if (!this.watches) {
      throw new SimctlUnavailableError("Apple Watch simulators are listed only on macOS hosts.");
    }
    return await this.watches.listWatchSimulators(signal);
  }

  async runtimeDeviceId(
    device: DeviceInfo,
    options: { signal?: AbortSignal },
  ): Promise<string | undefined> {
    return device.deviceId ?? this.bootedRuntimeId(device, options, "replacement runtime");
  }

  async probeRunning(device: DeviceInfo, options: { signal?: AbortSignal }): Promise<boolean> {
    // A listing's own deviceId is not live evidence; only a fresh booted listing proves running.
    return (await this.bootedRuntimeId(device, options, "running state")) !== undefined;
  }

  /** The adb serial of the booted emulator running this image, from a fresh complete listing. */
  private async bootedRuntimeId(
    device: DeviceInfo,
    options: { signal?: AbortSignal },
    purpose: string,
  ): Promise<string | undefined> {
    try {
      const discovery = await this.deviceManager.getBootedDevicesDetailed?.(device.platform, {
        signal: options.signal,
        bypassAndroidDeviceListCache: true,
        skipForeignEnrichment: true,
      });
      options.signal?.throwIfAborted();
      if (!discovery?.succeededPlatforms.has(device.platform)) {
        return undefined;
      }
      return discovery.devices.find(
        (runtime) =>
          !runtime.foreignOwned &&
          runtime.platform === device.platform &&
          runtime.name === device.name &&
          isAndroidEmulatorSerial(runtime.deviceId),
      )?.deviceId;
    } catch (error) {
      options.signal?.throwIfAborted();
      // Unknown identity earns no freed-slot credit; reservation still requires proven capacity.
      logger.warn(`[Bindings] cannot resolve ${purpose}: ${errorMessage(error)}`, error);
      return undefined;
    }
  }

  async list(
    platform: BindingPlatform,
    options: { signal?: AbortSignal },
  ): Promise<BindingInventorySnapshot> {
    try {
      const devices = await this.listImages(platform, options.signal);
      return { complete: true, devices };
    } catch (error) {
      options.signal?.throwIfAborted();
      if (
        (platform === "android" && error instanceof AndroidEmulatorUnavailableError) ||
        (platform !== "android" && error instanceof SimctlUnavailableError)
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

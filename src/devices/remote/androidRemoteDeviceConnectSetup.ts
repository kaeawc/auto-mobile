/**
 * {@link RemoteDeviceConnectSetup} for Android remote devices (#14468). The adb serial of a remote
 * device (a loopback port) can be reused by a later session on a different device, so every
 * connect drops serial-scoped CtrlProxy state and reads traits with a fresh, uncached reader.
 */
import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice } from "../../models";
import type { ProxySetupResult } from "../../utils/interfaces/ProxyManager";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import {
  AndroidDeviceTraitsReader,
  type DeviceTraits,
} from "../../utils/android-cmdline-tools/deviceTraits";
import { defaultTimer } from "../../utils/SystemTimer";
import type { RemoteDeviceConnectSetup, RemoteDeviceIdentity } from "./remoteDeviceAcquisition";

const TRAITS_TIMEOUT_MS = 10_000;

/**
 * CtrlProxy installation for a remote serial. The composition root that wires remote acquisition
 * builds it from `AndroidCtrlProxyManager` (`invalidateForDeviceIncarnation`, then a forced
 * `setup`), so this module does not resolve the manager singleton itself (#11806).
 */
export interface RemoteCtrlProxyInstaller {
  /** Forgets everything cached for `serial`, which now names a different device. */
  forgetDevice(serial: string): void;
  /** Installs (forced) and enables CtrlProxy. */
  install(device: BootedDevice): Promise<ProxySetupResult>;
}

export interface AndroidRemoteDeviceConnectSetupDependencies {
  ctrlProxy: RemoteCtrlProxyInstaller;
  /** Called per read so no cached traits from an earlier device on the same serial are reused. */
  createTraitsReader: () => DeviceTraits;
  adbFactory: AdbClientFactory;
}

export class AndroidRemoteDeviceConnectSetup implements RemoteDeviceConnectSetup {
  private readonly deps: AndroidRemoteDeviceConnectSetupDependencies;

  constructor(
    deps: Pick<AndroidRemoteDeviceConnectSetupDependencies, "ctrlProxy"> &
      Partial<AndroidRemoteDeviceConnectSetupDependencies>,
  ) {
    this.deps = {
      ctrlProxy: deps.ctrlProxy,
      createTraitsReader:
        deps.createTraitsReader ?? (() => new AndroidDeviceTraitsReader(defaultTimer)),
      adbFactory: deps.adbFactory ?? defaultAdbClientFactory,
    };
  }

  async installCtrlProxy(serial: string): Promise<void> {
    this.deps.ctrlProxy.forgetDevice(serial);
    const result = await this.deps.ctrlProxy.install(remoteDevice(serial));
    if (!result.success) {
      throw new ActionableError(
        `CtrlProxy could not be installed on remote device ${serial}: ${result.error ?? result.message}`,
        { cause: result.cause },
      );
    }
  }

  async readIdentity(serial: string): Promise<RemoteDeviceIdentity> {
    const device = remoteDevice(serial);
    const traits = await this.deps
      .createTraitsReader()
      .read(this.deps.adbFactory.create(device), serial, { timeoutMs: TRAITS_TIMEOUT_MS });
    return { manufacturer: traits.manufacturer, brand: traits.brand, model: traits.model };
  }
}

function remoteDevice(serial: string): BootedDevice {
  return { name: serial, platform: "android", deviceId: serial };
}

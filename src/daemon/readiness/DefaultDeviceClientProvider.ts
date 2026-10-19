import { AndroidCtrlProxyManager, type CtrlProxyManager } from "../../ctrlProxy/CtrlProxyManager";
import { IOSCtrlProxyManager, type CtrlProxyIosManager } from "../../ctrlProxy/IOSCtrlProxyManager";
import type { BootedDevice } from "../../models";
import type { ObserveScreenCache } from "../../models/ObserveScreenCache";
import { AndroidEmulatorClient } from "../../utils/android-cmdline-tools/AndroidEmulatorClient";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import {
  getSharedDevicectlDeviceLister,
  type IosPhysicalDeviceLister,
} from "../../utils/ios-cmdline-tools/DevicectlDeviceLister";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { PlatformDeviceManager } from "../../utils/interfaces/DeviceUtils";
import type { DeviceClientProvider, DeviceClientSimctl } from "./DeviceReadiness";
import {
  compareIdentityEvidence,
  deriveEvidenceFromBootedDevice,
  type IdentityEvidence,
  isUnresolvedAndroidEmulatorName,
} from "../../devices/deviceIdentityEvidence";
import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";

type ClientWindow = ReturnType<DeviceClientProvider["getWindow"]>;
type ClientAndroidProxy = ReturnType<DeviceClientProvider["getAndroidCtrlProxyClient"]>;
type ClientIosProxy = ReturnType<DeviceClientProvider["getIOSCtrlProxyClient"]>;

/**
 * The observe-layer clients the provider hands out. Injected so the devices layer never
 * imports the observe layer; the composition root in DeviceReadiness supplies the real ones.
 */
export interface ObserveClientFactories {
  androidCtrlProxyClient: DeviceClientProvider["getAndroidCtrlProxyClient"];
  iosCtrlProxyClient: DeviceClientProvider["getIOSCtrlProxyClient"];
  createWindow(device: BootedDevice, adbFactory: AdbClientFactory): ClientWindow;
  observeScreenCache(): ObserveScreenCache;
}

/**
 * Default provider that lazily creates real clients
 */
export class DefaultDeviceClientProvider implements DeviceClientProvider {
  private _adb: AdbExecutor | undefined;
  private _adbFactory: AdbClientFactory;
  private _simctl: SimCtlClient | undefined;
  private _androidEmulator: AndroidEmulatorClient | undefined;
  private _deviceUtils: PlatformDeviceManager | undefined;
  // Keyed by serial plus the most recent resolved runtime identity. An
  // unresolved/raw-serial listing cannot evict a known-good client, while a
  // different resolved AVD name must not retain clients bound to its predecessor.
  private readonly _windows: Map<string, { window: ClientWindow; evidence: IdentityEvidence }> =
    new Map();

  constructor(
    private readonly observeClients: ObserveClientFactories,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
  ) {
    this._adbFactory = adbFactory;
  }

  getAdb(): AdbExecutor {
    if (!this._adb) {
      this._adb = this._adbFactory.create(null);
    }
    return this._adb;
  }

  getSimctl(): DeviceClientSimctl | undefined {
    if (!this._simctl) {
      this._simctl = new SimCtlClient(null);
    }
    return this._simctl;
  }

  getAndroidEmulator(): AndroidEmulatorClient | undefined {
    if (!this._androidEmulator) {
      this._androidEmulator = new AndroidEmulatorClient();
    }
    return this._androidEmulator;
  }

  getDeviceUtils(): PlatformDeviceManager {
    if (!this._deviceUtils) {
      this._deviceUtils = new MultiPlatformDeviceManager(
        this.getAdb(),
        this.getSimctl()!,
        this.getAndroidEmulator()!,
      );
    }
    return this._deviceUtils;
  }

  getIosPhysicalDeviceLister(): IosPhysicalDeviceLister {
    // Shared with every MultiPlatformDeviceManager so readiness scans reuse the
    // devicectl cache and last-good retention instead of spawning their own.
    return getSharedDevicectlDeviceLister();
  }

  getAndroidCtrlProxyManager(device: BootedDevice): CtrlProxyManager {
    return AndroidCtrlProxyManager.getInstance(device);
  }

  getAndroidCtrlProxyClient(device: BootedDevice): ClientAndroidProxy {
    return this.observeClients.androidCtrlProxyClient(device);
  }

  getIOSCtrlProxyManager(device: BootedDevice): CtrlProxyIosManager {
    return IOSCtrlProxyManager.getInstance(device);
  }

  getIOSCtrlProxyClient(device: BootedDevice, port: number): ClientIosProxy {
    return this.observeClients.iosCtrlProxyClient(device, port);
  }

  getWindow(device: BootedDevice): ClientWindow {
    const key = device.deviceId;
    const incoming = deriveEvidenceFromBootedDevice(
      device,
      isUnresolvedAndroidEmulatorName(device),
    );
    const cached = this._windows.get(key);
    if (!cached) {
      return this.cacheWindow(key, device, incoming);
    }
    // Raw-serial evidence cannot name an AVD, so it never replaces (or
    // re-stamps) a cached Window.
    if (incoming.unresolved) {
      return cached.window;
    }
    const comparison = compareIdentityEvidence(cached.evidence, incoming);
    if (incoming.stableId === cached.evidence.stableId) {
      if (comparison === "newer") {
        cached.evidence = incoming;
      }
      return cached.window;
    }
    // Overlapping readiness calls for two AVDs on a reused serial complete out
    // of order: an older resolved observation must not evict the Window the
    // newer AVD already cached (#7031). Unstamped observations stay
    // permissive, matching the pool.
    if (comparison !== "newer") {
      return cached.window;
    }
    return this.cacheWindow(key, device, incoming);
  }

  private cacheWindow(key: string, device: BootedDevice, evidence: IdentityEvidence): ClientWindow {
    const window = this.observeClients.createWindow(device, this._adbFactory);
    this._windows.set(key, { window, evidence });
    return window;
  }

  getObserveScreenCache(): ObserveScreenCache {
    return this.observeClients.observeScreenCache();
  }
}

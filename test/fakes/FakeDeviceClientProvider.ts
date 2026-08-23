import { DeviceClientProvider } from "../../src/utils/DeviceSessionManager";
import { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { PlatformDeviceManager } from "../../src/utils/interfaces/DeviceUtils";
import { CtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { CtrlProxyIosManager } from "../../src/utils/IOSCtrlProxyManager";
import type { AndroidCtrlProxy } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import type { IOSCtrlProxy } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import type { Window } from "../../src/features/observe/interfaces/Window";
import type { ObserveScreenCache } from "../../src/features/observe/interfaces/ObserveScreenCache";
import { FakeObserveScreenCache } from "./FakeObserveScreenCache";
import { BootedDevice } from "../../src/models";

export interface FakeDeviceClientProviderOptions {
  ctrlProxyManager?: CtrlProxyManager;
  ctrlProxyClient?: AndroidCtrlProxy;
  iosCtrlProxyManager?: CtrlProxyIosManager;
  iosCtrlProxyClient?: IOSCtrlProxy;
  window?: Window;
  observeScreenCache?: ObserveScreenCache;
}

/**
 * Fakes default to throw-on-use: tests that exercise a code path requiring
 * a CtrlProxy must pass an explicit fake. This prevents silent fall-through
 * to a real singleton when a fake is forgotten.
 */
export class FakeDeviceClientProvider implements DeviceClientProvider {
  private vendedObserveScreenCache: ObserveScreenCache | undefined;

  constructor(
    private readonly fakeAdb: AdbExecutor,
    private readonly fakeDeviceUtils: PlatformDeviceManager,
    private readonly fakeSimctl?: SimCtlClient,
    private readonly options: FakeDeviceClientProviderOptions = {},
  ) {}

  private require<T>(value: T | undefined, fieldName: string): T {
    if (!value) {
      throw new Error(
        `FakeDeviceClientProvider: ${fieldName} fake not configured. ` +
          `Pass it via constructor options.`,
      );
    }
    return value;
  }

  getAdb(): AdbExecutor {
    return this.fakeAdb;
  }

  getSimctl(): SimCtlClient | undefined {
    return this.fakeSimctl;
  }

  getAndroidEmulator(): AndroidEmulatorClient | undefined {
    return undefined;
  }

  getDeviceUtils(): PlatformDeviceManager {
    return this.fakeDeviceUtils;
  }

  getAndroidCtrlProxyManager(_device: BootedDevice): CtrlProxyManager {
    return this.require(this.options.ctrlProxyManager, "ctrlProxyManager");
  }

  getAndroidCtrlProxyClient(_device: BootedDevice): AndroidCtrlProxy {
    return this.require(this.options.ctrlProxyClient, "ctrlProxyClient");
  }

  getIOSCtrlProxyManager(_device: BootedDevice): CtrlProxyIosManager {
    return this.require(this.options.iosCtrlProxyManager, "iosCtrlProxyManager");
  }

  getIOSCtrlProxyClient(_device: BootedDevice, _port: number): IOSCtrlProxy {
    return this.require(this.options.iosCtrlProxyClient, "iosCtrlProxyClient");
  }

  getWindow(_device: BootedDevice): Window {
    return this.require(this.options.window, "window");
  }

  getObserveScreenCache(): ObserveScreenCache {
    // Cache is a sink — default to a recording fake so tests that don't care
    // about invalidation don't have to wire one; tests that DO care pass their
    // own to assert which deviceIds were cleared.
    if (this.options.observeScreenCache) {
      return this.options.observeScreenCache;
    }
    if (!this.vendedObserveScreenCache) {
      this.vendedObserveScreenCache = new FakeObserveScreenCache();
    }
    return this.vendedObserveScreenCache;
  }
}

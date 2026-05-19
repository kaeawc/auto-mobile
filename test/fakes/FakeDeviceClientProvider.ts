import { DeviceClientProvider } from "../../src/utils/DeviceSessionManager";
import { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { PlatformDeviceManager } from "../../src/utils/interfaces/DeviceUtils";
import { CtrlProxyManager } from "../../src/utils/CtrlProxyManager";
import { CtrlProxyIosManager } from "../../src/utils/IOSCtrlProxyManager";
import type { AndroidCtrlProxy } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import type { IOSCtrlProxy } from "../../src/features/observe/ios/IOSCtrlProxyClient";
import { BootedDevice } from "../../src/models";

export interface FakeDeviceClientProviderOptions {
  ctrlProxyManager?: CtrlProxyManager;
  ctrlProxyClient?: AndroidCtrlProxy;
  iosCtrlProxyManager?: CtrlProxyIosManager;
  iosCtrlProxyClient?: IOSCtrlProxy;
}

/**
 * Fake provider for testing - returns injected fakes instead of real clients.
 *
 * CtrlProxy fakes default to throw-on-use so a test that exercises a code
 * path requiring them must pass an explicit fake. This catches accidental
 * fall-throughs to real singletons in tests.
 */
export class FakeDeviceClientProvider implements DeviceClientProvider {
  private readonly options: FakeDeviceClientProviderOptions;

  constructor(
    private readonly fakeAdb: AdbExecutor,
    private readonly fakeDeviceUtils: PlatformDeviceManager,
    private readonly fakeSimctl?: SimCtlClient,
    options: FakeDeviceClientProviderOptions = {}
  ) {
    this.options = options;
  }

  setCtrlProxyManager(manager: CtrlProxyManager): void {
    this.options.ctrlProxyManager = manager;
  }

  setCtrlProxyClient(client: AndroidCtrlProxy): void {
    this.options.ctrlProxyClient = client;
  }

  setIOSCtrlProxyManager(manager: CtrlProxyIosManager): void {
    this.options.iosCtrlProxyManager = manager;
  }

  setIOSCtrlProxyClient(client: IOSCtrlProxy): void {
    this.options.iosCtrlProxyClient = client;
  }

  getAdb(): AdbExecutor {
    return this.fakeAdb;
  }

  getSimctl(): SimCtlClient | undefined {
    return this.fakeSimctl;
  }

  getAndroidEmulator(): AndroidEmulatorClient | undefined {
    // Tests use fakeDeviceUtils instead
    return undefined;
  }

  getDeviceUtils(): PlatformDeviceManager {
    return this.fakeDeviceUtils;
  }

  getAndroidCtrlProxyManager(_device: BootedDevice): CtrlProxyManager {
    if (!this.options.ctrlProxyManager) {
      throw new Error(
        "FakeDeviceClientProvider: ctrlProxyManager fake not configured. " +
        "Pass it via constructor options or setCtrlProxyManager()."
      );
    }
    return this.options.ctrlProxyManager;
  }

  getAndroidCtrlProxyClient(_device: BootedDevice): AndroidCtrlProxy {
    if (!this.options.ctrlProxyClient) {
      throw new Error(
        "FakeDeviceClientProvider: ctrlProxyClient fake not configured. " +
        "Pass it via constructor options or setCtrlProxyClient()."
      );
    }
    return this.options.ctrlProxyClient;
  }

  getIOSCtrlProxyManager(_device: BootedDevice): CtrlProxyIosManager {
    if (!this.options.iosCtrlProxyManager) {
      throw new Error(
        "FakeDeviceClientProvider: iosCtrlProxyManager fake not configured. " +
        "Pass it via constructor options or setIOSCtrlProxyManager()."
      );
    }
    return this.options.iosCtrlProxyManager;
  }

  getIOSCtrlProxyClient(_device: BootedDevice, _port: number): IOSCtrlProxy {
    if (!this.options.iosCtrlProxyClient) {
      throw new Error(
        "FakeDeviceClientProvider: iosCtrlProxyClient fake not configured. " +
        "Pass it via constructor options or setIOSCtrlProxyClient()."
      );
    }
    return this.options.iosCtrlProxyClient;
  }
}

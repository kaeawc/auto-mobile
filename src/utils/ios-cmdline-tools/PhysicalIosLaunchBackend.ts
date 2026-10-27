import type {
  DeviceAppLauncher,
  IosLaunchBackend,
  LaunchOptions,
  LaunchResult,
} from "./IosDeviceBackend";

export class PhysicalIosLaunchBackend implements IosLaunchBackend {
  readonly kind = "physical";

  constructor(
    private readonly deviceId: string,
    private readonly deviceAppLauncher: DeviceAppLauncher,
  ) {}

  launchApp(bundleId: string, options?: LaunchOptions): Promise<LaunchResult> {
    return this.deviceAppLauncher.launchApp(this.deviceId, bundleId, {
      terminateExisting: true,
      ...(options?.launchArguments === undefined
        ? {}
        : { launchArguments: options.launchArguments }),
    });
  }
}

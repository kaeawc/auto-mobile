import type { DeviceAppTerminator, IosTerminateBackend, TerminateResult } from "./IosDeviceBackend";

export class PhysicalIosTerminateBackend implements IosTerminateBackend {
  readonly kind = "physical";

  readonly requiresInstalledAppCheck = false;

  constructor(
    private readonly deviceId: string,
    private readonly deviceAppTerminator: DeviceAppTerminator,
  ) {}

  terminateApp(bundleId: string): Promise<TerminateResult> {
    return this.deviceAppTerminator.terminateApp(this.deviceId, bundleId);
  }
}

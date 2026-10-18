import { DeviceAppManager } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";

/** DeviceAppManager that reports a fixed installed-app bundle hash without touching a device. */
export class FakeDeviceAppManager extends DeviceAppManager {
  constructor(private readonly installedBundleHash: string | null = null) {
    super();
  }

  override async getInstalledAppBundleHash(): Promise<string | null> {
    return this.installedBundleHash;
  }
}

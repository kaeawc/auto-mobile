import type {
  DevicectlDisplayInfo,
  DevicectlDisplayInfoSource,
} from "../../src/utils/ios-cmdline-tools/DevicectlDisplayInfo";

export class FakeDevicectlDisplayInfoSource implements DevicectlDisplayInfoSource {
  displays: DevicectlDisplayInfo[] = [];
  error?: Error;
  requests: Array<{ deviceId: string; signal?: AbortSignal }> = [];

  async readDisplays(request: {
    deviceId: string;
    signal?: AbortSignal;
  }): Promise<DevicectlDisplayInfo[]> {
    this.requests.push(request);
    if (this.error) {
      throw this.error;
    }
    return this.displays;
  }
}

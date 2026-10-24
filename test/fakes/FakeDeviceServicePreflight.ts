import type { BootedDevice } from "../../src/models";
import type { DeviceServiceDisabledError } from "../../src/models/DeviceServiceDisabledError";
import type { DeviceServicePreflight } from "../../src/utils/deviceServicePreflight";

export class FakeDeviceServicePreflight implements DeviceServicePreflight {
  readonly calls: Array<{ device: BootedDevice; tool: string; signal?: AbortSignal }> = [];
  error?: DeviceServiceDisabledError;
  async assertEnabled(device: BootedDevice, tool: string, signal?: AbortSignal): Promise<void> {
    this.calls.push({ device, tool, signal });
    if (this.error) {
      throw this.error;
    }
  }
}

import type { BootedDevice, DeviceInfo } from "../../src/models";
import type { DeviceMatchCriteria, MatchingStrategy } from "../../src/models/DeviceMatchCriteria";
import type { DeviceMatcher } from "../../src/server/deviceMatcher";

export class FakeDeviceMatcher implements DeviceMatcher {
  private bootedResult: BootedDevice | null = null;
  private imageResult: DeviceInfo | null = null;

  setBootedResult(device: BootedDevice | null): void {
    this.bootedResult = device;
  }

  setImageResult(image: DeviceInfo | null): void {
    this.imageResult = image;
  }

  matchBootedDevice(
    _criteria: DeviceMatchCriteria,
    _devices: BootedDevice[],
    _strategy: MatchingStrategy,
  ): BootedDevice | null {
    return this.bootedResult;
  }

  matchDeviceImage(
    _criteria: DeviceMatchCriteria,
    _images: DeviceInfo[],
    _strategy: MatchingStrategy,
  ): DeviceInfo | null {
    return this.imageResult;
  }
}

import type {
  DeviceResourceObserver,
  DeviceResourceObservationRequest,
} from "../../src/utils/deviceResourceObserver";
import type { AndroidDeviceResource } from "../../src/models/AndroidDeviceResource";
import type { AppleDeviceResource } from "../../src/models/AppleDeviceResource";

export class FakeDeviceResourceObserver implements DeviceResourceObserver {
  readonly requests: DeviceResourceObservationRequest[] = [];
  result: AndroidDeviceResource | AppleDeviceResource = {
    deviceId: "resource-test",
    platform: "ios",
    resources: {
      wallpaperRendering: { state: "enabled" },
      widgets: { state: "unknown", reason: "Not verified in this fake." },
      liveActivities: { state: "unknown", reason: "Not verified in this fake." },
      backgroundSync: { state: "unsupported", reason: "No approved read path." },
      searchIndexing: { state: "unknown", reason: "Not verified in this fake." },
      animations: { state: "unsupported", reason: "No approved read path." },
      icloudSync: { state: "unsupported", reason: "No approved read path." },
      photoAnalysis: { state: "unknown", reason: "Not verified in this fake." },
    },
  };
  onRequest?: (request: DeviceResourceObservationRequest) => Promise<void>;

  async observeResources(
    request: DeviceResourceObservationRequest,
  ): Promise<AndroidDeviceResource | AppleDeviceResource> {
    this.requests.push(request);
    await this.onRequest?.(request);
    return this.result;
  }
}

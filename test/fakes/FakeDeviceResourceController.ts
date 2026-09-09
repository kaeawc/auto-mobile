import type {
  DeviceResourceController,
  DeviceResourceRequest,
} from "../../src/utils/deviceResourceController";
import type { DeviceResourceConfigurationResult } from "../../src/models/DeviceResourceConfiguration";

export class FakeDeviceResourceController implements DeviceResourceController {
  readonly requests: DeviceResourceRequest[] = [];
  result: DeviceResourceConfigurationResult = {
    success: true,
    requested: { wallpaperRendering: "disabled" },
    resources: { wallpaperRendering: { state: "disabled" } },
    changed: ["wallpaperRendering"],
    verification: "current_boot",
  };
  onRequest?: (request: DeviceResourceRequest) => Promise<void>;

  async setResources(request: DeviceResourceRequest): Promise<DeviceResourceConfigurationResult> {
    this.requests.push(request);
    await this.onRequest?.(request);
    return { ...this.result, requested: request.resources };
  }
}

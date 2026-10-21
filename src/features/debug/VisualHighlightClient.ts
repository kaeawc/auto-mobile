import type { DeviceReadiness } from "../../daemon/readiness/DeviceReadiness";
import {
  ActionableError,
  BootedDevice,
  HighlightOperationResult,
  HighlightShape,
  Platform,
} from "../../models";
import { VisualHighlight } from "./VisualHighlight";

export interface HighlightOptions {
  deviceId?: string;
  platform: Platform;
  device?: BootedDevice;
  sessionUuid?: string;
  timeoutMs?: number;
}

type HighlightAdder = Pick<VisualHighlight, "addHighlight">;
type HighlightDeviceReadiness = Pick<DeviceReadiness, "ensureDeviceReady">;

export class VisualHighlightClient {
  private readonly deviceReadiness: HighlightDeviceReadiness | undefined;
  private readonly visualHighlightFactory: (device: BootedDevice) => HighlightAdder;

  constructor(
    deviceReadiness?: HighlightDeviceReadiness,
    visualHighlightFactory: (device: BootedDevice) => HighlightAdder = (device) =>
      new VisualHighlight(device),
  ) {
    this.deviceReadiness = deviceReadiness;
    this.visualHighlightFactory = visualHighlightFactory;
  }

  async addHighlight(
    id: string,
    shape: HighlightShape,
    options: HighlightOptions,
  ): Promise<HighlightOperationResult> {
    const highlight = await this.resolveHighlight(options);
    const result = await highlight.addHighlight(id, shape, { timeoutMs: options.timeoutMs });
    if (!result.success) {
      throw new ActionableError(result.error || "Failed to add highlight");
    }
    return result;
  }

  private async resolveHighlight(options: HighlightOptions): Promise<HighlightAdder> {
    if (options.device) {
      if (options.device.platform !== options.platform) {
        throw new ActionableError(
          `Highlight platform mismatch: requested ${options.platform}, device is ${options.device.platform}.`,
        );
      }
      return this.visualHighlightFactory(options.device);
    }

    if (options.platform !== "android" && options.platform !== "ios") {
      throw new ActionableError(
        `Visual highlights are not supported on ${options.platform} devices.`,
      );
    }
    if (!this.deviceReadiness) {
      throw new ActionableError(
        "Supply a resolved device or inject device readiness for visual highlights.",
      );
    }
    const device = await this.deviceReadiness.ensureDeviceReady(options.platform, options.deviceId);
    return this.visualHighlightFactory(device);
  }
}

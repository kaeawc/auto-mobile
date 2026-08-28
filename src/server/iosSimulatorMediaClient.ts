import type { BootedDevice } from "../models";
import type { SimCtl } from "../utils/ios-cmdline-tools/SimCtlClient";

/** Narrow seam for importing fixture media into an iOS Simulator Photos library. */
export interface IosSimulatorMediaClient {
  importMedia(device: BootedDevice, paths: string[], signal?: AbortSignal): Promise<void>;
}

export class SimctlIosSimulatorMediaClient implements IosSimulatorMediaClient {
  constructor(private readonly simctlFactory: (device: BootedDevice) => SimCtl) {}

  async importMedia(device: BootedDevice, paths: string[], signal?: AbortSignal): Promise<void> {
    await this.simctlFactory(device).executeCommandArgs(
      ["addmedia", device.deviceId, ...paths],
      undefined,
      signal,
    );
  }
}

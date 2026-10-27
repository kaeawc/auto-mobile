import { BootedDevice } from "../../models";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { TakeScreenshot } from "../observe/TakeScreenshot";
import type { ScreenshotCapturer } from "./SelectionStateTracker";

export class TakeScreenshotCapturer implements ScreenshotCapturer {
  private device: BootedDevice;
  private adbFactory: AdbClientFactory;

  constructor(device: BootedDevice, adbFactory: AdbClientFactory = defaultAdbClientFactory) {
    this.device = device;
    this.adbFactory = adbFactory;
  }

  async capture(signal?: AbortSignal): Promise<string | null> {
    const screenshot = new TakeScreenshot(this.device, { adbFactory: this.adbFactory });
    const result = await screenshot.execute({ format: "png" }, signal);
    if (!result.success || !result.path) {
      return null;
    }
    return result.path;
  }
}

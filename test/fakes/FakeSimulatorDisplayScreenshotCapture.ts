import type { SimulatorDisplayScreenshotCapture } from "../../src/utils/ios-cmdline-tools/DevicectlDisplayScreenshot";

export class FakeSimulatorDisplayScreenshotCapture implements SimulatorDisplayScreenshotCapture {
  calls: Array<Parameters<SimulatorDisplayScreenshotCapture["capture"]>[0]> = [];
  result = Buffer.alloc(0);
  failure?: Error;

  async capture(
    options: Parameters<SimulatorDisplayScreenshotCapture["capture"]>[0],
  ): Promise<Buffer> {
    this.calls.push({ ...options });
    if (this.failure) {
      throw this.failure;
    }
    return this.result;
  }
}

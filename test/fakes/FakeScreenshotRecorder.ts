import type { ObserveScreenshotRecorder } from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";

export class FakeScreenshotRecorder implements ObserveScreenshotRecorder {
  startCalls = 0;
  captureCalls = 0;
  captureFreshCalls = 0;
  captureSettledCalls = 0;
  settledError?: Error;

  start(): void {
    this.startCalls++;
  }

  async capture(): Promise<void> {
    this.captureCalls++;
  }

  async captureFresh(): Promise<void> {
    this.captureFreshCalls++;
  }

  async captureSettled(): Promise<string> {
    this.captureSettledCalls++;
    if (this.settledError) {
      throw this.settledError;
    }
    return "/fake/settled.png";
  }
}

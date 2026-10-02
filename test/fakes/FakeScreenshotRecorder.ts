import type { ObserveScreenshotRecorder } from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import type { ScreenshotEncodingOptions } from "../../src/features/observe/screenshot/screenshotOptions";
import type { PerformanceTracker } from "../../src/utils/PerformanceTracker";

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

  async captureSettled(
    _observationId: string,
    _perf?: PerformanceTracker,
    _signal?: AbortSignal,
    _displayId?: number,
    _options?: ScreenshotEncodingOptions,
  ): Promise<string> {
    this.captureSettledCalls++;
    if (this.settledError) {
      throw this.settledError;
    }
    return "/fake/settled.png";
  }
}

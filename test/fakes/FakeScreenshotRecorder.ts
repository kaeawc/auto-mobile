import type {
  ObserveCaptureOptions,
  ObserveScreenshotRecorder,
} from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import type { ObserveScreenshotOptions } from "../../src/features/observe/screenshot/screenshotOptions";
import type { PerformanceTracker } from "../../src/utils/PerformanceTracker";

export class FakeScreenshotRecorder implements ObserveScreenshotRecorder {
  startCalls = 0;
  captureCalls = 0;
  captureFreshCalls = 0;
  captureSettledCalls = 0;
  settledError?: Error;
  /** Capture options passed to start/capture/captureFresh, in call order. */
  readonly captureOptions: (ObserveCaptureOptions | undefined)[] = [];
  /** Options passed to captureSettled, in call order. */
  readonly settledOptions: (ObserveScreenshotOptions | undefined)[] = [];

  start(
    _observationId: string,
    _perf?: PerformanceTracker,
    _signal?: AbortSignal,
    _displayId?: number,
    capture?: ObserveCaptureOptions,
  ): void {
    this.startCalls++;
    this.captureOptions.push(capture);
  }

  async capture(
    _observationId: string,
    _perf?: PerformanceTracker,
    _signal?: AbortSignal,
    _displayId?: number,
    capture?: ObserveCaptureOptions,
  ): Promise<void> {
    this.captureCalls++;
    this.captureOptions.push(capture);
  }

  async captureFresh(
    _observationId: string,
    _perf?: PerformanceTracker,
    _signal?: AbortSignal,
    _displayId?: number,
    capture?: ObserveCaptureOptions,
  ): Promise<void> {
    this.captureFreshCalls++;
    this.captureOptions.push(capture);
  }

  async captureSettled(
    _observationId: string,
    _perf?: PerformanceTracker,
    _signal?: AbortSignal,
    _displayId?: number,
    options?: ObserveScreenshotOptions,
  ): Promise<string> {
    this.captureSettledCalls++;
    this.settledOptions.push(options);
    if (this.settledError) {
      throw this.settledError;
    }
    return "/fake/settled.png";
  }
}

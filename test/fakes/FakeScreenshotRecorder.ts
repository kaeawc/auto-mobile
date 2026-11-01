import type {
  ObserveCaptureOptions,
  ObserveScreenshotCaptureRequest,
  ObserveScreenshotRecorder,
  ObserveSettledScreenshotRequest,
} from "../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import type { ObserveScreenshotOptions } from "../../src/features/observe/screenshot/screenshotOptions";

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

  start(_observationId: string, { capture }: ObserveScreenshotCaptureRequest = {}): void {
    this.startCalls++;
    this.captureOptions.push(capture);
  }

  async capture(
    _observationId: string,
    { capture }: ObserveScreenshotCaptureRequest = {},
  ): Promise<void> {
    this.captureCalls++;
    this.captureOptions.push(capture);
  }

  async captureFresh(
    _observationId: string,
    { capture }: ObserveScreenshotCaptureRequest = {},
  ): Promise<void> {
    this.captureFreshCalls++;
    this.captureOptions.push(capture);
  }

  async captureSettled(
    _observationId: string,
    { options }: ObserveSettledScreenshotRequest = {},
  ): Promise<string> {
    this.captureSettledCalls++;
    this.settledOptions.push(options);
    if (this.settledError) {
      throw this.settledError;
    }
    return "/fake/settled.png";
  }
}

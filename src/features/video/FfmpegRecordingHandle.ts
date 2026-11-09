import type { ProcessTracker } from "../../utils/ChildProcessTracker";
import type { VideoCaptureConfig, VideoCaptureTeardownDescriptor } from "./VideoRecorderService";
export interface FfmpegBackendHandle {
  kind: "ffmpeg";
  platform: "android" | "ios";
  captureTracker: ProcessTracker;
  ffmpegTracker?: ProcessTracker;
  capturePath?: string;
  /** The simctl arguments the iOS capture ran with, including any `--display`. */
  captureArgs?: string[];
  captureTeardown?: VideoCaptureTeardownDescriptor;
  config: VideoCaptureConfig;
}

import { NoFirstFrameError } from "./NoFirstFrameError";
import { ScreenRecordingPermissionError } from "./ScreenRecordingPermissionError";

/** A legacy helper's "no frames" warning that may indicate Screen Recording was denied. */
export class ScreenRecordingPermissionHintError extends NoFirstFrameError {
  override finalStartupError(approvalTarget: string | null): Error {
    return new ScreenRecordingPermissionError(approvalTarget ?? "AutoMobile");
  }
}

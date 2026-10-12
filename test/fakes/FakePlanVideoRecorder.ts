import type { VideoRecorder } from "../../src/server/planExecutionOrchestrator";

/**
 * Plan-orchestrator video recorder that never reaches host tooling (`adb screenrecord`,
 * `ffmpeg`). Recording start is refused, which the orchestrator logs and swallows, so a plan
 * runs exactly as it does on a host without a recorder. `startCalls` lets a suite prove the
 * fake (not the default recorder) was the one consulted.
 */
export class FakePlanVideoRecorder implements VideoRecorder {
  startCalls = 0;

  startVideoRecording: VideoRecorder["startVideoRecording"] = async () => {
    this.startCalls += 1;
    throw new Error("video recording is disabled in this unit test");
  };

  stopVideoRecording: VideoRecorder["stopVideoRecording"] = async () => {
    throw new Error("video recording is disabled in this unit test");
  };
}

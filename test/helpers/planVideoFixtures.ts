import type { VideoRecordingConfig, VideoRecordingMetadata } from "../../src/models";
import type { VideoRecorder } from "../../src/server/planExecutionOrchestrator";

type StartResult = Awaited<ReturnType<VideoRecorder["startVideoRecording"]>>;
type StopResult = Awaited<ReturnType<VideoRecorder["stopVideoRecording"]>>;

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

export const PLAN_VIDEO_CONFIG: VideoRecordingConfig = {
  qualityPreset: "medium",
  targetBitrateKbps: 1000,
  maxThroughputMbps: 1,
  fps: 30,
  maxArchiveSizeMb: 100,
  format: "mp4",
};

/** A fully-typed `startVideoRecording` result for plan-orchestrator recorder fakes. */
export function activeVideoRecording(
  recordingId: string,
  outputPath = `/fake/${recordingId}.mp4`,
  outputName?: string,
): StartResult {
  return {
    recordingId,
    outputPath,
    fileName: `${recordingId}.mp4`,
    startedAt: EPOCH_ISO,
    config: PLAN_VIDEO_CONFIG,
    ...(outputName === undefined ? {} : { outputName }),
  };
}

/** A fully-typed `stopVideoRecording` result for plan-orchestrator recorder fakes. */
export function stoppedVideoRecording(recordingId: string, filePath: string): StopResult {
  const metadata: VideoRecordingMetadata = {
    recordingId,
    fileName: `${recordingId}.mp4`,
    filePath,
    format: "mp4",
    sizeBytes: 1,
    createdAt: EPOCH_ISO,
    startedAt: EPOCH_ISO,
    lastAccessedAt: EPOCH_ISO,
    config: PLAN_VIDEO_CONFIG,
  };
  return { metadata, evictedRecordingIds: [] };
}

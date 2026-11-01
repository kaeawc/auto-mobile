/**
 * Video recording module exports
 */

export { VideoCaptureFinalizationError, VideoRecorderService } from "./VideoRecorderService";
export type {
  ForceStopOptions,
  VideoCaptureBackend,
  StartVideoRecordingOptions,
  ActiveVideoRecording,
} from "./VideoRecorderService";
export { DEFAULT_VIDEO_RECORDING_CONFIG, parseVideoRecordingConfig } from "./VideoRecorderService";
export { HybridVideoCaptureBackend } from "./HybridVideoCaptureBackend";
export { createRecordingCaptureBackend } from "./defaultAudioTrackDependencies";

import type { VideoRecordingConfig, VideoRecordingConfigInput } from "../models";
import type {
  ConfigSocketMethod,
  ConfigSocketRequest,
  ConfigSocketResponse,
} from "./socketServer/index";

export type VideoRecordingSocketMethod = ConfigSocketMethod;

export type VideoRecordingSocketRequest = ConfigSocketRequest<
  "video_recording_request",
  VideoRecordingConfigInput
>;

export type VideoRecordingSocketResponse = ConfigSocketResponse<
  "video_recording_response",
  VideoRecordingConfig,
  "evictedRecordingIds"
>;

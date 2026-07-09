import type { VideoRecordingConfig, VideoRecordingConfigInput } from "../models";
import type {
  ConfigSocketMethod,
  ConfigSocketRequest,
  ConfigSocketResponse,
} from "./socketServer/index";

export type VideoRecordingSocketMethod = ConfigSocketMethod;

export interface VideoRecordingSocketRequest extends ConfigSocketRequest<
  "video_recording_request",
  VideoRecordingConfigInput
> {}

export interface VideoRecordingSocketResponse extends ConfigSocketResponse<
  "video_recording_response",
  VideoRecordingConfig,
  "evictedRecordingIds"
> {}

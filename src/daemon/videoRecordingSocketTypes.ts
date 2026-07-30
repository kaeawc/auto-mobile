import type { VideoRecordingConfig, VideoRecordingConfigInput } from "../models";
import type {
  ConfigSocketRequest,
  ConfigSocketResponse,
} from "./socketServer/index";

export interface VideoRecordingSocketRequest extends ConfigSocketRequest<
  "video_recording_request",
  VideoRecordingConfigInput
> {}

export interface VideoRecordingSocketResponse extends ConfigSocketResponse<
  "video_recording_response",
  VideoRecordingConfig,
  "evictedRecordingIds"
> {}

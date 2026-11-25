import type { VideoRecordingMetadata } from "../models/VideoRecording";
import { buildVideoArchiveItemUri } from "../daemon/videoRecordingResourceUris";

export const NO_ACTIVE_VIDEO_RECORDING = "No active video recording found for device.";

/**
 * A bare stop after the recording already ended (most often at `maxDuration`) names the
 * finished file instead of only saying nothing is recording (#19194).
 */
export function describeNoActiveVideoRecording(
  finished: Pick<VideoRecordingMetadata, "recordingId" | "filePath" | "endedAt"> | undefined,
): string {
  if (!finished) {
    return NO_ACTIVE_VIDEO_RECORDING;
  }
  const ended = finished.endedAt ? ` at ${finished.endedAt}` : "";
  return (
    `${NO_ACTIVE_VIDEO_RECORDING} The most recent recording on this device, ` +
    `${finished.recordingId}, already ended${ended} (a recording stops on its own when ` +
    `its maxDuration elapses). Its file is ${finished.filePath}; read it from ` +
    `${buildVideoArchiveItemUri(finished.recordingId)}.`
  );
}

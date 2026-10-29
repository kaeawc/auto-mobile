import type { VideoRecordingRecord } from "../db/videoRecordingRepository";
import type { VideoRecordingMetadata } from "../models";

/**
 * The metadata a stored row restores. It includes the stop's audio state and warnings (#15858), so
 * a recording finalized by its duration limit, a repeated stop or a read after a daemon restart
 * reports the same `hasAudioTrack` as the stop that produced it.
 */
export function toMetadata(record: VideoRecordingRecord): VideoRecordingMetadata {
  return {
    recordingId: record.recordingId,
    fileName: record.fileName,
    filePath: record.filePath,
    format: record.format,
    sizeBytes: record.sizeBytes,
    durationMs: record.durationMs,
    videoDurationMs: record.videoDurationMs,
    codec: record.codec,
    outputName: record.outputName,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    lastAccessedAt: record.lastAccessedAt,
    config: record.config,
    highlights: record.highlights,
    recordedPanel: record.recordedPanel,
    transitions: record.transitions,
    ...(record.warnings ? { warnings: record.warnings } : {}),
    ...(record.hasAudioTrack === undefined ? {} : { hasAudioTrack: record.hasAudioTrack }),
  };
}

/** The row update that marks a stopped recording completed with what its stop produced. */
export function completedRecordingUpdate(
  metadata: VideoRecordingMetadata,
  ownerSessionUuid: string | undefined,
): Partial<VideoRecordingRecord> {
  return {
    status: "completed",
    captureTeardown: undefined,
    ownerSessionUuid,
    outputName: metadata.outputName,
    fileName: metadata.fileName,
    filePath: metadata.filePath,
    format: metadata.format,
    sizeBytes: metadata.sizeBytes,
    durationMs: metadata.durationMs,
    codec: metadata.codec,
    endedAt: metadata.endedAt,
    lastAccessedAt: metadata.lastAccessedAt,
    config: metadata.config,
    highlights: metadata.highlights,
    recordedPanel: metadata.recordedPanel,
    transitions: metadata.transitions,
    warnings: metadata.warnings,
    hasAudioTrack: metadata.hasAudioTrack,
  };
}

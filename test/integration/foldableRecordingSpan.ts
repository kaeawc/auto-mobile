import type { VideoRecordingMetadata } from "../../src/models/VideoRecording";

// Allow 100ms for screenshot filesystem timestamps and recording finalization
// granularity; this is deliberately much smaller than the fold/unfold sequence.
export const RECORDING_SPAN_TOLERANCE_MS = 100;

export function assertRecordingSpansObservation(
  recording: Pick<VideoRecordingMetadata, "startedAt" | "durationMs">,
  observationEpochMs: number,
): void {
  const startedAtMs = Date.parse(recording.startedAt);
  if (!Number.isFinite(startedAtMs)) {
    throw new Error(`Invalid recording startedAt: ${recording.startedAt}`);
  }
  const durationMs = recording.durationMs;
  if (durationMs === undefined) {
    throw new Error(
      "Finalized recording is missing durationMs; cannot verify observation coverage",
    );
  }
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`Invalid recording durationMs: ${durationMs}`);
  }
  if (!Number.isFinite(observationEpochMs)) {
    throw new Error(`Invalid post-unfold observation epoch ms: ${observationEpochMs}`);
  }
  // Stop metadata uses backend duration, or max(0, endedAt - startedAt).
  // Segmented stops return this metadata per segment, not a session duration;
  // the lane requests 180s and asserts one recording. Do not substitute endedAt.
  const recordingEndEpochMs = startedAtMs + durationMs;
  if (recordingEndEpochMs + RECORDING_SPAN_TOLERANCE_MS < observationEpochMs) {
    throw new Error(
      `Recording end epoch ms ${recordingEndEpochMs} precedes post-unfold observation epoch ms ${observationEpochMs}; startedAt=${recording.startedAt}, durationMs=${durationMs}, toleranceMs=${RECORDING_SPAN_TOLERANCE_MS}`,
    );
  }
}

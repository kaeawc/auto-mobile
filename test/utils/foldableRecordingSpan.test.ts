import { describe, expect, test } from "bun:test";
import type { VideoRecordingMetadata } from "../../src/models/VideoRecording";
import {
  assertRecordingSpansObservation,
  RECORDING_SPAN_TOLERANCE_MS,
} from "../integration/foldableRecordingSpan";

// Minimal typed function inputs, not captured videoRecording tool payloads.
const recording: Pick<VideoRecordingMetadata, "startedAt" | "durationMs"> = {
  startedAt: "2026-10-01T00:00:00.000Z",
  durationMs: 5000,
};
const endEpochMs = Date.parse(recording.startedAt) + recording.durationMs!;

describe("foldable recording observation coverage", () => {
  test("covers the post-unfold observation", () => {
    expect(() => assertRecordingSpansObservation(recording, endEpochMs - 1)).not.toThrow();
  });

  test("early stop reports both timestamps and calculation inputs", () => {
    const observationEpochMs = endEpochMs + 2000;
    expect(() => assertRecordingSpansObservation(recording, observationEpochMs)).toThrow(
      `Recording end epoch ms ${endEpochMs} precedes post-unfold observation epoch ms ${observationEpochMs}; startedAt=${recording.startedAt}, durationMs=5000, toleranceMs=${RECORDING_SPAN_TOLERANCE_MS}`,
    );
  });

  test("passes exactly within tolerance", () => {
    expect(() =>
      assertRecordingSpansObservation(recording, endEpochMs + RECORDING_SPAN_TOLERANCE_MS),
    ).not.toThrow();
  });

  test("fails one millisecond outside tolerance", () => {
    expect(() =>
      assertRecordingSpansObservation(recording, endEpochMs + RECORDING_SPAN_TOLERANCE_MS + 1),
    ).toThrow("precedes post-unfold observation");
  });

  test("missing duration fails clearly", () => {
    expect(() =>
      assertRecordingSpansObservation({ startedAt: recording.startedAt }, endEpochMs),
    ).toThrow("missing durationMs");
  });

  test("invalid start time fails clearly", () => {
    expect(() =>
      assertRecordingSpansObservation({ startedAt: "invalid", durationMs: 5000 }, endEpochMs),
    ).toThrow("Invalid recording startedAt: invalid");
  });
});

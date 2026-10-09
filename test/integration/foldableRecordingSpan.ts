import type { VideoRecordingMetadata } from "../../src/models/VideoRecording";

// Allow 100ms for screenshot filesystem timestamps and recording finalization
// granularity; this is deliberately much smaller than the fold/unfold sequence.
export const RECORDING_SPAN_TOLERANCE_MS = 100;

// The container timeline starts at the first encoded frame, and screenrecord only
// emits frames on screen change: a display that stays static after the reopen adds
// no frames, so the container ends at the last change, not at stop or at any later
// host timestamp. The reopen itself changes the recorded panel, so the container must
// reach the host time the reopen was requested, less the encoder start latency
// (startedAt is taken before the display is resolved and `adb shell screenrecord`
// spawns). A stream frozen right after start (about 1s) must still fail over the
// multi-second fold/unfold sequence.
export const CONTAINER_DURATION_TOLERANCE_MS = 5000;

export interface CleanupFailure {
  name: string;
  error: unknown;
}

export async function runCleanupSteps(
  steps: Array<{ name: string; run: () => Promise<void> }>,
  log: (message: string) => void,
): Promise<CleanupFailure[]> {
  const failures: CleanupFailure[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      failures.push({ name: step.name, error });
      const detail = error instanceof Error ? error.message : String(error);
      try {
        log(`Cleanup step "${step.name}" failed: ${detail}`);
      } catch {
        // Logging must not prevent later cleanup steps from running.
      }
    }
  }
  return failures;
}

export function selectErrorToThrow(
  primary: { error: unknown } | undefined,
  failures: CleanupFailure[],
): unknown | undefined {
  return primary ? primary.error : failures[0]?.error;
}

export function ffprobeDurationArgs(filePath: string): string[] {
  return ["-v", "error", "-print_format", "json", "-show_entries", "format=duration", filePath];
}

export function parseFfprobeDurationMs(stdout: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Malformed ffprobe JSON: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || !("format" in parsed)) {
    throw new Error("ffprobe output is missing format.duration");
  }
  const format = parsed.format;
  if (typeof format !== "object" || format === null || !("duration" in format)) {
    throw new Error("ffprobe output is missing format.duration");
  }
  const duration = format.duration;
  if (typeof duration !== "string") {
    throw new Error(`Invalid ffprobe format.duration: ${String(duration)}`);
  }
  if (duration.trim() === "") {
    throw new Error(`Invalid ffprobe format.duration: ${duration}`);
  }
  const seconds = Number(duration);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid ffprobe format.duration: ${duration}`);
  }
  return Math.round(seconds * 1000);
}

/**
 * Asserts the encoded container reaches the reopen of the recorded panel.
 *
 * Anchor on the host time the reopen was requested, not on a later observation
 * timestamp: screenrecord encodes nothing while the reopened panel is static, and
 * an observe screenshot's capturedAt is its host-file mtime, written only after a
 * multi-second full-resolution capture transfer. Both put such a timestamp seconds
 * past the last encoded frame even when no footage was lost (run 37722361918).
 */
export function assertContainerDurationReachesReopen(
  containerDurationMs: number,
  recordingStartedAtMs: number,
  reopenRequestedAtMs: number,
): void {
  const inputs = `containerDurationMs=${containerDurationMs}, recordingStartedAtMs=${recordingStartedAtMs}, reopenRequestedAtMs=${reopenRequestedAtMs}`;
  if (
    !Number.isFinite(containerDurationMs) ||
    !Number.isFinite(recordingStartedAtMs) ||
    !Number.isFinite(reopenRequestedAtMs)
  ) {
    throw new Error(`Container duration assertion requires finite inputs: ${inputs}`);
  }
  const requiredSpanMs = reopenRequestedAtMs - recordingStartedAtMs;
  // Within the tolerance even an empty container would pass, so the check would be vacuous.
  if (requiredSpanMs <= CONTAINER_DURATION_TOLERANCE_MS) {
    throw new Error(
      `Reopen came too soon after the recording started to detect a frozen stream: requiredSpanMs=${requiredSpanMs}, toleranceMs=${CONTAINER_DURATION_TOLERANCE_MS}, ${inputs}`,
    );
  }
  if (containerDurationMs + CONTAINER_DURATION_TOLERANCE_MS < requiredSpanMs) {
    throw new Error(
      `Container duration does not reach the reopen: requiredSpanMs=${requiredSpanMs}, toleranceMs=${CONTAINER_DURATION_TOLERANCE_MS}, ${inputs}`,
    );
  }
}

export async function probeContainerDurationMs(
  runner: { run(args: string[]): Promise<string | undefined> },
  filePath: string,
): Promise<number | undefined> {
  const stdout = await runner.run(ffprobeDurationArgs(filePath));
  return stdout === undefined ? undefined : parseFfprobeDurationMs(stdout);
}

export async function awaitScreenSizeChange<
  T extends { screenSize: { width: number; height: number } },
>(options: {
  observe: () => Promise<T>;
  baseline: { width: number; height: number };
  attempts: number;
  delayMs: number;
  sleep: (ms: number) => Promise<void>;
}): Promise<T> {
  let lastSize = options.baseline;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    const observation = await options.observe();
    lastSize = observation.screenSize;
    if (lastSize.width !== options.baseline.width || lastSize.height !== options.baseline.height) {
      return observation;
    }
    // Sleep only between observations; there are attempts - 1 delays at most.
    if (attempt < options.attempts - 1) {
      await options.sleep(options.delayMs);
    }
  }
  throw new Error(
    `Screen size did not change from baseline ${JSON.stringify(options.baseline)}; last observed size ${JSON.stringify(lastSize)} after ${options.attempts} attempts`,
  );
}

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

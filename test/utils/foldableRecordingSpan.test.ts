import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { VideoRecordingMetadata } from "../../src/models/VideoRecording";
import {
  assertContainerDurationReachesReopen,
  assertRecordingSpansObservation,
  awaitScreenSizeChange,
  CONTAINER_DURATION_TOLERANCE_MS,
  ffprobeDurationArgs,
  parseFfprobeDurationMs,
  probeContainerDurationMs,
  RECORDING_SPAN_TOLERANCE_MS,
  runCleanupSteps,
  selectErrorToThrow,
} from "../integration/foldableRecordingSpan";

// Minimal typed function inputs, not captured videoRecording tool payloads.
const recording: Pick<VideoRecordingMetadata, "startedAt" | "durationMs"> = {
  startedAt: "2026-10-01T00:00:00.000Z",
  durationMs: 5000,
};
const endEpochMs = Date.parse(recording.startedAt) + recording.durationMs!;
const ffprobeFixture = readFileSync(
  new URL("../fixtures/ffprobe/format-duration.json", import.meta.url),
  "utf8",
);

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

describe("foldable cleanup error handling", () => {
  test("runs every cleanup step after failures and reports names", async () => {
    const ran: string[] = [];
    const logs: string[] = [];
    const failures = await runCleanupSteps(
      [
        {
          name: "stop",
          run: async () => {
            ran.push("stop");
            throw new Error("stop broke");
          },
        },
        {
          name: "copy",
          run: async () => {
            ran.push("copy");
            throw "copy broke";
          },
        },
        { name: "release", run: async () => void ran.push("release") },
      ],
      (message) => logs.push(message),
    );
    expect(ran).toEqual(["stop", "copy", "release"]);
    expect(failures.map(({ name }) => name)).toEqual(["stop", "copy"]);
    expect(logs).toEqual([
      'Cleanup step "stop" failed: stop broke',
      'Cleanup step "copy" failed: copy broke',
    ]);
  });

  test("primary error wins over cleanup failures", () => {
    const primary = new Error("body failed");
    const cleanup = new Error("cleanup failed");
    expect(selectErrorToThrow({ error: primary }, [{ name: "stop", error: cleanup }])).toBe(
      primary,
    );
  });

  test("first cleanup failure surfaces when there is no primary error", () => {
    const cleanup = new Error("cleanup failed");
    expect(() => {
      const error = selectErrorToThrow(undefined, [{ name: "stop", error: cleanup }]);
      if (error !== undefined) {
        throw error;
      }
    }).toThrow(cleanup);
  });

  test("all-clean cleanup selects no error", async () => {
    const failures = await runCleanupSteps([{ name: "release", run: async () => {} }], () => {});
    expect(failures).toEqual([]);
    expect(selectErrorToThrow(undefined, failures)).toBeUndefined();
  });
});

describe("ffprobe container duration", () => {
  test("parses the captured ffprobe duration fixture", () => {
    expect(parseFfprobeDurationMs(ffprobeFixture)).toBe(3000);
  });

  test("rejects malformed JSON", () => {
    expect(() => parseFfprobeDurationMs("{")).toThrow("Malformed ffprobe JSON");
  });

  test("rejects a missing duration", () => {
    expect(() => parseFfprobeDurationMs(JSON.stringify({ format: {} }))).toThrow(
      "missing format.duration",
    );
  });

  test("rejects non-numeric and negative durations", () => {
    expect(() => parseFfprobeDurationMs(JSON.stringify({ format: { duration: "nope" } }))).toThrow(
      "Invalid ffprobe format.duration",
    );
    expect(() => parseFfprobeDurationMs(JSON.stringify({ format: { duration: "-1" } }))).toThrow(
      "Invalid ffprobe format.duration",
    );
  });

  test("accepts exactly the container tolerance boundary", () => {
    expect(() => assertContainerDurationReachesReopen(7000, 0, 12000)).not.toThrow();
  });

  test("fails one millisecond beyond the container tolerance", () => {
    expect(() => assertContainerDurationReachesReopen(6999, 0, 12000)).toThrow(
      `toleranceMs=${CONTAINER_DURATION_TOLERANCE_MS}`,
    );
  });

  test("rejects a frozen stream across the fold and unfold", () => {
    expect(() => assertContainerDurationReachesReopen(1000, 1000, 13000)).toThrow(
      "requiredSpanMs=12000",
    );
  });

  test("accepts a container whose static tail ends before the post-reopen screenshot lands", () => {
    // Nightly run 37722361918: the reopen was requested 13.49s in, screenrecord encoded its
    // last change 18.18s in, and the settled screenshot's file landed 24.25s in after a 4.1s
    // full-resolution capture transfer. No footage was missing from the container.
    expect(() =>
      assertContainerDurationReachesReopen(18178, 1791430729307, 1791430742799),
    ).not.toThrow();
  });

  test("rejects a reopen inside the tolerance as unable to detect a frozen stream", () => {
    expect(() =>
      assertContainerDurationReachesReopen(0, 0, CONTAINER_DURATION_TOLERANCE_MS),
    ).toThrow("too soon");
  });

  test("validates all duration assertion inputs are finite", () => {
    expect(() => assertContainerDurationReachesReopen(Number.NaN, 0, 1)).toThrow("finite inputs");
    expect(() => assertContainerDurationReachesReopen(1, 0, Number.NaN)).toThrow("finite inputs");
  });

  test("probe returns undefined when ffprobe is absent", async () => {
    await expect(
      probeContainerDurationMs({ run: async () => undefined }, "recording.mp4"),
    ).resolves.toBe(undefined);
  });

  test("probe passes the exact ffprobe arguments to its runner", async () => {
    let received: string[] = [];
    const duration = await probeContainerDurationMs(
      {
        run: async (args) => {
          received = args;
          return ffprobeFixture;
        },
      },
      "recording.mp4",
    );
    expect(received).toEqual([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_entries",
      "format=duration",
      "recording.mp4",
    ]);
    expect(received).toEqual(ffprobeDurationArgs("recording.mp4"));
    expect(duration).toBe(3000);
  });
});

describe("Resizable posture screen size change polling", () => {
  test("returns immediately on a changed first observation", async () => {
    const delays: number[] = [];
    const changed = { screenSize: { width: 400, height: 800 } };
    const result = await awaitScreenSizeChange({
      observe: async () => changed,
      baseline: { width: 800, height: 400 },
      attempts: 3,
      delayMs: 500,
      sleep: async (ms) => void delays.push(ms),
    });
    expect(result).toBe(changed);
    expect(delays).toEqual([]);
  });

  test("sleeps between unchanged observations and returns a later change", async () => {
    const delays: number[] = [];
    const observations = [
      { screenSize: { width: 800, height: 400 } },
      { screenSize: { width: 800, height: 400 } },
      { screenSize: { width: 400, height: 800 } },
    ];
    const result = await awaitScreenSizeChange({
      observe: async () => observations.shift()!,
      baseline: { width: 800, height: 400 },
      attempts: 3,
      delayMs: 500,
      sleep: async (ms) => void delays.push(ms),
    });
    expect(result.screenSize).toEqual({ width: 400, height: 800 });
    expect(delays).toEqual([500, 500]);
  });

  test("exhaustion reports baseline, last size, attempts, and sleeps attempts minus one times", async () => {
    const delays: number[] = [];
    await expect(
      awaitScreenSizeChange({
        observe: async () => ({ screenSize: { width: 800, height: 400 } }),
        baseline: { width: 800, height: 400 },
        attempts: 3,
        delayMs: 500,
        sleep: async (ms) => void delays.push(ms),
      }),
    ).rejects.toThrow(
      'baseline {"width":800,"height":400}; last observed size {"width":800,"height":400} after 3 attempts',
    );
    expect(delays).toEqual([500, 500]);
  });
});

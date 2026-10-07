import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { runOutsideRequestContext, runWithAbortSignal } from "../../../src/utils/AbortContext";
import {
  boundPostProcessBudgetToRequest,
  ffmpegPostProcessBudgetMs,
  FFMPEG_UNATTENDED_REENCODE_MAX_BUDGET_MS,
  FfmpegVideoProcessingBackend,
  type ProcessTracker,
} from "../../../src/features/video/FfmpegVideoProcessingBackend";
import {
  VideoCaptureFinalizationError,
  type RecordingHandle,
  type RecordingResult,
  type VideoCaptureConfig,
} from "../../../src/features/video/VideoRecorderService";
import type { FfmpegClient } from "../../../src/utils/media/FfmpegClient";
import {
  ProcessTeardownUnconfirmedError,
  trackProcess,
} from "../../../src/utils/ChildProcessTracker";
import { EventEmitter } from "node:events";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { settleByFakeEvents } from "../../helpers/fakeTimerStepping";

// Issue #10188: the iOS post-process budget grows with the recording when it is a re-encode,
// and a post-process that still does not finish returns the unprocessed capture instead of
// failing the stop and deleting the recording.
const RAW_PATH = "/fake/recording/rec-raw.mov";
const OUTPUT_PATH = "/fake/recording/rec.mp4";
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

type EncoderBehavior =
  | { kind: "exits"; afterMs: number; code: number }
  | { kind: "ignores-signals" };

describe("FfmpegVideoProcessingBackend iOS post-process budget (#10188)", () => {
  let timer: FakeTimer;
  let removed: string[];
  let encoder: FakeChildProcess;
  let encoderKills: Array<NodeJS.Signals | number | undefined>;
  let encoderStarts: number;
  let realTimerSpies: Array<ReturnType<typeof spyOn>>;

  beforeEach(() => {
    // Fake time is stepped event by event (settleByFakeEvents), not auto-advanced: auto-advance
    // spends a real event-loop turn per event, and on a loaded runner those turns pushed a test
    // past bun's 5 s timeout (#10471).
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000_000);
    removed = [];
    encoderKills = [];
    encoderStarts = 0;
    realTimerSpies = [
      spyOn(globalThis, "setTimeout"),
      spyOn(globalThis, "setImmediate"),
      spyOn(globalThis, "setInterval"),
    ];
  });

  afterEach(() => {
    // Every wait in the stop path goes through the injected timer: no real timer is armed.
    const realTimerCalls = realTimerSpies.map((spy) => spy.mock.calls.length);
    for (const spy of realTimerSpies) {
      spy.mockRestore();
    }
    expect(realTimerCalls).toEqual([0, 0, 0]);
  });

  function config(overrides: Partial<VideoCaptureConfig> = {}): VideoCaptureConfig {
    return {
      recordingId: "rec",
      outputDirectory: "/fake/recording",
      outputPath: OUTPUT_PATH,
      fileName: "rec.mp4",
      startedAt: new Date(timer.now() - 30 * MINUTE_MS).toISOString(),
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 2048,
      format: "mp4",
      device: { platform: "ios", deviceId: "sim", name: "iPhone" },
      resolution: { width: 540, height: 1170 },
      ...overrides,
    };
  }

  /** A fake ffmpeg whose exit (or refusal to exit) is driven by the fake timer. */
  function startEncoder(behavior: EncoderBehavior): FfmpegClient {
    encoder = new FakeChildProcess(timer);
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      encoder.exitCode = code;
      encoder.signalCode = signal;
      encoder.emit("exit", code, signal);
    };
    return {
      binaryPath: "fake-ffmpeg",
      start: () => {
        encoderStarts++;
        let naturalExit: NodeJS.Timeout | undefined;
        if (behavior.kind === "exits") {
          naturalExit = timer.setTimeout(() => finish(behavior.code, null), behavior.afterMs);
        }
        encoder.kill = (signal) => {
          encoderKills.push(signal);
          if (behavior.kind === "ignores-signals") {
            return true;
          }
          encoder.killed = true;
          timer.clearTimeout(naturalExit as NodeJS.Timeout);
          timer.setTimeout(() => finish(null, signal as NodeJS.Signals), 0);
          return true;
        };
        return { process: encoder, tracker: trackProcess(encoder) };
      },
      probe: async () => ({ version: "7.1", encoders: [] }),
      run: async () => {
        throw new Error("unused");
      },
      pipe: () => {
        throw new Error("unused");
      },
    };
  }

  function captureTracker(recorderSignal: NodeJS.Signals | null = null): ProcessTracker {
    const process = new EventEmitter() as ProcessTracker["process"];
    process.stderr = new EventEmitter() as ProcessTracker["process"]["stderr"];
    process.exitCode = recorderSignal ? null : 0;
    process.signalCode = recorderSignal;
    process.killed = false;
    process.kill = () => true;
    return {
      process,
      exitState: recorderSignal ? { exitCode: null, signal: recorderSignal } : { exitCode: 0 },
      exitPromise: Promise.resolve(),
      stderr: [],
    };
  }

  interface StopOptions {
    /** What the container probe finds in the raw capture (undefined: no moov atom). */
    rawCodec?: string | undefined;
    /** How the simctl recorder ended: null is its own exit after SIGINT. */
    recorderSignal?: NodeJS.Signals | null;
  }

  async function stopIos(
    behavior: EncoderBehavior,
    recording: VideoCaptureConfig,
    options: StopOptions = { rawCodec: "hevc" },
  ): Promise<RecordingResult> {
    const backend = new FfmpegVideoProcessingBackend(
      undefined,
      undefined,
      startEncoder(behavior),
      () => "win32",
      { codec: async (filePath) => (filePath === RAW_PATH ? options.rawCodec : "hevc") },
      timer,
      {
        remove: async (filePath) => {
          removed.push(filePath);
        },
      },
      undefined,
      { size: async () => 4096 },
    );
    const handle: RecordingHandle = {
      recordingId: recording.recordingId,
      outputPath: recording.outputPath,
      startedAt: recording.startedAt,
      backendHandle: {
        platform: "ios",
        captureTracker: captureTracker(options.recorderSignal ?? null),
        capturePath: RAW_PATH,
        config: recording,
      },
    };
    return settleByFakeEvents(timer, backend.stop(handle), { description: "the iOS stop" });
  }

  test("a re-encode of a long recording gets a budget scaled to its duration, not a fixed 60 s", async () => {
    // ffmpeg needs 90 s of (fake) time; the old fixed budget killed it at 60 s.
    const result = await stopIos({ kind: "exits", afterMs: 90 * SECOND_MS, code: 0 }, config());

    expect(result.outputPath).toBe(OUTPUT_PATH);
    expect(result.warnings).toBeUndefined();
    expect(encoderKills).toEqual([]);
    // Success removes only the raw capture.
    expect(removed).toEqual([RAW_PATH]);
  });

  test("a stream copy keeps the 60 s budget and returns the raw capture when it overruns", async () => {
    const result = await stopIos(
      { kind: "exits", afterMs: 90 * SECOND_MS, code: 0 },
      config({ resolution: undefined }),
    );

    expect(encoderKills).toEqual(["SIGKILL"]);
    expect(result.outputPath).toBe(RAW_PATH);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("timed out after 60000ms");
    // The partial output goes; the raw capture, which is what is returned, stays.
    expect(removed).toEqual([OUTPUT_PATH]);
  });

  test("a re-encode that overruns even its scaled budget is reported as a timeout and keeps the raw capture", async () => {
    // Ten minutes recorded: a 300 s budget; ffmpeg would need 400 s.
    const result = await stopIos(
      { kind: "exits", afterMs: 400 * SECOND_MS, code: 0 },
      config({ startedAt: new Date(timer.now() - 10 * MINUTE_MS).toISOString() }),
    );

    expect(encoderKills).toEqual(["SIGKILL"]);
    expect(result.outputPath).toBe(RAW_PATH);
    expect(result.sizeBytes).toBe(4096);
    expect(result.codec).toBe("hevc");
    const warning = result.warnings?.[0] ?? "";
    expect(warning).toContain("post-processing ran out of time");
    expect(warning).toMatch(/timed out after 30\d{4}ms/);
    expect(warning).toContain("unprocessed");
    expect(removed).not.toContain(RAW_PATH);
  });

  test("an ffmpeg failure keeps the raw capture instead of failing the stop", async () => {
    const result = await stopIos({ kind: "exits", afterMs: SECOND_MS, code: 1 }, config());

    expect(result.outputPath).toBe(RAW_PATH);
    // Distinguished from running out of time, and it names the exit status.
    expect(result.warnings?.[0]).toContain(
      "post-processing failed (FFmpeg post-processing failed (exit 1)",
    );
    expect(result.warnings?.[0]).not.toContain("ran out of time");
    expect(removed).toEqual([OUTPUT_PATH]);
  });

  describe("a failed ffmpeg only keeps a raw capture that is playable (#10217)", () => {
    test("a raw capture with no moov atom (recorder killed) fails the stop as on main", async () => {
      const error = await stopIos({ kind: "exits", afterMs: SECOND_MS, code: 1 }, config(), {
        rawCodec: undefined,
        recorderSignal: "SIGKILL",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      const failure = error as VideoCaptureFinalizationError;
      expect(failure.message).toContain("Capture exited but finalization failed");
      expect(failure.message).toContain(RAW_PATH);
      expect(failure.retainedCapturePath).toBe(RAW_PATH);
      // The partial output goes; the raw bytes stay for recovery.
      expect(removed).toEqual([OUTPUT_PATH]);
    });

    test("a recorder killed past its stop timeout is not trusted even if the probe finds a track", async () => {
      const error = await stopIos({ kind: "exits", afterMs: SECOND_MS, code: 1 }, config(), {
        rawCodec: "hevc",
        recorderSignal: "SIGKILL",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
    });

    test("a timeout over a raw capture with no moov atom also fails the stop", async () => {
      const error = await stopIos(
        { kind: "exits", afterMs: 400 * SECOND_MS, code: 0 },
        config({ resolution: undefined }),
        { rawCodec: undefined },
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      expect(encoderKills).toEqual(["SIGKILL"]);
    });

    test("a recorder that exited on its own signal with a readable track is a valid fallback", async () => {
      const result = await stopIos({ kind: "exits", afterMs: SECOND_MS, code: 1 }, config(), {
        rawCodec: "h264",
        recorderSignal: null,
      });

      expect(result.outputPath).toBe(RAW_PATH);
      expect(result.codec).toBe("h264");
    });
  });

  test("an ffmpeg that cannot be confirmed gone still fails the stop and offers no raw capture", async () => {
    const error = await stopIos({ kind: "ignores-signals" }, config()).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
    expect((error as VideoCaptureFinalizationError).cause).toBeInstanceOf(
      ProcessTeardownUnconfirmedError,
    );
    expect(removed).not.toContain(RAW_PATH);
  });

  describe("bounded by the stop request's remaining time", () => {
    /** Runs the stop as a tool call whose request ends `requestMs` from now. */
    function stopWithinRequest(
      requestMs: number,
      behavior: EncoderBehavior,
      recording: VideoCaptureConfig,
    ): Promise<RecordingResult> {
      const deadlineMs = timer.now() + requestMs;
      return runWithAbortSignal(undefined, () => stopIos(behavior, recording), {
        getDeadlineMs: () => deadlineMs,
        textState: { dispatched: () => () => undefined },
      });
    }

    test("a re-encode whose estimate exceeds the request is still attempted with what is left (#10217)", async () => {
      // 30 minutes recorded estimates 900 s; the request has 90 s, 85 s after the margin.
      // Main tried for 60 s and often succeeded; the estimate must not refuse it up front.
      const result = await stopWithinRequest(
        90 * SECOND_MS,
        { kind: "exits", afterMs: 60 * SECOND_MS, code: 0 },
        config(),
      );

      expect(encoderStarts).toBe(1);
      expect(result.outputPath).toBe(OUTPUT_PATH);
      expect(result.warnings).toBeUndefined();
    });

    test("a re-encode that really overruns the request falls back: ffmpeg is stopped and its partial output removed", async () => {
      const result = await stopWithinRequest(
        90 * SECOND_MS,
        { kind: "exits", afterMs: 200 * SECOND_MS, code: 0 },
        config(),
      );

      expect(encoderStarts).toBe(1);
      expect(encoderKills).toEqual(["SIGKILL"]);
      expect(result.outputPath).toBe(RAW_PATH);
      expect(result.warnings?.[0]).toContain("post-processing ran out of time");
      expect(result.warnings?.[0]).toMatch(/timed out after 8[45]\d{3}ms/);
      expect(removed).toEqual([OUTPUT_PATH]);
    });

    test("a re-encode ffmpeg cannot be confirmed to have left still fails the stop", async () => {
      const error = await stopWithinRequest(
        90 * SECOND_MS,
        { kind: "ignores-signals" },
        config(),
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
      expect(removed).not.toContain(RAW_PATH);
    });

    test("a re-encode that fits in the request still runs", async () => {
      // 30 s recorded asks for the 60 s floor; the request has 90 s.
      const result = await stopWithinRequest(
        90 * SECOND_MS,
        { kind: "exits", afterMs: 5 * SECOND_MS, code: 0 },
        config({ startedAt: new Date(timer.now() - 30 * SECOND_MS).toISOString() }),
      );

      expect(encoderStarts).toBe(1);
      expect(result.outputPath).toBe(OUTPUT_PATH);
      expect(result.warnings).toBeUndefined();
    });

    test("a stream copy is held to the time left in the request and falls back when it overruns", async () => {
      const result = await stopWithinRequest(
        20 * SECOND_MS,
        { kind: "exits", afterMs: 40 * SECOND_MS, code: 0 },
        config({ resolution: undefined }),
      );

      expect(encoderStarts).toBe(1);
      expect(result.outputPath).toBe(RAW_PATH);
      // 20 s of request, less the 5 s response margin (and a few fake ms already spent).
      expect(result.warnings?.[0]).toMatch(/timed out after 1[45]\d{3}ms/);
    });

    test("a request with no time left returns the raw capture without starting ffmpeg", async () => {
      const result = await stopWithinRequest(
        3 * SECOND_MS,
        { kind: "exits", afterMs: SECOND_MS, code: 0 },
        config({ resolution: undefined }),
      );

      expect(encoderStarts).toBe(0);
      expect(result.outputPath).toBe(RAW_PATH);
      expect(result.warnings?.[0]).toContain("ran out of time");
      expect(result.warnings?.[0]).toContain("no time left");
    });

    test.each([
      ["no ambient deadline leaves the budget alone", 900_000, undefined, 900_000],
      ["a re-encode takes what is left rather than being refused", 300_000, 200_000, 195_000],
      ["a budget that fits is kept", 60_000, 90_000, 60_000],
      ["a stream copy takes what is left", 60_000, 30_000, 25_000],
      ["a budget never exceeds itself", 60_000, 500_000, 60_000],
      ["nothing left after the margin", 60_000, 5_000, undefined],
    ])("boundPostProcessBudgetToRequest: %s", (_name, budgetMs, remainingMs, expected) => {
      expect(boundPostProcessBudgetToRequest(budgetMs, remainingMs)).toBe(expected);
    });
  });

  describe("a stop that is not driven by a live request (#10217)", () => {
    /** The expired start-request deadline an auto-stop timer would inherit. */
    function stopFromExpiredStartRequest(
      behavior: EncoderBehavior,
      recording: VideoCaptureConfig,
    ): Promise<RecordingResult> {
      const expiredMs = timer.now() - 600 * SECOND_MS;
      return runWithAbortSignal(
        undefined,
        () => runOutsideRequestContext(() => stopIos(behavior, recording)),
        { getDeadlineMs: () => expiredMs, textState: { dispatched: () => () => undefined } },
      );
    }

    test("a stream copy still runs and is remuxed, not stored raw", async () => {
      const result = await stopFromExpiredStartRequest(
        { kind: "exits", afterMs: 20 * SECOND_MS, code: 0 },
        config({ resolution: undefined }),
      );

      expect(encoderStarts).toBe(1);
      expect(result.outputPath).toBe(OUTPUT_PATH);
      expect(result.warnings).toBeUndefined();
    });

    test("a re-encode gets the duration-scaled budget up to the unattended ceiling", async () => {
      // 40 minutes recorded estimates 1200 s, which the 600 s unattended ceiling cuts.
      const result = await stopFromExpiredStartRequest(
        { kind: "exits", afterMs: 900 * SECOND_MS, code: 0 },
        config({ startedAt: new Date(timer.now() - 40 * MINUTE_MS).toISOString() }),
      );

      expect(encoderKills).toEqual(["SIGKILL"]);
      expect(result.outputPath).toBe(RAW_PATH);
      expect(result.warnings?.[0]).toMatch(/timed out after 60\d{4}ms/);
    });
  });

  describe("ffmpegPostProcessBudgetMs", () => {
    const reencode = (): VideoCaptureConfig => config();
    const copy = (): VideoCaptureConfig => config({ resolution: undefined });

    test("a stream copy is always 60 s", () => {
      expect(ffmpegPostProcessBudgetMs(copy(), 3600)).toBe(60_000);
      expect(ffmpegPostProcessBudgetMs(copy(), undefined)).toBe(60_000);
    });

    test.each([
      [0, 60_000],
      [30, 60_000],
      [120, 60_000],
      [600, 300_000],
      [1800, 900_000],
      [3600, 1_800_000],
      [7200, 1_800_000],
    ])("a re-encode of %d recorded seconds gets %d ms", (recordedSeconds, expectedMs) => {
      expect(ffmpegPostProcessBudgetMs(reencode(), recordedSeconds)).toBe(expectedMs);
    });

    test("an unattended stop uses a ceiling well below 30 minutes", () => {
      expect(FFMPEG_UNATTENDED_REENCODE_MAX_BUDGET_MS).toBe(600_000);
      expect(
        ffmpegPostProcessBudgetMs(reencode(), 3600, FFMPEG_UNATTENDED_REENCODE_MAX_BUDGET_MS),
      ).toBe(600_000);
      expect(
        ffmpegPostProcessBudgetMs(reencode(), 300, FFMPEG_UNATTENDED_REENCODE_MAX_BUDGET_MS),
      ).toBe(150_000);
      expect(
        ffmpegPostProcessBudgetMs(copy(), 3600, FFMPEG_UNATTENDED_REENCODE_MAX_BUDGET_MS),
      ).toBe(60_000);
    });

    test("a re-encode of an unknown duration gets the ceiling rather than being cut short", () => {
      expect(ffmpegPostProcessBudgetMs(reencode(), undefined)).toBe(1_800_000);
      expect(ffmpegPostProcessBudgetMs(reencode(), Number.NaN)).toBe(1_800_000);
    });

    test("only the capped part of a recording is re-encoded", () => {
      expect(ffmpegPostProcessBudgetMs({ ...reencode(), maxDurationSeconds: 600 }, 3600)).toBe(
        300_000,
      );
    });
  });
});

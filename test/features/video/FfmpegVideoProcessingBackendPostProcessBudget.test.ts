import { beforeEach, describe, expect, test } from "bun:test";
import {
  ffmpegPostProcessBudgetMs,
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

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    timer.setCurrentTime(1_000_000_000);
    removed = [];
    encoderKills = [];
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

  function captureTracker(): ProcessTracker {
    const process = new EventEmitter() as ProcessTracker["process"];
    process.stderr = new EventEmitter() as ProcessTracker["process"]["stderr"];
    process.exitCode = 0;
    process.signalCode = null;
    process.killed = false;
    process.kill = () => true;
    return { process, exitState: { exitCode: 0 }, exitPromise: Promise.resolve(), stderr: [] };
  }

  async function stopIos(
    behavior: EncoderBehavior,
    recording: VideoCaptureConfig,
  ): Promise<RecordingResult> {
    const backend = new FfmpegVideoProcessingBackend(
      undefined,
      undefined,
      startEncoder(behavior),
      () => "win32",
      { codec: async () => "hevc" },
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
        captureTracker: captureTracker(),
        capturePath: RAW_PATH,
        config: recording,
      },
    };
    return backend.stop(handle);
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
    expect(warning).toContain("post-processing did not finish");
    expect(warning).toMatch(/timed out after 30\d{4}ms/);
    expect(warning).toContain("unprocessed");
    expect(removed).not.toContain(RAW_PATH);
  });

  test("an ffmpeg failure keeps the raw capture instead of failing the stop", async () => {
    const result = await stopIos({ kind: "exits", afterMs: SECOND_MS, code: 1 }, config());

    expect(result.outputPath).toBe(RAW_PATH);
    expect(result.warnings?.[0]).toContain("FFmpeg post-processing failed");
    expect(removed).toEqual([OUTPUT_PATH]);
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

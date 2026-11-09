import { describe, expect, test } from "bun:test";
import { FfmpegRecordingPostProcessor } from "../../../src/features/video/FfmpegRecordingPostProcessor";
import type { FfmpegBackendHandle } from "../../../src/features/video/FfmpegRecordingHandle";
import type { FfmpegClient } from "../../../src/utils/media/FfmpegClient";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { settleByFakeEvents } from "../../helpers/fakeTimerStepping";

const RAW_PATH = "/fake/recording/rec-raw.mov";

const unusedFfmpeg: FfmpegClient = {
  binaryPath: "fake-ffmpeg",
  start: () => {
    throw new Error("unused");
  },
  probe: async () => ({ version: "7.1", encoders: [] }),
  run: async () => {
    throw new Error("unused");
  },
  pipe: () => {
    throw new Error("unused");
  },
};

describe("FfmpegRecordingPostProcessor missing capture diagnostics", () => {
  test.each([
    {
      name: "keeps the --display the capture ran with",
      captureArgs: ["io", "sim", "recordVideo", "--display=Integrated Display 2", RAW_PATH],
      command: `xcrun simctl io sim recordVideo --display=Integrated Display 2 ${RAW_PATH}`,
    },
    {
      name: "falls back to the plain command for a handle without capture arguments",
      captureArgs: undefined,
      command: `xcrun simctl io sim recordVideo ${RAW_PATH}`,
    },
  ])("$name", async ({ captureArgs, command }) => {
    const timer = new FakeTimer();
    const handle: FfmpegBackendHandle = {
      kind: "ffmpeg",
      platform: "ios",
      captureTracker: {
        process: new FakeChildProcess(timer),
        exitState: { exitCode: 0 },
        exitPromise: Promise.resolve(),
        stderr: [],
      },
      capturePath: RAW_PATH,
      captureArgs: captureArgs ? [...captureArgs] : undefined,
      config: {
        recordingId: "rec",
        outputDirectory: "/fake/recording",
        outputPath: "/fake/recording/rec.mp4",
        fileName: "rec.mp4",
        startedAt: new Date(timer.now()).toISOString(),
        qualityPreset: "low",
        targetBitrateKbps: 1000,
        maxThroughputMbps: 5,
        fps: 15,
        maxArchiveSizeMb: 2048,
        format: "mp4",
        device: { platform: "ios", deviceId: "sim", name: "iPhone" },
      },
    };
    const processor = new FfmpegRecordingPostProcessor({
      ffmpegClient: unusedFfmpeg,
      timer,
      recordingFileProbe: { size: async () => null },
      captureFileRemover: { remove: async () => undefined },
      codecProbe: { codec: async () => undefined },
      detectHardwareAccel: async () => ({ encoder: "none", available: false, description: "none" }),
    });

    const outcome = processor.postProcessRecording(handle).then(
      () => undefined,
      (error: unknown) => error,
    );
    const error = await settleByFakeEvents(timer, outcome, { description: "the missing capture" });

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("iOS recording file missing");
    expect((error as Error).message).toContain(`command: ${command}`);
  });
});

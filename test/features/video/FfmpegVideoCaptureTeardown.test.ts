import { expect, spyOn, test } from "bun:test";
import { FfmpegVideoProcessingBackend } from "../../../src/features/video/FfmpegVideoProcessingBackend";
import {
  DEFAULT_VIDEO_RECORDING_CONFIG,
  type RecordingHandle,
} from "../../../src/features/video/VideoRecorderService";
import { trackProcess } from "../../../src/utils/ChildProcessTracker";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

function handle(platform: "ios" | "android", pid: number | undefined = 42): RecordingHandle {
  const child = new FakeChildProcess();
  child.pid = pid;
  return {
    recordingId: "rec",
    outputPath: "/kept/rec.mp4",
    startedAt: "invalid",
    backendHandle: {
      kind: "ffmpeg",
      platform,
      captureTracker: trackProcess(child),
      capturePath: "/kept/rec-raw.mov",
      config: {
        ...DEFAULT_VIDEO_RECORDING_CONFIG,
        device: { platform, deviceId: "sim-id", name: "Fake" },
      },
    },
  };
}

function backend(readToken: (pid: number) => string | undefined) {
  return new FfmpegVideoProcessingBackend(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new FakeTimer(),
    undefined,
    undefined,
    undefined,
    readToken,
  );
}

test("iOS handle describes its persisted host generation, udid and raw path", () => {
  const read = (pid: number) => {
    expect(pid).toBe(42);
    return "generation-a";
  };
  expect(backend(read).describeCaptureTeardown(handle("ios"))).toEqual({
    kind: "ios-host-recorder",
    hostPid: 42,
    hostStartToken: "generation-a",
    udid: "sim-id",
    capturePath: "/kept/rec-raw.mov",
  });
});

test("iOS teardown identity remains pinned when a later read would see a recycled pid", () => {
  let token = "generation-a";
  let reads = 0;
  const capture = handle("ios");
  const recorder = backend(() => {
    reads++;
    return token;
  });
  const original = recorder.describeCaptureTeardown(capture);
  token = "replacement";
  expect(recorder.describeCaptureTeardown(capture)).toEqual(original);
  expect(reads).toBe(1);
});

test.each(["pid", "token", "reader throws"])(
  "unreadable iOS %s warns and has no descriptor",
  (failure) => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const read = () => {
        if (failure === "reader throws") {
          throw new Error("probe failed");
        }
        return undefined;
      };
      const recording = handle("ios");
      if (failure === "pid") {
        const childHandle = recording.backendHandle as {
          captureTracker: { process: { pid?: number } };
        };
        childHandle.captureTracker.process.pid = undefined;
      }
      expect(backend(read).describeCaptureTeardown(recording)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  },
);

test("Android ffmpeg-pipe handle never probes a host token", () => {
  expect(
    backend(() => {
      throw new Error("must not probe");
    }).describeCaptureTeardown(handle("android")),
  ).toBeUndefined();
});

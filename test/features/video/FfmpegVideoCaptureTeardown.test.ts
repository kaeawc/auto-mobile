import { expect, spyOn, test } from "bun:test";
import { FfmpegVideoProcessingBackend } from "../../../src/features/video/FfmpegVideoProcessingBackend";
import {
  DEFAULT_VIDEO_RECORDING_CONFIG,
  type RecordingHandle,
} from "../../../src/features/video/VideoRecorderService";
import { trackProcess } from "../../../src/utils/ChildProcessTracker";
import { FakeChildProcess } from "../../fakes/FakeChildProcess";
import { FakeTimer } from "../../fakes/FakeTimer";
import { ActionableError } from "../../../src/models";
import { FakeHostRecorderProcessControl } from "../../fakes/FakeHostRecorderProcessControl";
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

test("FFmpeg background orphan teardown retains a slow-finalizing host without SIGKILL", async () => {
  const timer = new FakeTimer();
  const control = new FakeHostRecorderProcessControl();
  const recorder = new FfmpegVideoProcessingBackend(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    timer,
    undefined,
    undefined,
    undefined,
    () => "generation-a",
    control,
  );
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    let failure: unknown;
    const observed = recorder
      .forceStopOrphanedCapture(
        undefined,
        {
          kind: "ios-host-recorder",
          hostPid: 42,
          hostStartToken: "generation-a",
          udid: "sim-id",
        },
        { mode: "background" },
      )
      .then(
        () => {},
        (error: unknown) => {
          failure = error;
        },
      );
    for (let elapsed = 0; elapsed < 5_000; elapsed += 100) {
      timer.advanceTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(failure).toBeInstanceOf(ActionableError);
    await observed;
    timer.advanceTime(40_000);
    expect(control.signals).toEqual([[42, "SIGINT"]]);
    expect(timer.getPendingSleepCount()).toBe(0);
  } finally {
    warn.mockRestore();
    timer.reset();
  }
});

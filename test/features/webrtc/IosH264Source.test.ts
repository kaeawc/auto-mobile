import { DefaultFfmpegClient } from "../../../src/utils/media/FfmpegClient";
import { EncodedUnsupportedError } from "../../../src/features/webrtc/EncodedUnsupportedError";
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL,
  IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS,
  IOS_HELPER_STOP_TIMEOUT_MS,
  IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS,
  IosH264Source,
  ScreenRecordingPermissionError,
} from "../../../src/features/webrtc/IosH264Source";
import { IosSimulatorCaptureHelperPool } from "../../../src/features/screen-stream/IosSimulatorCaptureHelperPool";
import { logger } from "../../../src/utils/logger";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "../../../src/features/webrtc/webrtcStreamingConfig";
import {
  ENCODED_VIDEO_CAPABILITY,
  NATIVE_FRAME_METRICS_PREFIX,
  type NativeFrameMetrics,
} from "../../../src/features/screen-stream";
import type { CaptureTarget } from "../../../src/features/screen-stream";
import {
  IOS_DEVICE,
  IOS_SIMULATOR,
  FAKE_HELPER_PATH,
  fakeHelperPathExists,
  FakeFrameCaptureHelper,
  encodedRecord,
  DelayedStopFrameCaptureHelper,
  NeverStoppingFrameCaptureHelper,
  flush,
  startWithRecord,
  createHarness,
  successfulCommandRunner,
  createEncodedHarness,
  startEncoded,
} from "../../helpers/iosH264SourceHarness";

describe("IosH264Source", () => {
  test("resolves simulator window ids before starting simulator capture", async () => {
    const { source, helper, helperTargets } = createHarness(IOS_SIMULATOR);

    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));

    expect(helperTargets).toEqual([
      {
        kind: "simulator",
        windowID: 42,
        fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT,
        encode: {
          codec: "h264",
          bitrate: { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL },
        },
      },
    ]);
  });
});

describe("IosH264Source", () => {
  test("invalidates a pooled helper when a stale capture is retired", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR);
    let invalidated = false;
    helper.invalidate = async () => {
      invalidated = true;
    };
    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));
    await source.stopStale();
    expect(invalidated).toBe(true);
    expect(helper.stopped).toBe(false);
  });
});

describe("IosH264Source", () => {
  test("keeps a shared producer when only this source's encoder is stale", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR);
    let invalidated = false;
    helper.invalidate = async () => {
      invalidated = true;
    };
    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));
    await source.stopStale(false);
    expect(invalidated).toBe(false);
    expect(helper.stopped).toBe(true);
  });
});

describe("IosH264Source", () => {
  test("forwards current helper idle evidence but ignores it after stop", async () => {
    let idleCount = 0;
    const { source, helper } = createHarness(IOS_SIMULATOR, {
      onSourceIdle: () => idleCount++,
    });
    const started = source.start();
    await flush();
    helper.emit("capability", "simulator-idle-evidence");
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;
    helper.emit("idle", { windowID: 42 });
    expect(idleCount).toBe(1);
    await source.stop();
    helper.emit("idle", { windowID: 42 });
    expect(idleCount).toBe(1);
  });
});

describe("IosH264Source", () => {
  test("reports legacy idle compatibility only when the helper lacks the handshake", async () => {
    const support: boolean[] = [];
    const { source, helper } = createHarness(IOS_SIMULATOR, {
      onIdleAttestationSupport: (supported) => support.push(supported),
    });
    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));
    expect(support).toEqual([false]);
    helper.emit("capability", "simulator-idle-evidence");
    expect(support).toEqual([false, true]);
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("classifies a marked Screen Recording denial while discovering Simulator windows", async () => {
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,

      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          return {
            stdout: "",
            stderr:
              "capture-permission: screen-recording\n" +
              "capture-permission-target: AutoMobile\n" +
              "error: Screen Recording permission is required.",
            exitCode: 1,
            signal: null,
          };
        }
        return successfulCommandRunner(command, args);
      },
    });

    const error = await source.start().then(
      () => null,
      (reason) => reason as ScreenRecordingPermissionError,
    );
    expect(error).toBeInstanceOf(ScreenRecordingPermissionError);
    expect(error?.approvalTarget).toBe("AutoMobile");
    expect(helper.started).toBe(false);
  });
});

describe("IosH264Source", () => {
  test("classifies the released helper's TCC denial while discovering Simulator windows", async () => {
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,

      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          return {
            stdout: "",
            stderr:
              "error: failed to query simulator windows: Error Domain=com.apple.ScreenCaptureKit.SCStreamErrorDomain Code=-3801\n" +
              '"The user declined TCCs for application, window, display capture"\n' +
              "hint: grant Screen Recording permission to your terminal/IDE.",
            exitCode: 1,
            signal: null,
          };
        }
        return successfulCommandRunner(command, args);
      },
    });

    const error = await source.start().then(
      () => null,
      (reason) => reason as ScreenRecordingPermissionError,
    );
    expect(error).toBeInstanceOf(ScreenRecordingPermissionError);
    expect(error?.approvalTarget).toBe("AutoMobile");
    expect(helper.started).toBe(false);
  });
});

describe("IosH264Source", () => {
  test("fails target resolution within two seconds instead of waiting for capture startup", async () => {
    const timer = new FakeTimer();
    let aborted = false;
    const { source, helper } = createHarness(IOS_SIMULATOR, {
      timer,
      simulatorWindowResolver: (_helperPath, _device, _audioEnabled, signal) =>
        new Promise<number>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("resolver aborted"));
          });
        }),
    });

    const started = source.start();
    await flush();
    timer.advanceTime(IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS);

    await expect(started).rejects.toThrow(/Timed out resolving iOS Simulator window/);
    expect(helper.started).toBe(false);
    expect(aborted).toBe(true);
  });
});

describe("IosH264Source", () => {
  test("leaves an injected simulator helper pool warm after stream stop", async () => {
    const helper = new FakeFrameCaptureHelper();
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => helper,
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      simulatorHelperPool: pool,

      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
    });

    const started = source.start();
    await flush();
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;
    await source.stop();

    expect(helper.started).toBe(true);
    expect(helper.stopped).toBe(false);
    await pool.shutdown();
    expect(helper.stopped).toBe(true);
  });
});

describe("IosH264Source", () => {
  test("names the last capture startup stage in the first-frame timeout error", async () => {
    const timer = new FakeTimer();
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      firstFrameTimeoutMs: 1,
      timer,
      onData: () => {},
      createHelper: () => helper,

      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    // The furthest stage reached wins: capture-started is later than the
    // earlier permission/resolve markers.
    helper.emitReadiness("permission-ready");
    helper.emitReadiness("target-resolved");
    helper.emitReadiness("capture-started");
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      "iOS screen capture did not produce a first frame (last stage: capture-started).",
    );
  });
});

describe("IosH264Source", () => {
  test("adds a hung-start hint when a simulator resolves its window but never starts", async () => {
    const timer = new FakeTimer();
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      firstFrameTimeoutMs: 1,
      timer,
      onData: () => {},
      createHelper: () => helper,
      simulatorWindowResolver: async () => 42,

      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    helper.emitReadiness("permission-ready");
    helper.emitReadiness("target-resolved");
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe(
      "iOS screen capture did not produce a first frame (last stage: target-resolved). " +
        "Capture never started after the window resolved (hung start); retry or restart the Simulator.",
    );
  });
});

describe("IosH264Source", () => {
  test("requests simulator audio and forwards its PCM16LE chunks unchanged", async () => {
    const audio: Buffer[] = [];
    const { source, helper, helperTargets } = createHarness(IOS_SIMULATOR, {
      audioEnabled: true,
      onAudioData: (chunk) => audio.push(chunk),
    });

    const started = source.start();
    await flush();
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helper.emit("audio", { pcm16le: Buffer.from([0x34, 0x12]) });
    await started;

    expect(helperTargets).toEqual([
      {
        kind: "simulator",
        windowID: 42,
        fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT,
        encode: {
          codec: "h264",
          bitrate: { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL },
        },
        audio: true,
      },
    ]);
    expect(audio).toEqual([Buffer.from([0x34, 0x12])]);
  });
});

describe("IosH264Source", () => {
  test("rejects audio startup when the Simulator never produces PCM", async () => {
    const timer = new FakeTimer();
    const { source, helper } = createHarness(IOS_SIMULATOR, {
      audioEnabled: true,
      timer,
      firstFrameTimeoutMs: 1,
    });
    const started = source.start();
    await flush();
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    timer.advanceTime(1);

    await expect(started).rejects.toThrow(/did not produce PCM audio/);
  });
});

describe("IosH264Source", () => {
  test("rejects audio startup when the helper exits after video but before PCM", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR, { audioEnabled: true });
    const started = source.start();
    await flush();
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helper.emit("exit", { code: 1, signal: null });

    await expect(started).rejects.toThrow(/exited before audio/);
  });
});

describe("IosH264Source", () => {
  test("rejects audio startup when the helper errors after video but before PCM", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR, { audioEnabled: true });
    const started = source.start();
    await flush();
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helper.emit("error", new Error("helper crashed"));

    await expect(started).rejects.toThrow("helper crashed");
  });
});

describe("IosH264Source", () => {
  test("reports a fatal capture-helper diagnostic after startup", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });

    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));
    helper.emitStderr("Error: AVCaptureSession runtime error: media services were reset");
    await flush();

    expect(errors[0].message).toContain("media services were reset");
    expect(helper.stopped).toBe(true);
  });
});

describe("IosH264Source", () => {
  test("reports a running-phase helper SIGTRAP with its exit signal and last stderr lines", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });
    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));

    helper.emitStderr("capture-phase: first-frame");
    helper.emitStderr(`${NATIVE_FRAME_METRICS_PREFIX}{"droppedFrames":0}`);
    helper.emitStderr("Fatal error: unexpected nil in capture callback");
    helper.emitStderr(`${NATIVE_FRAME_METRICS_PREFIX}{"droppedFrames":1}`);
    helper.emitExit(null, "SIGTRAP");
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/exited \(code=null, signal=SIGTRAP\); last stderr: /);
    expect(errors[0].message).toContain("capture-phase: first-frame");
    expect(errors[0].message).toContain("Fatal error: unexpected nil in capture callback");
    expect(errors[0].message).not.toContain("droppedFrames");
  });
});

describe("IosH264Source", () => {
  test("reports a running-phase helper non-zero exit code", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });
    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));

    helper.emitExit(70, null);
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("screen-capture-helper exited (code=70, signal=null)");
  });
});

describe("IosH264Source", () => {
  test("keeps only the last helper stderr lines in the exit report", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });
    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));

    for (let i = 1; i <= 8; i++) {
      helper.emitStderr(`line-${i}`);
    }
    helper.emitExit(null, "SIGTRAP");
    await flush();

    expect(errors[0].message).not.toContain("line-3");
    expect(errors[0].message).toContain("line-4 | line-5 | line-6 | line-7 | line-8");
  });
});

describe("IosH264Source", () => {
  test("does not report a helper exit caused by stop() as a stream failure", async () => {
    const { source, helper, errors } = createHarness(IOS_DEVICE, {
      runningReconnectMaxAttempts: 0,
    });
    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));

    const stopping = source.stop();
    helper.emitExit(null, "SIGTERM");
    await stopping;
    await flush();

    expect(errors).toEqual([]);
  });
});

describe("IosH264Source", () => {
  test("does not report helper startup exits through post-start onError", async () => {
    const { source, helper, errors } = createHarness();

    const started = source.start();
    await flush();
    helper.emit("exit", { code: 1, signal: null });

    await expect(started).rejects.toThrow(/screen-capture-helper exited/);
    expect(errors).toEqual([]);
  });
});

describe("IosH264Source", () => {
  test("includes helper stderr when startup exits before the first frame", async () => {
    const { source, helper } = createHarness();

    const started = source.start();
    await flush();
    helper.emitStderr("ScreenCaptureKit failed to start capture");
    helper.emit("exit", { code: null, signal: "SIGABRT" });

    await expect(started).rejects.toThrow(
      /screen-capture-helper exited \(code=null, signal=SIGABRT\); last stderr: ScreenCaptureKit failed to start capture/,
    );
  });
});

describe("IosH264Source", () => {
  test("logs healthy helper frame metrics at debug and preserves stderr warnings", async () => {
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      const { source, helper } = createHarness(IOS_DEVICE);
      await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));
      warning.mockClear();
      debug.mockClear();

      const healthyLine =
        'automobile-frame-metrics:{"droppedFrames":0,"highWaterMarkBytes":0,"frameQueueDepth":0,"bytesQueued":0}';
      helper.emitStderr(healthyLine);
      expect(debug).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining(healthyLine));
      expect(warning).not.toHaveBeenCalled();

      warning.mockClear();
      helper.emitStderr(
        'automobile-frame-metrics:{"droppedFrames":3,"highWaterMarkBytes":0,"frameQueueDepth":0,"bytesQueued":0}',
      ); // Real-shape line with only droppedFrames changed.
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('"droppedFrames":3'));

      warning.mockClear();
      helper.emitStderr(
        'automobile-frame-metrics:{"droppedFrames":0,"highWaterMarkBytes":0,"frameQueueDepth":1,"bytesQueued":0}',
      ); // Real-shape line with only frameQueueDepth changed.
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('"frameQueueDepth":1'));

      warning.mockClear();
      helper.emitStderr(`${NATIVE_FRAME_METRICS_PREFIX}{"droppedFrames":`);
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[0]).toContain("unrecognised frame-metrics line");
      expect(warning.mock.calls[0]?.[0]).toContain(
        `${NATIVE_FRAME_METRICS_PREFIX}{"droppedFrames":`,
      );
      expect(warning.mock.calls[0]?.[0]).toContain("; ");

      warning.mockClear();
      helper.emitStderr("ordinary helper diagnostic");
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalledWith(
        "[IosH264Source] screen-capture-helper stderr: ordinary helper diagnostic",
      );
      await source.stop();
    } finally {
      debug.mockRestore();
      warning.mockRestore();
    }
  });
});

describe("IosH264Source", () => {
  test("resolves startup quietly when stopped before the first frame", async () => {
    const helper = new FakeFrameCaptureHelper();
    const timer = new FakeTimer();
    const errors: Error[] = [];
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      firstFrameTimeoutMs: 1,
      timer,
      onData: () => {},
      onError: (error) => errors.push(error),
      createHelper: () => helper,

      commandRunner: successfulCommandRunner,
    });

    const started = source.start();
    await flush();
    const stopped = source.stop();
    await stopped;
    await started;
    timer.advanceTime(1);
    await flush();

    expect(helper.started).toBe(true);
    expect(helper.stopped).toBe(true);
    expect(errors).toEqual([]);
  });
});

describe("IosH264Source", () => {
  test("reports helper exit emitted after first frame before start resumes", async () => {
    const { source, helper, errors } = createHarness();

    const started = source.start();
    await flush();
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helper.emit("exit", { code: 1, signal: null });

    await started;
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
    expect(helper.stopped).toBe(true);
  });
});

describe("IosH264Source", () => {
  test("reports helper error emitted after first frame before start resumes", async () => {
    const { source, helper, errors } = createHarness();

    const started = source.start();
    await flush();
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helper.emit("error", new Error("helper crashed"));

    await started;
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("helper crashed");
    expect(helper.stopped).toBe(true);
  });
});

describe("IosH264Source encoded path (#4789)", () => {
  test("a timed-out old encoded helper cannot forward records, audio, or capability", async () => {
    const timer = new FakeTimer();
    const oldHelper = new NeverStoppingFrameCaptureHelper();
    const helpers: FakeFrameCaptureHelper[] = [];
    const audio: Buffer[] = [];
    const { source, chunks } = createEncodedHarness({
      timer,
      audioEnabled: true,
      onAudioData: (chunk) => audio.push(chunk),
      createHelper: () => {
        const helper = helpers.length === 0 ? oldHelper : new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const started = source.start();
    await flush();
    oldHelper.emitCapability(ENCODED_VIDEO_CAPABILITY);
    oldHelper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    oldHelper.emit("audio", { pcm16le: Buffer.from([1]) });
    await started;
    oldHelper.emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(IOS_HELPER_STOP_TIMEOUT_MS);
    await flush();
    timer.advanceTime(500);
    await flush();
    helpers[1].emitCapability(ENCODED_VIDEO_CAPABILITY);
    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helpers[1].emit("audio", { pcm16le: Buffer.from([2]) });
    await flush();
    const recordCount = chunks.length;
    const audioCount = audio.length;
    oldHelper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x41]));
    oldHelper.emit("audio", { pcm16le: Buffer.from([3]) });
    oldHelper.emitMalformed("late record");
    expect(chunks).toHaveLength(recordCount);
    expect(audio).toHaveLength(audioCount);
    expect(helpers[1].keyFrameRequests).toBe(0);
    await source.stop();
  });

  test("an abandoned helper cannot confirm a replacement's encode capability", async () => {
    const timer = new FakeTimer();
    const oldHelper = new NeverStoppingFrameCaptureHelper(false);
    const helpers: FakeFrameCaptureHelper[] = [];
    const targets: CaptureTarget[] = [];
    const { source, errors } = createEncodedHarness({
      timer,
      createHelper: (options) => {
        targets.push(options.target);
        const helper = helpers.length === 0 ? oldHelper : new FakeFrameCaptureHelper(false);
        helpers.push(helper);
        return helper;
      },
    });
    await startEncoded(source, helpers);
    oldHelper.emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(IOS_HELPER_STOP_TIMEOUT_MS);
    await flush();
    timer.advanceTime(500);
    await flush();

    oldHelper.emitCapability(ENCODED_VIDEO_CAPABILITY);
    helpers[1].emitStderr("error: --encode unsupported");
    await flush();
    expect(helpers).toHaveLength(2);
    expect(targets.every((target) => target.encode !== undefined)).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(EncodedUnsupportedError);
    await source.stop();
  });

  test("reads encoded records and forwards Annex-B without an ffmpeg subprocess", async () => {
    const { source, helpers, commandRunnerCalls, chunks } = createEncodedHarness();

    await startEncoded(source, helpers);
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x41, 0x9a], false, 2));

    expect(commandRunnerCalls).toEqual([]);
    expect(chunks.map((chunk) => [...chunk])).toEqual([
      [0, 0, 0, 1, 0x65, 0x88],
      [0, 0, 0, 1, 0x41, 0x9a],
    ]);
  });

  test("spawns the helper with the bits-per-pixel default encode settings", async () => {
    const { source, helpers, helperTargets } = createEncodedHarness();

    await startEncoded(source, helpers);

    expect(helperTargets).toEqual([
      {
        kind: "simulator",
        windowID: 42,
        fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT,
        encode: {
          codec: "h264",
          bitrate: { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL },
        },
      },
    ]);
  });

  test("passes an operator bitrate override down as explicit encode bps", async () => {
    const { source, helpers, helperTargets } = createEncodedHarness({ bitrateBps: 1_234_000 });

    await startEncoded(source, helpers);

    const target = helperTargets[0];
    expect(target.kind === "simulator" ? target.encode : undefined).toEqual({
      codec: "h264",
      bitrate: { kind: "explicitBps", bps: 1_234_000 },
    });
  });

  test("passes the quality cap to encoded capture while keeping explicit bitrate precedence", async () => {
    const { source, helpers, helperTargets } = createEncodedHarness({
      quality: "low",
      bitrateBps: 1_234_000,
    });
    await startEncoded(source, helpers);
    const target = helperTargets[0];
    expect(target.kind === "simulator" ? target.encode : undefined).toEqual({
      codec: "h264",
      bitrate: { kind: "explicitBps", bps: 1_234_000 },
      maxLongSide: 540,
    });
    await source.stop();
  });

  test("requestKeyFrame sends the forceKeyFrame control command, throttled by the shorter interval", async () => {
    const timer = new FakeTimer();
    const { source, helpers } = createEncodedHarness({ timer });

    await startEncoded(source, helpers);

    expect(source.requestKeyFrame()).toBe(true);
    expect(helpers[0].keyFrameRequests).toBe(1);
    // A burst is collapsed inside the throttle window.
    expect(source.requestKeyFrame()).toBe(false);
    expect(helpers[0].keyFrameRequests).toBe(1);

    timer.advanceTime(IOS_ENCODED_FORCED_KEYFRAME_MIN_INTERVAL_MS);
    expect(source.requestKeyFrame()).toBe(true);
    expect(helpers[0].keyFrameRequests).toBe(2);

    await source.stop();
  });

  test("requests a keyframe after a decoder resync so recovery starts on an IDR", async () => {
    const { source, helpers } = createEncodedHarness();

    await startEncoded(source, helpers);
    helpers[0].emitMalformed("header_checksum_mismatch");

    expect(helpers[0].keyFrameRequests).toBe(1);

    await source.stop();
  });
});

describe("IosH264Source encoder-drop telemetry", () => {
  test("forwards the native writer's cumulative encoder-drop counter", async () => {
    const droppedFrames: number[] = [];
    const { source, helper } = createHarness(IOS_DEVICE, {
      onDroppedFrames: (value) => droppedFrames.push(value),
    });
    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));

    // The default encoded Simulator path advances only the native writer counter, delivered via
    // captureMetrics — VideoToolbox overload must reach the relay through this event.
    helper.emit("captureMetrics", {
      captureTimestampMs: 1,
      frameQueueAgeMs: 0,
      frameQueueDepth: 0,
      droppedFrames: 7,
      bytesQueued: 0,
      highWaterMarkBytes: 0,
      lastOutputWriteDurationMs: null,
    });

    expect(droppedFrames).toEqual([7]);
    await source.stop();
  });
});

describe("IosH264Source encoded-only contract", () => {
  let probe: Mock<DefaultFfmpegClient["probe"]>;
  let spawn: Mock<DefaultFfmpegClient["start"]>;
  beforeEach(() => {
    probe = spyOn(DefaultFfmpegClient.prototype, "probe").mockImplementation(() => {
      throw new Error("Unexpected ffmpeg probe");
    });
    spawn = spyOn(DefaultFfmpegClient.prototype, "start").mockImplementation(() => {
      throw new Error("Unexpected ffmpeg spawn");
    });
  });
  afterEach(() => {
    expect(probe).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    probe.mockRestore();
    spawn.mockRestore();
  });
  test.each([
    [IOS_DEVICE, undefined, undefined, { kind: "videoToolboxDefault" }, undefined],
    [IOS_SIMULATOR, undefined, undefined, { kind: "bitsPerPixel", bpp: 0.1 }, undefined],
    [IOS_DEVICE, "low", undefined, { kind: "explicitBps", bps: 2_000_000 }, 540],
    [IOS_DEVICE, "low", 1_234_000, { kind: "explicitBps", bps: 1_234_000 }, 540],
    [IOS_SIMULATOR, "low", undefined, { kind: "explicitBps", bps: 2_000_000 }, 540],
  ] as const)(
    "uses the target bitrate policy for %j quality=%s override=%s",
    async (device, quality, bitrateBps, bitrate, maxLongSide) => {
      const { source, helpers, helperTargets, commandRunnerCalls } = createEncodedHarness({
        device,
        quality,
        bitrateBps,
      });
      await startEncoded(source, helpers);
      expect(helperTargets[0].encode).toEqual({
        codec: "h264",
        bitrate,
        ...(maxLongSide === undefined ? {} : { maxLongSide }),
      });
      if (device === IOS_DEVICE) {
        expect(helperTargets[0]).toMatchObject({ kind: "device", deviceId: IOS_DEVICE.deviceId });
      }
      expect(commandRunnerCalls).toEqual([]);
      await source.stop();
    },
  );

  test.each([IOS_DEVICE, IOS_SIMULATOR])(
    "ignores explicit size for %j and warns once",
    async (device) => {
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { source, helpers, helperTargets } = createEncodedHarness({
          device,
          size: { width: 640, height: 480 },
          quality: "low",
        });
        await startEncoded(source, helpers);
        helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x41]));
        expect(helperTargets[0].encode).toEqual({
          codec: "h264",
          bitrate: { kind: "explicitBps", bps: 2_000_000 },
          maxLongSide: 540,
        });
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining("native size capped by the quality preset"),
        );
        await source.stop();
      } finally {
        warning.mockRestore();
      }
    },
  );

  test.each([
    ["error", false],
    ["exit", false],
    ["timeout", false],
    ["error", true],
    ["exit", true],
    ["timeout", true],
  ] as const)(
    "fails an old helper at %s (audio=%s) with upgrade guidance and no fallback",
    async (failure, audioEnabled) => {
      const timer = new FakeTimer();
      const { source, helpers, chunks, commandRunnerCalls } = createEncodedHarness({
        timer,
        firstFrameTimeoutMs: 20,
        audioEnabled,
      });
      const started = source.start().catch((error: unknown) => error);
      await flush();
      // Raw output from an old helper must neither complete startup nor reach onData.
      helpers[0].emit("frame", {
        header: { width: 1, height: 1, bytesPerRow: 4, timestampMs: 1 },
        pixels: Buffer.alloc(4),
      });
      expect(helpers[0].listenerCount("frame")).toBe(0);
      switch (failure) {
        case "error":
          helpers[0].emitStderr("error: unknown argument --encode");
          break;
        case "exit":
          helpers[0].emitExit(1);
          break;
        case "timeout":
          timer.advanceTime(20);
          break;
      }
      const error = await started;
      expect(error).toBeInstanceOf(EncodedUnsupportedError);
      if (!(error instanceof Error)) {
        throw new Error("Expected startup to fail");
      }
      expect(error.message).toContain("matching AutoMobile release");
      expect(error.message).toContain("AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER");
      expect(helpers).toHaveLength(1);
      expect(helpers[0].stopped).toBe(true);
      expect(commandRunnerCalls).toEqual([]);
      expect(chunks).toEqual([]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("keeps actionable Screen Recording permission errors without the encode handshake", async () => {
    const { source, helpers } = createEncodedHarness();
    const started = source.start().catch((error: unknown) => error);
    await flush();
    helpers[0].emitPermission("screen-recording");
    helpers[0].emit("permissionTarget", "AutoMobile");
    helpers[0].emitStderr("error: Screen Recording permission is required.");
    expect(await started).toBeInstanceOf(ScreenRecordingPermissionError);
  });

  test("waits for the first encoded record after capability advertisement", async () => {
    const { source, helpers } = createEncodedHarness();
    let completed = false;
    const started = source.start().then(() => {
      completed = true;
    });
    await flush();
    helpers[0].emitCapability(ENCODED_VIDEO_CAPABILITY);
    await flush();
    expect(completed).toBe(false);
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;
    expect(completed).toBe(true);
    await source.stop();
  });

  test("starts when the first record arrives before the capability line", async () => {
    const { source, helpers } = createEncodedHarness();
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;
    expect(source.requestKeyFrame()).toBe(true);
    await source.stop();
  });

  test("retries a failed keyframe signal immediately and resets the throttle on restart", async () => {
    const timer = new FakeTimer();
    const { source, helpers } = createEncodedHarness({ timer });
    expect(source.requestKeyFrame()).toBe(false);
    await startEncoded(source, helpers);
    helpers[0].keyFrameRequestResult = false;
    expect(source.requestKeyFrame()).toBe(false);
    helpers[0].keyFrameRequestResult = true;
    expect(source.requestKeyFrame()).toBe(true);
    await source.stop();
    expect(source.requestKeyFrame()).toBe(false);
    const started = source.start();
    await flush();
    helpers[1].emitCapability(ENCODED_VIDEO_CAPABILITY);
    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;
    expect(source.requestKeyFrame()).toBe(true);
    await source.stop();
  });

  test("reports only native capture metrics and stops forwarding them on teardown", async () => {
    const seen: unknown[] = [];
    const { source, helpers } = createEncodedHarness({
      onFrameMetrics: (value) => seen.push(value),
    });
    expect(source.getFrameMetrics()).toEqual({ native: null });
    await startEncoded(source, helpers);
    const native: NativeFrameMetrics = {
      captureTimestampMs: 1,
      frameQueueAgeMs: 0,
      frameQueueDepth: 0,
      droppedFrames: 2,
      bytesQueued: 0,
      highWaterMarkBytes: 0,
      lastOutputWriteDurationMs: null,
    };
    helpers[0].emit("captureMetrics", native);
    expect(seen).toEqual([{ native }]);
    expect(source.getFrameMetrics()).toEqual({ native });
    expect(helpers[0].listenerCount("frameMetrics")).toBe(0);
    await source.stop();
    helpers[0].emit("captureMetrics", { ...native, droppedFrames: 3 });
    expect(seen).toEqual([{ native }]);
  });

  test("awaits a pending helper stop and drops late records and audio", async () => {
    const helper = new DelayedStopFrameCaptureHelper();
    const audio: Buffer[] = [];
    const { source, chunks } = createHarness(IOS_SIMULATOR, {
      createHelper: () => helper,
      audioEnabled: true,
      onAudioData: (chunk) => audio.push(chunk),
    });
    const started = source.start();
    await flush();
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helper.emit("audio", { pcm16le: Buffer.from([1]) });
    await started;
    const stopping = source.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    helper.emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x41]));
    helper.emit("audio", { pcm16le: Buffer.from([2]) });
    expect(chunks).toHaveLength(1);
    expect(audio).toEqual([Buffer.from([1])]);
    helper.finishStop();
    await stopping;
    expect(stopped).toBe(true);
  });
});

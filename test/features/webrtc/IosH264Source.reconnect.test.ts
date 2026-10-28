import { describe, expect, spyOn, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL,
  IOS_HELPER_STOP_TIMEOUT_MS,
  IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS,
  IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS,
  IosH264Source,
} from "../../../src/features/webrtc/IosH264Source";
import {
  IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS,
  IosSimulatorCaptureHelperPool,
} from "../../../src/features/screen-stream/IosSimulatorCaptureHelperPool";
import { logger } from "../../../src/utils/logger";
import {
  IOS_SIMULATOR,
  FAKE_HELPER_PATH,
  fakeHelperPathExists,
  FakeFrameCaptureHelper,
  encodedRecord,
  NeverStoppingFrameCaptureHelper,
  flush,
  createHarness,
  createReconnectHarness,
  successfulCommandRunner,
} from "../../helpers/iosH264SourceHarness";

describe("IosH264Source", () => {
  test("reconnects after a running-phase helper exit and resumes without onError", async () => {
    const timer = new FakeTimer();
    const { source, helpers, chunks, errors } = createReconnectHarness({ timer });

    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;
    expect(helpers).toHaveLength(1);

    // A mid-stream helper exit triggers a bounded reconnect, not a teardown.
    helpers[0].emit("exit", { code: 70, signal: null });
    await flush();
    expect(errors).toEqual([]);

    // First backoff (500ms) elapses and capture is re-established.
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    expect(helpers[1].started).toBe(true);

    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await flush();

    // The reconnected helper forwards its record without surfacing an error.
    expect(errors).toEqual([]);
    expect(chunks).toHaveLength(2);
    expect(helpers[0].stopped).toBe(true);
  });
});

describe("IosH264Source", () => {
  test("does not reconnect a helper exit after stop was requested", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({ timer });
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    const stopping = source.stop();
    helpers[0].emitExit(null, "SIGTRAP");
    await stopping;
    timer.advanceTime(5_000);
    await flush();

    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

describe("IosH264Source", () => {
  test("defers helper recovery while the relay has no viewers", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({ timer });
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    source.setHasConsumers(false);
    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(5_000);
    await flush();
    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);

    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await flush();
    expect(errors).toEqual([]);
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("fails viewerless audio startup after the first frame instead of resolving start", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      device: IOS_SIMULATOR,
      audioEnabled: true,
    });
    const started = source.start();
    await flush();
    source.setHasConsumers(false);
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    helpers[0].emitStderr("error: capture failed before audio");
    await expect(started).rejects.toThrow("capture failed before audio");
    expect(errors).toHaveLength(1);
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("fails fast for a viewerless running helper when reconnect is disabled", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      runningReconnectMaxAttempts: 0,
    });
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;
    source.setHasConsumers(false);
    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    expect(errors).toHaveLength(1);
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("defers a failed final reconnect attempt after the last viewer leaves", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      firstFrameTimeoutMs: 50,
      runningReconnectMaxAttempts: 1,
    });
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;
    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    source.setHasConsumers(false);
    timer.advanceTime(50);
    await flush();
    expect(errors).toEqual([]);
    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(3);
    helpers[2].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await flush();
    expect(errors).toEqual([]);
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("a last-viewer detach cancels an already scheduled reconnect", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({ timer });
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    source.setHasConsumers(false);
    timer.advanceTime(5_000);
    await flush();
    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);

    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("a viewer returning in the cancelled-backoff tick resumes recovery", async () => {
    const timer = new FakeTimer();
    const { source, helpers } = createReconnectHarness({ timer });
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    source.setHasConsumers(false);
    source.setHasConsumers(true);
    await flush();
    timer.advanceTime(500);
    await flush();

    expect(helpers).toHaveLength(2);
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("surfaces onError after exhausting bounded reconnect attempts", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({
      timer,
      firstFrameTimeoutMs: 50,
      runningReconnectMaxAttempts: 2,
    });

    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    helpers[0].emit("exit", { code: 70, signal: null });
    await flush();

    // Attempt 1: backoff 500ms, then the re-established helper never produces a
    // frame and times out.
    timer.advanceTime(500);
    await flush();
    expect(helpers).toHaveLength(2);
    timer.advanceTime(50);
    await flush();

    // Attempt 2: backoff 1000ms, then times out again — exhausting the budget.
    timer.advanceTime(1000);
    await flush();
    expect(helpers).toHaveLength(3);
    timer.advanceTime(50);
    await flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
  });
});

describe("IosH264Source", () => {
  test("exhausts reconnects when released helper resolution never settles", async () => {
    const timer = new FakeTimer();
    let ensures = 0;
    const { source, helpers, errors } = createReconnectHarness({
      helperPath: undefined,
      screenCaptureHelperProvider: {
        ensure: () => {
          ensures++;
          return ensures === 1 ? Promise.resolve(FAKE_HELPER_PATH) : new Promise<string>(() => {});
        },
      },
      timer,
      runningReconnectMaxAttempts: 2,
    });
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(500);
    await flush();
    timer.advanceTime(IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS);
    await flush();

    expect(ensures).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("an old helper-resolution deadline cannot tear down a restarted capture", async () => {
    const timer = new FakeTimer();
    let ensures = 0;
    const { source, helpers, chunks } = createReconnectHarness({
      timer,
      helperPath: undefined,
      screenCaptureHelperProvider: {
        ensure: () =>
          ++ensures === 1 ? new Promise<string>(() => {}) : Promise.resolve(FAKE_HELPER_PATH),
      },
    });
    const oldStart = source.start().catch((error: Error) => error);
    await flush();
    await source.stop();
    const newStart = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await newStart;

    const writes = chunks.length;

    timer.advanceTime(IOS_HELPER_PATH_RESOLUTION_TIMEOUT_MS);
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    expect(chunks).toHaveLength(writes * 2);
    expect(helpers[0].stopped).toBe(false);
    expect(await oldStart).toBeUndefined();
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("exhausts reconnects when Simulator window resolution ignores abort", async () => {
    const timer = new FakeTimer();
    let resolutions = 0;
    const { source, helpers, errors } = createReconnectHarness({
      device: IOS_SIMULATOR,
      timer,
      runningReconnectMaxAttempts: 2,
      simulatorWindowResolver: () => {
        resolutions++;
        return resolutions === 1 ? Promise.resolve(42) : new Promise<number>(() => {});
      },
    });
    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    helpers[0].emitExit(null, "SIGTRAP");
    await flush();
    timer.advanceTime(500);
    await flush();
    timer.advanceTime(IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS);
    await flush();
    timer.advanceTime(1_000);
    await flush();
    timer.advanceTime(IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS);
    await flush();

    expect(resolutions).toBe(3);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("screen-capture-helper exited");
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("times out a never-settling helper stop and exhausts reconnect attempts", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const { source, errors } = createReconnectHarness({
        timer,
        firstFrameTimeoutMs: 50,
        runningReconnectMaxAttempts: 2,
        createHelper: () => {
          const helper =
            helpers.length === 0
              ? new NeverStoppingFrameCaptureHelper()
              : new FakeFrameCaptureHelper();
          helpers.push(helper);
          return helper;
        },
      });
      const started = source.start();
      await flush();
      helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
      await started;

      helpers[0].emitExit(null, "SIGTRAP");
      await flush();
      timer.advanceTime(IOS_HELPER_STOP_TIMEOUT_MS);
      await flush();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`helper stop exceeded ${IOS_HELPER_STOP_TIMEOUT_MS}ms`),
      );
      timer.advanceTime(500);
      await flush();
      expect(helpers).toHaveLength(2);
      timer.advanceTime(50);
      await flush();
      timer.advanceTime(1_000);
      await flush();
      expect(helpers).toHaveLength(3);
      timer.advanceTime(50);
      await flush();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("screen-capture-helper exited");
      await source.stop();
    } finally {
      warning.mockRestore();
    }
  });
});

describe("IosH264Source", () => {
  test("exhausts bounded reconnects while another simulator's pooled stop stalls", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: (options) => {
        const helper =
          options.target.kind === "simulator" && options.target.windowID === 99
            ? new NeverStoppingFrameCaptureHelper()
            : new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const blocked = pool.acquire({
        binaryPath: FAKE_HELPER_PATH,
        target: {
          kind: "simulator",
          windowID: 99,
          fps: 15,
          encode: {
            codec: "h264",
            bitrate: { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL },
          },
        },
      });
      blocked.on("error", () => {});
      await blocked.start();
      const { source, errors } = createReconnectHarness({
        device: IOS_SIMULATOR,
        createHelper: undefined,
        simulatorHelperPool: pool,
        timer,
        firstFrameTimeoutMs: 50,
        runningReconnectMaxAttempts: 2,
      });
      const started = source.start();
      await flush();
      helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
      await started;

      helpers[0].emit("error", new Error("capture failed"));
      await flush();
      helpers[1].emitExit(null, "SIGTRAP");
      await flush();
      timer.advanceTime(500);
      await flush();
      expect(helpers).toHaveLength(3);

      timer.advanceTime(IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS - 500);
      await flush();
      expect(helpers).toHaveLength(4);
      timer.advanceTime(50);
      await flush();
      timer.advanceTime(1_000);
      await flush();
      expect(helpers).toHaveLength(5);
      timer.advanceTime(50);
      await flush();
      expect(helpers).toHaveLength(6);
      timer.advanceTime(50);
      await flush();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain("screen-capture-helper exited");
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`helper stop exceeded ${IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS}ms`),
      );
      await source.stop();
      await blocked.stop();
      const shutdown = pool.shutdown();
      await flush();
      timer.advanceTime(IOS_SIMULATOR_HELPER_STOP_TIMEOUT_MS);
      await shutdown;
    } finally {
      warning.mockRestore();
    }
  });
});

describe("IosH264Source", () => {
  test("a stop() during the reconnect backoff cancels the cycle", async () => {
    const timer = new FakeTimer();
    const { source, helpers, errors } = createReconnectHarness({ timer });

    const started = source.start();
    await flush();
    helpers[0].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));
    await started;

    helpers[0].emit("exit", { code: 70, signal: null });
    await flush();

    // Stop while the first backoff is still pending.
    await source.stop();

    // Advancing past the backoff must not spin up a replacement helper.
    timer.advanceTime(5_000);
    await flush();

    expect(helpers).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(helpers[0].stopped).toBe(true);
  });
});

describe("IosH264Source", () => {
  test("rejects startup when simulator capture reports missing Screen Recording permission", async () => {
    const { source, helper } = createHarness(IOS_SIMULATOR);

    const started = source.start();
    await flush();
    helper.emitStderr(
      "warn: no frames received within 2s. Grant 'Screen Recording' to your terminal/IDE.",
    );

    await expect(started).rejects.toThrow(/Screen Recording permission/);
  });
});

describe("IosH264Source", () => {
  test("rejects startup when the only simulator window does not match the requested device", async () => {
    const helper = new FakeFrameCaptureHelper();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      timer,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,

      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          return {
            stdout: JSON.stringify({
              windows: [
                {
                  windowID: 99,
                  title: "iPad Pro",
                  applicationName: "Simulator",
                  bundleIdentifier: "com.apple.iphonesimulator",
                },
              ],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          };
        }
        return successfulCommandRunner(command, args);
      },
    });

    await expect(source.start()).rejects.toThrow(
      /No visible iOS Simulator window matched iPhone 16 after \d+ lookup\(s\).*"iPad Pro"/,
    );
    expect(helper.started).toBe(false);
  });
});

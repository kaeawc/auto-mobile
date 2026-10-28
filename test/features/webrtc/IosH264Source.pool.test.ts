import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL,
  IosH264Source,
  ScreenRecordingPermissionError,
} from "../../../src/features/webrtc/IosH264Source";
import { IosSimulatorCaptureHelperPool } from "../../../src/features/screen-stream/IosSimulatorCaptureHelperPool";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "../../../src/features/webrtc/webrtcStreamingConfig";
import type { CaptureTarget } from "../../../src/features/screen-stream";
import {
  IOS_DEVICE,
  IOS_SIMULATOR,
  FAKE_HELPER_PATH,
  fakeHelperPathExists,
  FakeFrameCaptureHelper,
  encodedRecord,
  flush,
  successfulCommandRunner,
} from "../../helpers/iosH264SourceHarness";

describe("IosH264Source", () => {
  test("defers pooled helper recovery after the last viewer detaches", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const errors: Error[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      timer,
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      onError: (error) => errors.push(error),
      simulatorHelperPool: pool,

      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });
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
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("retries a silent pooled Simulator helper once without replacing the source", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,

      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));

    expect(await started).toBeNull();
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].started).toBe(true);
    await source.stop();
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("re-resolves a changed Simulator windowID before the silent-capture retry", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const helperTargets: CaptureTarget[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: (options) => {
        helperTargets.push(options.target);
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const resolvedWindowIds = [42, 99];
    let resolveCalls = 0;
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,

      simulatorWindowResolver: async () => resolvedWindowIds[resolveCalls++] ?? 99,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));

    expect(await started).toBeNull();
    // First attempt targeted the initially-resolved window; the retry re-resolved
    // to the recreated window's new CGWindowID rather than reusing the stale one.
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
      {
        kind: "simulator",
        windowID: 99,
        fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT,
        encode: {
          codec: "h264",
          bitrate: { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL },
        },
      },
    ]);
    expect(resolveCalls).toBe(2);
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].started).toBe(true);
    await source.stop();
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("retries with the same windowID when the Simulator window is unchanged", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const helperTargets: CaptureTarget[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: (options) => {
        helperTargets.push(options.target);
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    let resolveCalls = 0;
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,

      simulatorWindowResolver: async () => {
        resolveCalls++;
        return 42;
      },
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitEncodedVideo(encodedRecord([0, 0, 0, 1, 0x65]));

    expect(await started).toBeNull();
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
    // Re-resolution happens once on retry; the unchanged id preserves prior behavior.
    expect(resolveCalls).toBe(2);
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].started).toBe(true);
    await source.stop();
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("reports a typed Screen Recording denial after a second legacy no-frame warning", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
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

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    helpers[0].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE.",
    );
    await flush();

    expect(helpers).toHaveLength(2);
    helpers[1].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE.",
    );

    const error = await started;
    expect(error).toBeInstanceOf(ScreenRecordingPermissionError);
    expect(error?.message).toBe(
      "Screen Recording permission is required to discover and observe iOS Simulator windows.",
    );
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].stopped).toBe(true);
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("fails closed when warning-triggered silent-helper cleanup fails", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
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

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    helpers[0].stopError = new Error("helper stop failed");
    helpers[0].emitStderr(
      "warn: no frames received within 10s. Grant 'Screen Recording' to your terminal/IDE.",
    );

    try {
      await flush();

      expect(helpers).toHaveLength(1);
      const error = await started;
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toBe(
        "Failed to invalidate silent iOS Simulator capture: helper stop failed",
      );
    } finally {
      await source.stop();
      await pool.shutdown();
    }
  });
});

describe("IosH264Source", () => {
  test("evicts a second timed-out pooled Simulator helper before a later lease", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,

      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);
    await flush();
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(helpers).toHaveLength(2);
    expect(helpers[0].stopped).toBe(true);
    expect(helpers[1].stopped).toBe(true);

    const replacement = pool.acquire({
      binaryPath: FAKE_HELPER_PATH,
      target: {
        kind: "simulator",
        windowID: 42,
        fps: WEBRTC_IOS_SIMULATOR_FPS_DEFAULT,
        encode: {
          codec: "h264",
          bitrate: { kind: "bitsPerPixel", bpp: IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL },
        },
      },
    });
    await replacement.start();

    expect(helpers).toHaveLength(3);
    await replacement.stop();
    await source.stop();
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("does not retry a pooled Simulator timeout after the source stops", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,

      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start();
    await flush();
    timer.advanceTime(1);
    await source.stop();
    timer.advanceTime(1);

    await expect(started).resolves.toBeUndefined();
    expect(helpers).toHaveLength(1);
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("fails instead of retrying when invalidating a silent pooled Simulator helper fails", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
    });
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      firstFrameTimeoutMs: 1,
      simulatorHelperPool: pool,

      simulatorWindowResolver: async () => 42,
      commandRunner: successfulCommandRunner,
      timer,
    });

    const started = source.start();
    await flush();
    helpers[0].stopError = new Error("helper stop failed");
    timer.advanceTime(1);

    await expect(started).rejects.toThrow(
      "Failed to invalidate silent iOS Simulator capture: helper stop failed",
    );
    expect(helpers).toHaveLength(1);
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("classifies the released helper's Screen Recording denial from a pooled Simulator helper", async () => {
    const helpers: FakeFrameCaptureHelper[] = [];
    const pool = new IosSimulatorCaptureHelperPool({
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },
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

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    helpers[0].emitPermission("screen-recording");
    helpers[0].emit("permissionTarget", "Custom Capture Helper");
    helpers[0].emitStderr(
      "error: Screen Recording permission is required. Grant Screen Recording to your terminal/IDE.",
    );

    const error = await started;
    expect(error).toBeInstanceOf(ScreenRecordingPermissionError);
    expect(error?.message).toBe(
      "Screen Recording permission is required to discover and observe iOS Simulator windows.",
    );
    expect((error as ScreenRecordingPermissionError | null)?.approvalTarget).toBe(
      "Custom Capture Helper",
    );
    expect(helpers).toHaveLength(1);
    expect(helpers[0].stopped).toBe(true);
    await pool.shutdown();
  });
});

describe("IosH264Source", () => {
  test("does not retry a silent physical-device helper", async () => {
    const timer = new FakeTimer();
    const helpers: FakeFrameCaptureHelper[] = [];
    const source = new IosH264Source({
      device: IOS_DEVICE,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      firstFrameTimeoutMs: 1,
      timer,
      onData: () => {},
      createHelper: () => {
        const helper = new FakeFrameCaptureHelper();
        helpers.push(helper);
        return helper;
      },

      commandRunner: successfulCommandRunner,
    });

    const started = source.start().then(
      () => null,
      (error) => error as Error,
    );
    await flush();
    timer.advanceTime(1);

    const error = await started;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("iOS screen capture did not produce a first frame.");
    expect(helpers).toHaveLength(1);
    expect(helpers[0].stopped).toBe(true);
  });
});

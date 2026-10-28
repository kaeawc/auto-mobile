import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  IOS_SCREEN_CAPTURE_HELPER_ENV,
  IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS,
  IOS_WEBRTC_DEFAULT_BITS_PER_PIXEL,
  IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS,
  IOS_SIMULATOR_WINDOW_POLL_INTERVAL_MS,
  IosH264Source,
  resolveIosScreenCaptureHelperPath,
} from "../../../src/features/webrtc/IosH264Source";
import { WEBRTC_IOS_SIMULATOR_FPS_DEFAULT } from "../../../src/features/webrtc/webrtcStreamingConfig";
import {
  IOS_SIMULATOR,
  FAKE_HELPER_PATH,
  fakeHelperPathExists,
  FakeFrameCaptureHelper,
  encodedRecord,
  startWithRecord,
  createResolverHarness,
  successfulCommandRunner,
} from "../../helpers/iosH264SourceHarness";

describe("IosH264Source", () => {
  test("polls for the Simulator window until it becomes discoverable (#12708)", async () => {
    const helper = new FakeFrameCaptureHelper();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let lookups = 0;
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      timer,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,
      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          lookups += 1;
          const windows =
            lookups < 3
              ? []
              : [
                  {
                    windowID: 42,
                    title: IOS_SIMULATOR.name,
                    applicationName: "Simulator",
                    bundleIdentifier: "com.apple.iphonesimulator",
                  },
                ];
          return { stdout: JSON.stringify({ windows }), stderr: "", exitCode: 0, signal: null };
        }
        return successfulCommandRunner(command, args);
      },
    });

    const started = source.start();
    await started.catch(() => undefined);
    expect(lookups).toBe(3);
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("polls for the Simulator window across the whole resolution timeout (#13066)", async () => {
    const LOOKUP_LATENCY_MS = 100;
    const helper = new FakeFrameCaptureHelper();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    let lookups = 0;
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      timer,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,
      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          lookups += 1;
          timer.advanceTime(LOOKUP_LATENCY_MS);
          return { stdout: JSON.stringify({ windows: [] }), stderr: "", exitCode: 0, signal: null };
        }
        return successfulCommandRunner(command, args);
      },
    });

    await source.start().catch(() => undefined);

    // Lookups start every (latency + interval) while the next sleep still fits the timeout.
    const period = LOOKUP_LATENCY_MS + IOS_SIMULATOR_WINDOW_POLL_INTERVAL_MS;
    expect(lookups).toBe(Math.ceil(IOS_SIMULATOR_TARGET_RESOLUTION_TIMEOUT_MS / period));
    await source.stop();
  });
});

describe("IosH264Source", () => {
  test("rejects audio startup before spawning the helper when multiple Simulator windows are visible", async () => {
    const helper = new FakeFrameCaptureHelper();
    const source = new IosH264Source({
      device: IOS_SIMULATOR,
      audioEnabled: true,
      helperPath: FAKE_HELPER_PATH,
      helperPathExists: fakeHelperPathExists,
      onData: () => {},
      createHelper: () => helper,

      commandRunner: async (command, args) => {
        if (command === FAKE_HELPER_PATH && args.includes("--list-simulators")) {
          return {
            stdout: JSON.stringify({
              windows: [
                { windowID: 42, title: "iPhone 16", applicationName: "Simulator" },
                { windowID: 99, title: "iPad Pro", applicationName: "Simulator" },
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

    await expect(source.start()).rejects.toThrow(/exactly one visible Simulator window/);
    expect(helper.started).toBe(false);
  });
});

describe("IosH264Source", () => {
  test("prefers an exact device-name window over an overlapping substring window", async () => {
    // "iPhone 15" is a substring of the "iPhone 15 Pro" title, so a pure
    // substring match would flag both windows and fail the many-match guard.
    const { source, helper, helperTargets } = createResolverHarness("iPhone 15", [
      { windowID: 42, title: "iPhone 15" },
      { windowID: 99, title: "iPhone 15 Pro" },
    ]);

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
  test("matches the exact device even when the title appends a runtime segment", async () => {
    const { source, helper, helperTargets } = createResolverHarness("iPhone 15", [
      { windowID: 7, title: "iPhone 15 — 17.0" },
      { windowID: 8, title: "iPhone 15 Pro — 17.0" },
    ]);

    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));

    expect(helperTargets).toEqual([
      {
        kind: "simulator",
        windowID: 7,
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
  test("falls back to a substring match when no title names the device exactly", async () => {
    const { source, helper, helperTargets } = createResolverHarness("iPhone 15", [
      { windowID: 5, title: "Simulator - iPhone 15 (Booted)" },
    ]);

    await startWithRecord(source, helper, encodedRecord([0, 0, 0, 1, 0x65]));

    expect(helperTargets).toEqual([
      {
        kind: "simulator",
        windowID: 5,
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
  test("still rejects when two windows name the same device exactly", async () => {
    const { source, helper } = createResolverHarness("iPhone 15", [
      { windowID: 1, title: "iPhone 15" },
      { windowID: 2, title: "iPhone 15" },
    ]);

    await expect(source.start()).rejects.toThrow(
      /Multiple iOS Simulator windows matched iPhone 15/,
    );
    expect(helper.started).toBe(false);
  });
});

describe("IosH264Source", () => {
  test("requires an explicit local helper path instead of searching source or package builds", () => {
    expect(() =>
      resolveIosScreenCaptureHelperPath(undefined, {
        env: {},
        exists: () => false,
      }),
    ).toThrow(/No executable screen-capture-helper/);
  });
});

describe("IosH264Source", () => {
  test("uses an explicit local development helper path", () => {
    const found = resolveIosScreenCaptureHelperPath(
      "/repo/ios/screen-capture/.build/release/screen-capture-helper",
      {
        env: {},
        exists: (candidate) => candidate.includes(".build/release"),
      },
    );

    expect(found).toBe("/repo/ios/screen-capture/.build/release/screen-capture-helper");
  });
});

describe("IosH264Source", () => {
  test("prefers the helper path environment override", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV]: "/custom/helper" },
      exists: (candidate) => candidate === "/custom/helper",
    });

    expect(found).toBe("/custom/helper");
  });
});

describe("IosH264Source", () => {
  test("uses legacy helper path environment alias when preferred name is unset", () => {
    const found = resolveIosScreenCaptureHelperPath(undefined, {
      env: { [IOS_SCREEN_CAPTURE_HELPER_ENV_ALIAS]: "/legacy/helper" },
      exists: (candidate) => candidate === "/legacy/helper",
    });

    expect(found).toBe("/legacy/helper");
  });
});

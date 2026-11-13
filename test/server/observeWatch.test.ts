import { FakeWatchRunnerClient } from "../fakes/FakeWatchRunnerClient";
import { FakeTvosRunnerClient } from "../fakes/FakeTvosRunnerClient";
import { tvosRunners } from "../../src/features/tvos/TvosRunnerRegistry";
import { WatchRunnerError } from "../../src/features/watch/WatchRunnerError";
import { watchRunners } from "../../src/features/watch/WatchRunnerRegistry";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../src/features/observe/ScreenshotRetention";
import { ActionableError, type BootedDevice } from "../../src/models";
import {
  WATCH_HIERARCHY_UNAVAILABLE_MESSAGE,
  WATCH_APP_NOT_FOREGROUND_MESSAGE,
  watchAppNotRunningMessage,
  TVOS_HIERARCHY_UNAVAILABLE_MESSAGE,
  isWatchObservation,
  type WatchObservation,
} from "../../src/models/WatchObservation";
import { getStructuredPayload } from "../../src/utils/toolUtils";
import type { ObserveArgs } from "../../src/server/observeTools";
import {
  defaultWatchScreenshotSource,
  observeWatch,
  simctlWatchScreenshotSource,
  type WatchObserveDependencies,
  type WatchScreenshotSource,
} from "../../src/server/observeWatch";
import { observeToolResultSchema } from "../../src/server/toolOutputSchemas";
import type { WatchTargetAppProbe } from "../../src/features/watch/WatchTargetAppProbe";
import { CountingIdGenerator } from "../../src/utils/CountingIdGenerator";
import { FakeScreenshotFileWriter } from "../fakes/FakeScreenshotFileWriter";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../fakes/FakeTimer";

const watch: BootedDevice = {
  name: "Apple Watch Series 10 (46mm)",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  platform: "watchos",
};
const CACHE_DIR = "/cache/screenshots";
const NOW = 1_700_000_000_000;

/** A PNG signature and IHDR chunk header: enough for header-only size detection. */
function pngOfSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

class FakeWatchScreenshotSource implements WatchScreenshotSource {
  readonly captures: string[] = [];
  constructor(private readonly result: Buffer | Error = pngOfSize(416, 496)) {}
  async capture(device: BootedDevice, display: string): Promise<Buffer> {
    this.captures.push(`${device.deviceId} ${display}`);
    if (this.result instanceof Error) {
      throw this.result;
    }
    return this.result;
  }
}

function arrange(
  result?: Buffer | Error,
  runner?: FakeWatchRunnerClient,
  dependencies: WatchObserveDependencies = {},
) {
  const timer = new FakeTimer();
  timer.setCurrentTime(NOW);
  const screenshots = new FakeWatchScreenshotSource(result);
  const writer = new FakeScreenshotFileWriter();
  const protection = new FakeScreenshotPathProtection(timer);
  const observe = (args: ObserveArgs = {}, device: BootedDevice = watch, signal?: AbortSignal) =>
    observeWatch(device, args, signal, {
      screenshots,
      runner,
      visionosRunnerTargets: { targetBundleId: () => "com.example.visionos" },
      timer,
      idGenerator: new CountingIdGenerator("watch"),
      fileWriter: writer,
      pathProtection: protection,
      cacheDir: () => CACHE_DIR,
      ...dependencies,
    });
  return { observe, screenshots, writer, protection, timer };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const HIERARCHY_FIELDS = [
  "viewHierarchy",
  "skeleton",
  "context",
  "elements",
  "selectedElements",
  "focusedElement",
  "accessibilityFocusedElement",
  "activeWindow",
  "screenIdentity",
  "truncationReasons",
  "windowTruncations",
  "layoutWarnings",
  "snapshotReference",
  "systemInsets",
];

describe("observe on an Apple Watch simulator (#14910)", () => {
  test("returns a retained simctl screenshot with the PNG's screen size", async () => {
    const { observe, screenshots, writer, protection } = arrange();

    const response = await observe();
    const result = getStructuredPayload<WatchObservation>(response)!;

    expect(screenshots.captures).toEqual([`${watch.deviceId} main`]);
    expect(writer.written).toEqual([result.screenshotPath!]);
    expect(protection.calls).toContain(result.screenshotPath!);
    expect(result).toMatchObject({
      observationId: "watch-1",
      deviceId: watch.deviceId,
      display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
      updatedAt: NOW,
      screenSize: { width: 416, height: 496, units: "physical-pixels" },
      screenshotImageSize: { width: 416, height: 496 },
      screenshotFormat: "png",
      screenshotMimeType: "image/png",
      screenshotSource: "fresh",
      screenshotExpiresAt: NOW + SCREENSHOT_PATH_MIN_LIFETIME_MS,
    });
    expect(result.screenshotPath).toStartWith(path.join(CACHE_DIR, `screenshot_${NOW}_`));
    expect(result.screenshotPath).toEndWith("_watch-2.png");
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  });

  test("says the hierarchy is unavailable and leaves every hierarchy field absent", async () => {
    const { observe } = arrange();

    const response = await observe();
    const result: Record<string, unknown> = getStructuredPayload(response)!;

    expect(result.hierarchyUnavailable).toEqual({
      platform: "watchos",
      message: WATCH_HIERARCHY_UNAVAILABLE_MESSAGE,
    });
    expect(HIERARCHY_FIELDS.filter((field) => Object.hasOwn(result, field))).toEqual([]);
    expect(
      JSON.parse(response.content[0]!.type === "text" ? response.content[0]!.text : "{}"),
    ).toMatchObject({ hierarchyUnavailable: { platform: "watchos" } });
  });

  test("captures and reports the watch's own panel when discovery lists one", async () => {
    const { observe, screenshots } = arrange();
    const paneled: BootedDevice = {
      ...watch,
      displays: {
        panels: [{ key: "Watch Display", role: "unknown", sizePx: { width: 416, height: 496 } }],
        postures: ["unknown"],
      },
    };

    const response = await observe({ display: "Watch Display" }, paneled);

    expect(screenshots.captures).toEqual([`${watch.deviceId} Watch Display`]);
    expect(getStructuredPayload<WatchObservation>(response)?.display.key).toBe("Watch Display");
  });

  test("accepts the active display and the settled or async screenshot modes", async () => {
    const { observe, screenshots } = arrange();

    await observe({ display: "active", screenshot: "settled" });
    await observe({ display: "0", screenshot: "async", raw: false });

    expect(screenshots.captures).toHaveLength(2);
  });

  const refusals: Array<[string, ObserveArgs]> = [
    ["waitFor", { waitFor: { text: "Start" } }],
    ["settled", { settled: { quietPeriodMs: 100 } }],
    ["raw", { raw: true }],
    ["includeExtras", { includeExtras: true }],
    ["project", { project: "skeleton" }],
    ["scope", { scope: { overview: true } }],
    ["layer", { layer: "app" }],
    ["skipBackStack", { skipBackStack: true }],
    ["crop", { crop: { rect: { x: 0, y: 0, width: 10, height: 10 } } }],
    ["screenshotOptions", { screenshotOptions: { format: "jpeg" } }],
    ['screenshot: "none"', { screenshot: "none" }],
    ['display: "all"', { display: "all" }],
    ['display: "cover"', { display: "cover" }],
  ];

  test.each(refusals)("refuses %s by name before capturing", async (name, args) => {
    const { observe, screenshots } = arrange();

    const error = await failure(observe(args));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`does not support: ${name}`);
    expect(screenshots.captures).toEqual([]);
  });

  test.each(refusals)("tvOS refuses %s by name before capturing", async (name, args) => {
    const { observe, screenshots } = arrange();
    const error = await failure(observe(args, { ...watch, platform: "tvos" }));
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`does not support: ${name}`);
    expect(screenshots.captures).toEqual([]);
  });

  test("names every refused option at once", async () => {
    const { observe } = arrange();

    const error = await failure(observe({ raw: true, project: "full", display: "all" }));

    expect(String(error)).toContain('does not support: raw, project, display: "all"');
  });

  test("a simctl capture failure is an ActionableError and stores nothing", async () => {
    const { observe, writer } = arrange(new Error("simctl io screenshot exited 1"));

    const error = await failure(observe());

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(`Failed to capture a screenshot of watch simulator`);
    expect(String(error)).toContain("simctl io screenshot exited 1");
    expect(writer.written).toEqual([]);
  });

  test("a call cancelled while the screenshot is captured stores nothing", async () => {
    const { observe, screenshots, writer, protection } = arrange();
    const controller = new AbortController();
    const capture = screenshots.capture.bind(screenshots);
    screenshots.capture = async (device, display) => {
      const png = await capture(device, display);
      controller.abort(new Error("caller cancelled"));
      return png;
    };

    const error = await failure(observe({}, watch, controller.signal));

    expect(String(error)).toContain("caller cancelled");
    expect(writer.written).toEqual([]);
    expect(protection.calls).toEqual([]);
  });

  test("bytes that are not a PNG are refused instead of guessing a screen size", async () => {
    const { observe, writer } = arrange(Buffer.from("not an image"));

    const error = await failure(observe());

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("simctl returned no readable PNG");
    expect(writer.written).toEqual([]);
  });
});

test("connected watch hierarchy keeps the screenshot and uses XCTest point dimensions", async () => {
  const runner = new FakeWatchRunnerClient();
  const { observe, screenshots } = arrange(undefined, runner);
  const result = getStructuredPayload<import("../../src/models").ObserveResult>(await observe())!;
  expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  expect(result.viewHierarchy?.screenWidth).toBe(184);
  expect(result.screenSize).toEqual({ width: 184, height: 224, units: "points" });
  expect(result.screenshotImageSize).toEqual({ width: 416, height: 496 });
  expect(result.screenshotPath).toBeDefined();
  expect(result).not.toHaveProperty("hierarchyUnavailable");
  expect(result).not.toHaveProperty("hierarchyBundleId");
  expect(runner.commands).toEqual([{ type: "hierarchy" }]);
  expect(screenshots.captures).toHaveLength(1);
});

test("a connected runner failure surfaces instead of becoming a screenshot-only success", async () => {
  const runner = new FakeWatchRunnerClient();
  runner.failure = new ActionableError("runner disconnected");
  const { observe, screenshots } = arrange(undefined, runner);
  await expect(observe()).rejects.toThrow("runner disconnected");
  expect(screenshots.captures).toEqual([]);
});

test("a backgrounded watch app returns actionable screenshot-only guidance", async () => {
  const runner = new FakeWatchRunnerClient();
  runner.failure = new WatchRunnerError("Watch app is not in the foreground", "app_not_foreground");
  const { observe, screenshots } = arrange(undefined, runner);

  const result = getStructuredPayload<WatchObservation>(await observe())!;

  expect(result.hierarchyUnavailable).toEqual({
    platform: "watchos",
    message: WATCH_APP_NOT_FOREGROUND_MESSAGE,
  });
  expect(HIERARCHY_FIELDS.filter((field) => Object.hasOwn(result, field))).toEqual([]);
  expect(result.screenshotPath).toBeDefined();
  expect(screenshots.captures).toHaveLength(1);
  expect(observeToolResultSchema.safeParse(result).success).toBe(true);
});

class FakeWatchTargetAppProbe implements WatchTargetAppProbe {
  calls = 0;
  constructor(private readonly notRunning: string | undefined) {}
  async notRunningTarget(): Promise<string | undefined> {
    this.calls++;
    return this.notRunning;
  }
}

const CRASHED_APP = "dev.dogfood.factorywatch";

test("a crashed watch app is reported as not running (#18052)", async () => {
  const runner = new FakeWatchRunnerClient();
  runner.failure = new WatchRunnerError("Watch app is not in the foreground", "app_not_foreground");
  const probe = new FakeWatchTargetAppProbe(CRASHED_APP);
  const { observe } = arrange(undefined, runner, { watchTargetApp: probe });

  const result = getStructuredPayload<WatchObservation>(await observe())!;

  expect(result.hierarchyUnavailable).toEqual({
    platform: "watchos",
    message: watchAppNotRunningMessage(CRASHED_APP),
    appNotRunning: { bundleId: CRASHED_APP },
  });
  expect(HIERARCHY_FIELDS.filter((field) => Object.hasOwn(result, field))).toEqual([]);
  expect(result.screenshotPath).toBeDefined();
  expect(observeToolResultSchema.safeParse(result).success).toBe(true);
});

test("an empty runner tree after a crash is replaced by the not-running note (#18052)", async () => {
  const runner = new FakeWatchRunnerClient({
    timestamp: NOW,
    screenScale: 1,
    screenWidth: 208,
    screenHeight: 248,
    root: { className: "XCUIElementType(2)", bounds: { left: 0, top: 0, right: 208, bottom: 248 } },
  });
  const probe = new FakeWatchTargetAppProbe(CRASHED_APP);
  const { observe } = arrange(undefined, runner, { watchTargetApp: probe });

  const result = getStructuredPayload<WatchObservation>(await observe())!;

  expect(result.hierarchyUnavailable?.appNotRunning).toEqual({ bundleId: CRASHED_APP });
  expect(HIERARCHY_FIELDS.filter((field) => Object.hasOwn(result, field))).toEqual([]);
  expect(probe.calls).toBe(1);
});

test("a running app with a hierarchy never probes its process", async () => {
  const probe = new FakeWatchTargetAppProbe(CRASHED_APP);
  const { observe } = arrange(undefined, new FakeWatchRunnerClient(), { watchTargetApp: probe });

  const result = getStructuredPayload(await observe())!;

  expect(result).toHaveProperty("viewHierarchy");
  expect(probe.calls).toBe(0);
});

test("a backgrounded app that still runs keeps the foreground guidance", async () => {
  const runner = new FakeWatchRunnerClient();
  runner.failure = new WatchRunnerError("Watch app is not in the foreground", "app_not_foreground");
  const probe = new FakeWatchTargetAppProbe(undefined);
  const { observe } = arrange(undefined, runner, { watchTargetApp: probe });

  const result = getStructuredPayload<WatchObservation>(await observe())!;

  expect(result.hierarchyUnavailable).toEqual({
    platform: "watchos",
    message: WATCH_APP_NOT_FOREGROUND_MESSAGE,
  });
  expect(probe.calls).toBe(1);
});

test.each([false, true])(
  "waitFor timeout reports the last backgrounded read (first read has hierarchy: %s)",
  async (firstHasHierarchy) => {
    const runner = new FakeWatchRunnerClient();
    const hierarchy = runner.hierarchy.bind(runner);
    let reads = 0;
    runner.hierarchy = (signal) => {
      runner.failure =
        reads++ === 0 && firstHasHierarchy
          ? undefined
          : new WatchRunnerError("Watch app is not in the foreground", "app_not_foreground");
      return hierarchy(signal);
    };
    const { observe, timer } = arrange(undefined, runner);
    timer.enableAutoAdvance();

    const response = await observe({ waitFor: { text: "Missing element", timeout: 200 } });
    const result = getStructuredPayload<WatchObservation>(response)!;

    expect(response.isError).toBe(true);
    expect(result).toMatchObject({ timedOut: true, matched: false, polls: 3 });
    expect(result.hierarchyUnavailable).toEqual({
      platform: "watchos",
      message: WATCH_APP_NOT_FOREGROUND_MESSAGE,
    });
    expect(HIERARCHY_FIELDS.filter((field) => Object.hasOwn(result, field))).toEqual([]);
    expect(reads).toBe(3);
  },
);

test("waitFor can match a hierarchy after a backgrounded read", async () => {
  const runner = new FakeWatchRunnerClient();
  const hierarchy = runner.hierarchy.bind(runner);
  let reads = 0;
  runner.hierarchy = (signal) => {
    runner.failure =
      reads++ === 0
        ? new WatchRunnerError("Watch app is not in the foreground", "app_not_foreground")
        : undefined;
    return hierarchy(signal);
  };
  const { observe, timer } = arrange(undefined, runner);
  timer.enableAutoAdvance();

  const result = getStructuredPayload(
    await observe({ waitFor: { text: "CtrlProxy Watch", timeout: 200 } }),
  )!;

  expect(result).toMatchObject({ matched: true, timedOut: false, polls: 2 });
  expect(result).toHaveProperty("viewHierarchy");
  expect(result).not.toHaveProperty("hierarchyUnavailable");
  expect(reads).toBe(2);
});

const appleTv: BootedDevice = { ...watch, platform: "tvos", name: "Apple TV 4K" };
test.each(["injected", "registered"] as const)(
  "tvOS ignores an %s watch runner and still refuses hierarchy options",
  async (source) => {
    const runner = new FakeWatchRunnerClient();
    runner.failure = new Error("tvOS must not contact the watch runner");
    const unregister =
      source === "registered" ? watchRunners.register(appleTv.deviceId, runner) : undefined;
    try {
      const { observe, screenshots } = arrange(
        undefined,
        source === "injected" ? runner : undefined,
      );
      const result = getStructuredPayload<WatchObservation>(await observe({}, appleTv))!;
      expect(result.hierarchyUnavailable.platform).toBe("tvos");
      expect(HIERARCHY_FIELDS.filter((field) => Object.hasOwn(result, field))).toEqual([]);
      expect(screenshots.captures).toEqual([`${appleTv.deviceId} undefined`]);
      await expect(observe({ project: "full" }, appleTv)).rejects.toThrow(
        "does not support: project",
      );
      expect(screenshots.captures).toHaveLength(1);
      expect(runner.commands).toEqual([]);
    } finally {
      unregister?.();
    }
  },
);

describe("observe on an Apple TV simulator", () => {
  test("recovers a disconnected runner once and uses its hierarchy and screenshot", async () => {
    const disconnected = new FakeTvosRunnerClient();
    disconnected.close();
    const recovered = new FakeTvosRunnerClient();
    recovered.screenshotData = pngOfSize(1920, 1080).toString("base64");
    let unregister = tvosRunners.register(appleTv.deviceId, disconnected);
    const restarts: string[] = [];
    const { observe, screenshots } = arrange(undefined, undefined, {
      screenshots: undefined,
      tvosRunnerLifecycle: {
        ownsRunner: () => true,
        async restartOwned(deviceId, signal) {
          signal?.throwIfAborted();
          restarts.push(deviceId);
          unregister();
          unregister = tvosRunners.register(deviceId, recovered);
          return {};
        },
      },
    });
    try {
      expect(defaultWatchScreenshotSource(appleTv)).toBe(simctlWatchScreenshotSource);
      for (let read = 0; read < 2; read++) {
        const result = getStructuredPayload(await observe({}, appleTv))!;
        expect(result).toHaveProperty("viewHierarchy");
        expect(result).not.toHaveProperty("hierarchyUnavailable");
        expect(result.screenshotImageSize).toEqual({ width: 1920, height: 1080 });
      }
      expect(restarts).toEqual([appleTv.deviceId]);
      expect(disconnected.commands).toEqual([]);
      expect(recovered.commands).toEqual([
        { type: "request_hierarchy" },
        { type: "request_screenshot" },
        { type: "request_hierarchy" },
        { type: "request_screenshot" },
      ]);
      expect(screenshots.captures).toEqual([]);
    } finally {
      unregister();
    }
  });

  test("failed runner recovery returns a screenshot and startDevice guidance", async () => {
    const disconnected = new FakeTvosRunnerClient();
    disconnected.close();
    const unregister = tvosRunners.register(appleTv.deviceId, disconnected);
    const restarts: string[] = [];
    const { observe, screenshots } = arrange(undefined, undefined, {
      tvosRunnerLifecycle: {
        ownsRunner: () => true,
        async restartOwned(deviceId) {
          restarts.push(deviceId);
          return { runnerUnavailable: "replacement runner could not connect" };
        },
      },
    });
    try {
      const result = getStructuredPayload<WatchObservation>(await observe({}, appleTv))!;
      expect(result.hierarchyUnavailable.message).toContain("replacement runner could not connect");
      expect(result.hierarchyUnavailable.message).toContain("Call startDevice");
      expect(result).not.toHaveProperty("viewHierarchy");
      expect(restarts).toEqual([appleTv.deviceId]);
      expect(disconnected.commands).toEqual([]);
      expect(screenshots.captures).toEqual([`${appleTv.deviceId} undefined`]);
    } finally {
      unregister();
    }
  });

  test("restarts an owned runner whose exited xcodebuild unregistered its client", async () => {
    const recovered = new FakeTvosRunnerClient();
    recovered.screenshotData = pngOfSize(1920, 1080).toString("base64");
    let unregister: (() => void) | undefined;
    const restarts: string[] = [];
    const { observe, screenshots } = arrange(undefined, undefined, {
      screenshots: undefined,
      tvosRunnerLifecycle: {
        ownsRunner: (deviceId) => deviceId === appleTv.deviceId,
        async restartOwned(deviceId) {
          restarts.push(deviceId);
          unregister = tvosRunners.register(deviceId, recovered);
          return {};
        },
      },
    });
    try {
      expect(tvosRunners.get(appleTv.deviceId)).toBeUndefined();
      const result = getStructuredPayload(await observe({}, appleTv))!;
      expect(result).toHaveProperty("viewHierarchy");
      expect(result).not.toHaveProperty("hierarchyUnavailable");
      expect(restarts).toEqual([appleTv.deviceId]);
      expect(recovered.commands).toEqual([
        { type: "request_hierarchy" },
        { type: "request_screenshot" },
      ]);
      expect(screenshots.captures).toEqual([]);
    } finally {
      unregister?.();
    }
  });

  test("a device that never owned a runner stays screenshot-only without recovery", async () => {
    const restarts: string[] = [];
    const { observe, screenshots } = arrange(pngOfSize(1920, 1080), undefined, {
      tvosRunnerLifecycle: {
        ownsRunner: () => false,
        async restartOwned(deviceId) {
          restarts.push(deviceId);
          return {};
        },
      },
    });
    const result = getStructuredPayload<WatchObservation>(await observe({}, appleTv))!;
    expect(result).not.toHaveProperty("viewHierarchy");
    expect(restarts).toEqual([]);
    expect(screenshots.captures).toEqual([`${appleTv.deviceId} undefined`]);
  });

  test("a usable tvOS runner returns hierarchy without recovery", async () => {
    const runner = new FakeTvosRunnerClient();
    const unregister = tvosRunners.register(appleTv.deviceId, runner);
    const restarts: string[] = [];
    const { observe } = arrange(undefined, undefined, {
      tvosRunnerLifecycle: {
        ownsRunner: () => true,
        async restartOwned(deviceId) {
          restarts.push(deviceId);
          return {};
        },
      },
    });
    try {
      const result = getStructuredPayload(await observe({}, appleTv))!;
      expect(result).toHaveProperty("viewHierarchy");
      expect(result).not.toHaveProperty("hierarchyUnavailable");
      expect(restarts).toEqual([]);
      expect(runner.commands).toEqual([{ type: "request_hierarchy" }]);
    } finally {
      unregister();
    }
  });

  test("returns a retained PNG with tvOS metadata and no hierarchy fields", async () => {
    const { observe, writer } = arrange(pngOfSize(1920, 1080));
    const result = getStructuredPayload<WatchObservation>(await observe({}, appleTv))!;
    expect(result.hierarchyUnavailable.platform).toBe("tvos");
    expect(result.hierarchyUnavailable.message).toBe(TVOS_HIERARCHY_UNAVAILABLE_MESSAGE);
    expect(result.screenSize).toEqual({ width: 1920, height: 1080, units: "physical-pixels" });
    expect(result.screenshotMimeType).toBe("image/png");
    expect(writer.written).toEqual([result.screenshotPath!]);
    expect(HIERARCHY_FIELDS.filter((field) => Object.hasOwn(result, field))).toEqual([]);
    expect(isWatchObservation(result)).toBe(true);
    expect(observeToolResultSchema.safeParse(result).success).toBe(true);
  });
  test("a tvOS capture failure is actionable and stores nothing", async () => {
    const { observe, writer } = arrange(new Error("simctl failed"));
    const error = await failure(observe({}, appleTv));
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("tvOS simulator");
    expect(writer.written).toEqual([]);
  });
});

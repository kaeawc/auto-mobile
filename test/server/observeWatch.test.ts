import { FakeWatchRunnerClient } from "../fakes/FakeWatchRunnerClient";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../src/features/observe/ScreenshotRetention";
import { ActionableError, type BootedDevice } from "../../src/models";
import {
  WATCH_HIERARCHY_UNAVAILABLE_MESSAGE,
  type WatchObservation,
} from "../../src/models/WatchObservation";
import { getStructuredPayload } from "../../src/utils/toolUtils";
import type { ObserveArgs } from "../../src/server/observeTools";
import { observeWatch, type WatchScreenshotSource } from "../../src/server/observeWatch";
import { observeToolResultSchema } from "../../src/server/toolOutputSchemas";
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

function arrange(result?: Buffer | Error, runner?: FakeWatchRunnerClient) {
  const timer = new FakeTimer();
  timer.setCurrentTime(NOW);
  const screenshots = new FakeWatchScreenshotSource(result);
  const writer = new FakeScreenshotFileWriter();
  const protection = new FakeScreenshotPathProtection(timer);
  const observe = (args: ObserveArgs = {}, device: BootedDevice = watch, signal?: AbortSignal) =>
    observeWatch(device, args, signal, {
      screenshots,
      runner,
      timer,
      idGenerator: new CountingIdGenerator("watch"),
      fileWriter: writer,
      pathProtection: protection,
      cacheDir: () => CACHE_DIR,
    });
  return { observe, screenshots, writer, protection };
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
  expect(result.viewHierarchy?.screenWidth).toBe(208);
  expect(result.screenSize).toEqual({ width: 208, height: 248, units: "points" });
  expect(result.screenshotImageSize).toEqual({ width: 416, height: 496 });
  expect(result.screenshotPath).toBeDefined();
  expect(result).not.toHaveProperty("hierarchyUnavailable");
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

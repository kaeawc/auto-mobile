import { FakeFileSystem } from "../fakes/FakeFileSystem";
import {
  BoundedScreenshotPathProtection,
  ScreenshotRetentionCapacityError,
} from "../../src/features/observe/ScreenshotRetention";
import { SCREENSHOT_PATH_MIN_LIFETIME_MS } from "../../src/features/observe/ScreenshotRetention";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import type { BootedDevice, ObserveResult } from "../../src/models";
import { ActionableError } from "../../src/models/ActionableError";
import { observeSchema, registerObserveTools } from "../../src/server/observeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { getStructuredField } from "../../src/utils/toolUtils";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { SearchableHierarchy } from "../../src/features/utility/SearchableNode";
import {
  createObserveCrop,
  type ObserveCropResult,
} from "../../src/features/observe/screenshot/observeCrop";
import {
  observeCropResultSchema,
  observeToolResultSchema,
} from "../../src/server/toolOutputSchemas";
import { finalizeToolResponse } from "../../src/server/finalizeToolResponse";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { FakeImageBackend } from "../fakes/FakeImageBackend";
import { FakeObserveScreen } from "../fakes/FakeObserveScreen";
import { FakeTimer } from "../fakes/FakeTimer";
import { loadAndroidHomeObserve } from "../fixtures/observe/observeFixture";
import { RealObserveScreen } from "../../src/features/observe/ObserveScreen";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { INTERNAL_MCP_REQUEST_DEADLINE_PARAM } from "../../src/daemon/constants";

import { screenshotPathProtection } from "../../src/features/observe/ScreenshotPathProtection";
import { selectScreenshotsToEvict } from "../../src/features/observe/screenshotCacheEviction";
import { FakeScreenshotPathProtection } from "../fakes/FakeScreenshotPathProtection";

const device: BootedDevice = { deviceId: "crop-device", name: "Fake", platform: "android" };
const rect = { x: 10, y: 20, width: 30, height: 40 };
const source = Buffer.from("fake-captured-raster");
const fixture = loadAndroidHomeObserve().observe;
const projection = new SearchableHierarchy();
const target = projection.project(fixture.viewHierarchy!).find((node) => node.label === "Gmail")!;

function observation(): ObserveResult {
  return {
    ...structuredClone(fixture),
    observationId: "crop-frame",
    deviceId: device.deviceId,
    backStack: undefined,
    screenshotSettled: true,
    screenshotPath: "/fake/final.png",
    screenshotSource: "fresh",
    screenshotOrientation: "display",
  };
}

let image: FakeImageBackend;
let current: ObserveResult;
let writes: Array<{ filePath: string; data: Buffer }>;
let reads: string[];
let modes: Array<string | undefined>;
let captures: number;
let restoreNotify: ReturnType<typeof spyOn>;
let fake: FakeObserveScreen;
let timer: FakeTimer;

function register(extra: Parameters<typeof registerObserveTools>[0] = {}) {
  registerObserveTools({
    timer,
    createScreen: (_device, display) => {
      if (display) {
        expect(display).toBe("external");
      }
      return {
        execute: async (options) => {
          modes.push(options?.screenshot);
          if (!options?.skipScreenshot) {
            captures++;
          }
          return fake.execute(options);
        },
        executeDeviceRead: async (_signal, mode, _encoding, options) => {
          expect(options).toEqual({ requireFreshScreenshot: true, timeoutMs: undefined });
          modes.push(mode);
          captures++;
          return current;
        },
        captureScreenshot: async (_perf, _signal, result, mode) => {
          captures++;
          modes.push(mode);
          expect(result).toBe(current);
          result!.screenshotPath = "/fake/final.png";
          result!.screenshotSettled = true;
        },
        appendRawViewHierarchy: fake.appendRawViewHierarchy.bind(fake),
        getMostRecentCachedObserveResult: fake.getMostRecentCachedObserveResult.bind(fake),
      };
    },
    pathProtection: new FakeScreenshotPathProtection(timer),
    crop: {
      pathProtection: new FakeScreenshotPathProtection(timer),
      imageBackend: image,
      outputDirectory: () => "/fake/screenshots",
      ids: new CountingIdGenerator("test"),
      readFile: async (filePath) => {
        reads.push(filePath);
        return source;
      },
      writer: {
        write: async (filePath, data) => {
          writes.push({ filePath, data });
        },
        remove: async () => {},
      },
    },
    ...extra,
  });
}

async function call(args: Record<string, unknown>, targetDevice = device) {
  const tool = ToolRegistry.getTool("observe")!;
  return tool.deviceAwareHandler!(targetDevice, tool.schema.parse(args));
}

beforeEach(() => {
  current = observation();
  image = new FakeImageBackend();
  image.setMetadataResult({ ...current.screenSize, format: "png", size: source.length });
  image.setExecuteResult(Buffer.from("png-crop"));
  fake = new FakeObserveScreen();
  fake.setObserveResult(current);
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  writes = [];
  reads = [];
  modes = [];
  captures = 0;
  restoreNotify = spyOn(ResourceRegistry, "notifyResourcesUpdated").mockResolvedValue(undefined);
  register();
});

afterEach(() => {
  restoreNotify.mockRestore();
  ToolRegistry.clearTools();
});

describe("observe crop validation", () => {
  test.each([false, true])(
    "all with crop rejects before any capture (device read: %s)",
    async (deviceRead) => {
      const calls = { createScreen: 0, execute: 0, executeDeviceRead: 0, capture: 0 };
      register({
        createScreen: () => {
          calls.createScreen++;
          return {
            execute: async () => {
              calls.execute++;
              return current;
            },
            executeDeviceRead: async () => {
              calls.executeDeviceRead++;
              return current;
            },
            captureScreenshot: async () => {
              calls.capture++;
            },
            appendRawViewHierarchy: fake.appendRawViewHierarchy.bind(fake),
            getMostRecentCachedObserveResult: fake.getMostRecentCachedObserveResult.bind(fake),
          };
        },
      });
      const args = {
        deviceId: device.deviceId,
        sessionUuid: deviceRead ? undefined : "crop-session",
        display: "all",
        crop: { rect },
      };
      expect(observeSchema.safeParse(args).success).toBe(false);
      // Bypass schema parsing to exercise the handler's independent pre-capture validation.
      await expect(
        runWithToolSelectionContext({ explicitObserveDeviceRead: deviceRead }, () =>
          ToolRegistry.getTool("observe")!.deviceAwareHandler!(device, args),
        ),
      ).rejects.toThrow("observe crop requires one display");
      expect(calls).toEqual({ createScreen: 0, execute: 0, executeDeviceRead: 0, capture: 0 });
      expect(captures).toBe(0);
      expect(writes).toEqual([]);
    },
  );

  test.each([
    { crop: {} },
    { crop: { element: { text: "Gmail" }, rect } },
    { crop: { element: {} } },
    { crop: { rect: { ...rect, width: 0 } } },
    { crop: { rect: { ...rect, height: -1 } } },
    { crop: { rect: { ...rect, x: Infinity } } },
    { crop: { rect: { ...rect, width: NaN } } },
    { crop: { rect }, screenshot: "none" },
    { crop: { rect }, screenshot: "async" },
    { crop: { rect }, display: "all" },
  ])("rejects invalid input %j before capture", (args) => {
    expect(observeSchema.safeParse(args).success).toBe(false);
    expect(captures).toBe(0);
    expect(writes).toEqual([]);
  });

  test("uses the shared tapOn selector union", () => {
    for (const element of [
      { elementId: "date" },
      { text: "Gmail" },
      { testTag: "tag" },
      { textAny: ["Gmail"] },
      { accessibilityLink: "Terms" },
    ]) {
      expect(observeSchema.safeParse({ crop: { element } }).success).toBe(true);
    }
    expect(
      observeSchema.safeParse({ crop: { element: { text: "Gmail", elementId: "date" } } }).success,
    ).toBe(false);
  });

  test("crop implies settled for encoding and inline full screenshot options", () => {
    expect(
      observeSchema.safeParse({
        crop: { rect },
        screenshotOptions: { format: "jpeg", quality: 80 },
        includeScreenshotImage: true,
      }).success,
    ).toBe(true);
    expect(observeSchema.safeParse({ screenshotOptions: { format: "jpeg" } }).success).toBe(false);
  });
});

describe("observe crop capture and output", () => {
  test("returned crop path reports ten minutes and survives the next size sweep", async () => {
    const protection = new FakeScreenshotPathProtection(timer);
    const protect = spyOn(screenshotPathProtection, "protect").mockImplementation(
      protection.protect.bind(protection),
    );
    try {
      timer.advanceTime(60_000);
      register({
        pathProtection: protection,
        crop: {
          pathProtection: protection,
          imageBackend: image,
          outputDirectory: () => "/fake/screenshots",
          ids: new CountingIdGenerator("test"),
          readFile: async () => source,
          writer: { write: async () => {}, remove: async () => {} },
        },
      });
      const response = await call({ crop: { rect } });
      const crop = getStructuredField<ObserveCropResult>(response, "crop")!;
      expect(protection.calls.filter((path) => path === crop.cropPath)).toHaveLength(3);
      expect(crop.expiresAt).toBe(timer.now() + SCREENSHOT_PATH_MIN_LIFETIME_MS);
      const files = [{ path: crop.cropPath, size: 129 * 1024 * 1024, mtimeMs: 0 }];
      const sweep = () =>
        selectScreenshotsToEvict(
          files,
          128 * 1024 * 1024,
          timer.now(),
          () => false,
          protection.isProtected.bind(protection),
        );
      timer.advanceTime(SCREENSHOT_PATH_MIN_LIFETIME_MS - 1);
      expect(sweep().toEvict).toEqual([]);
      timer.advanceTime(1);
      expect(sweep().toEvict).toEqual([crop.cropPath]);
    } finally {
      protect.mockRestore();
    }
  });

  test("Android crops once, preserves full screenshot, and delivers scalar metadata only", async () => {
    const response = await call({ crop: { rect } });
    const crop = getStructuredField<ObserveCropResult>(response, "crop")!;
    expect(captures).toBe(1);
    expect(modes).toEqual(["settled"]);
    expect(reads).toEqual(["/fake/final.png"]);
    expect(crop).toEqual({
      expiresAt: timer.now() + SCREENSHOT_PATH_MIN_LIFETIME_MS,
      cropPath: path.join("/fake/screenshots", "crop-test-1.png"),
      unit: "pixels",
      requestedBounds: { left: 10, top: 20, right: 40, bottom: 60 },
      clippedBounds: { left: 10, top: 20, right: 40, bottom: 60 },
      clipped: false,
      screenSize: { width: 1080, height: 2400 },
      imageSize: { width: 30, height: 40 },
      pixelsPerNativeUnit: { x: 1, y: 1 },
      scaleProvenance: "raster-dimensions",
      rasterBounds: { left: 10, top: 20, right: 40, bottom: 60 },
      screenshotOrientation: "display",
    });
    expect(observeCropResultSchema.safeParse(crop).success).toBe(true);
    expect(observeCropResultSchema.safeParse({ ...crop, png: source }).success).toBe(false);
    expect(image.lastPipeline).toEqual({
      operations: [{ type: "crop", x: 10, y: 20, width: 30, height: 40 }],
      encoding: { mime: "image/png" },
    });
    expect(writes).toEqual([{ filePath: crop.cropPath, data: Buffer.from("png-crop") }]);
    expect(getStructuredField(response, "screenshotPath")).toBe("/fake/final.png");
    expect(getStructuredField(response, "screenshotOrientation")).toBe("display");
    expect(response.content.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(crop)).not.toContain("png-crop");
  });

  test.each([
    [
      "fractional iOS points",
      4,
      5,
      12,
      15,
      0,
      3,
      { x: 0.25, y: 1.5, width: 2, height: 1.6 },
      { left: 0, top: 4, right: 7, bottom: 10 },
      "native-scale-confirmed",
    ],
    [
      "landscape left",
      6,
      4,
      8,
      12,
      1,
      2,
      { x: 1, y: 0, width: 2, height: 2 },
      { left: 4, top: 2, right: 8, bottom: 6 },
      "native-scale-confirmed",
    ],
    [
      "landscape right",
      6,
      4,
      8,
      12,
      3,
      2,
      { x: 1, y: 0, width: 2, height: 2 },
      { left: 0, top: 6, right: 4, bottom: 10 },
      "native-scale-confirmed",
    ],
    [
      "half turn",
      4,
      6,
      8,
      12,
      2,
      2,
      { x: 1, y: 1, width: 2, height: 2 },
      { left: 2, top: 6, right: 6, bottom: 10 },
      "native-scale-confirmed",
    ],
    [
      "Display Zoom",
      4,
      4,
      8,
      8,
      0,
      3,
      { x: 1, y: 1, width: 2, height: 2 },
      { left: 2, top: 2, right: 6, bottom: 6 },
      "raster-dimensions",
    ],
    [
      "downsampled device",
      4,
      4,
      10,
      10,
      0,
      3,
      { x: 1, y: 1, width: 2, height: 2 },
      { left: 2, top: 2, right: 8, bottom: 8 },
      "raster-dimensions",
    ],
  ] as const)(
    "maps %s through observe without resizing",
    async (_label, w, h, rw, rh, rotation, nativeScale, rectangle, rasterBounds, provenance) => {
      // Geometry-only extensions of the existing crop fake cases; no native payload is invented.
      current.screenSize = { width: w, height: h };
      current.rotation = rotation;
      current.screenshotOrientation = "native";
      current.viewHierarchy!.nativeScale = nativeScale;
      image.setMetadataResult({ width: rw, height: rh, format: "png", size: source.length });
      const response = await call({ crop: { rect: rectangle } }, { ...device, platform: "ios" });
      const crop = getStructuredField<ObserveCropResult>(response, "crop")!;
      expect(crop.rasterBounds).toEqual(rasterBounds);
      expect(crop.scaleProvenance).toBe(provenance);
      expect(crop.unit).toBe("points");
      expect(crop.screenshotOrientation).toBe("display");
      expect(getStructuredField(response, "screenshotOrientation")).toBe("native");
      expect(image.lastPipeline?.operations).toEqual([
        {
          type: "crop",
          x: rasterBounds.left,
          y: rasterBounds.top,
          width: rasterBounds.right - rasterBounds.left,
          height: rasterBounds.bottom - rasterBounds.top,
        },
        ...(rotation === 0
          ? []
          : [{ type: "rotate", degrees: rotation === 1 ? 270 : rotation === 3 ? 90 : 180 }]),
      ]);
      expect(captures).toBe(1);
    },
  );

  test.each([1, 3])("landscape iOS element crop rotation %s is upright", async (rotation) => {
    // Reuse the exposed Gmail fixture; only crop geometry is configured at the fake seam.
    current.screenSize = { width: 4000, height: 2000 };
    current.rotation = rotation;
    current.screenshotOrientation = "native";
    const bounds = target.bounds!;
    image.setMetadataResult({ width: 6000, height: 12000, format: "png", size: source.length });
    const response = await call(
      { crop: { element: { text: "Gmail" } } },
      { ...device, platform: "ios" },
    );
    const crop = getStructuredField<ObserveCropResult>(response, "crop")!;
    expect(crop.requestedBounds).toEqual(bounds);
    expect(crop.imageSize).toEqual({
      width: (bounds.right - bounds.left) * 3,
      height: (bounds.bottom - bounds.top) * 3,
    });
    expect(crop.screenshotOrientation).toBe("display");
    expect(image.lastPipeline?.operations).toEqual([
      {
        type: "crop",
        x: (rotation === 1 ? 2000 - bounds.bottom : bounds.top) * 3,
        y: (rotation === 1 ? bounds.left : 4000 - bounds.right) * 3,
        width: (bounds.bottom - bounds.top) * 3,
        height: (bounds.right - bounds.left) * 3,
      },
      { type: "rotate", degrees: rotation === 1 ? 270 : 90 },
    ]);
  });

  test("a display-oriented iOS raster avoids a second half-turn mapping", async () => {
    current.screenSize = { width: 4, height: 6 };
    current.rotation = 2;
    current.screenshotOrientation = "display";
    image.setMetadataResult({ width: 8, height: 12, format: "png", size: source.length });
    const response = await call(
      { crop: { rect: { x: 1, y: 1, width: 2, height: 2 } } },
      { ...device, platform: "ios" },
    );
    expect(getStructuredField(response, "crop")).toMatchObject({
      rasterBounds: { left: 2, top: 2, right: 6, bottom: 6 },
      screenshotOrientation: "display",
    });
    expect(getStructuredField(response, "screenshotOrientation")).toBe("display");
  });

  test("clips partial bounds while retaining the original request", async () => {
    const response = await call({ crop: { rect: { x: -10, y: 2390, width: 40, height: 40 } } });
    expect(getStructuredField(response, "crop")).toMatchObject({
      clipped: true,
      requestedBounds: { left: -10, top: 2390, right: 30, bottom: 2430 },
      clippedBounds: { left: 0, top: 2390, right: 30, bottom: 2400 },
      imageSize: { width: 30, height: 10 },
    });
  });

  test("non-default display uses that display's capture, geometry and hierarchy", async () => {
    current.display = { key: "external", role: "external", posture: "unknown", generation: 0 };
    current.screenSize = { width: 600, height: 400 };
    current.viewHierarchy!.screenWidth = 600;
    current.viewHierarchy!.screenHeight = 400;
    current.screenshotPath = "/fake/external.png";
    image.setMetadataResult({ width: 600, height: 400, format: "png", size: source.length });
    const response = await call({
      display: "external",
      crop: { rect: { x: 590, y: 390, width: 20, height: 20 } },
    });
    expect(reads).toEqual(["/fake/external.png"]);
    expect(getStructuredField(response, "crop")).toMatchObject({
      screenSize: { width: 600, height: 400 },
      clipped: true,
      imageSize: { width: 10, height: 10 },
    });
  });

  test("deviceId read crops its own hierarchy with a required fresh screenshot", async () => {
    const response = await runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
      call({ deviceId: device.deviceId, crop: { element: { text: "Gmail" } } }),
    );
    expect(getStructuredField(response, "crop")).toMatchObject({ requestedBounds: target.bounds });
    expect(getStructuredField(response, "snapshotReference")).toBeUndefined();
    expect(modes).toEqual(["settled"]);
    expect(restoreNotify).not.toHaveBeenCalled();
  });

  test("crop deviceId read keeps strict freshness and leaves aggregate timeout undefined", async () => {
    const args = {
      deviceId: device.deviceId,
      crop: { rect },
      [INTERNAL_MCP_REQUEST_DEADLINE_PARAM]: timer.now() + 500,
    };
    const response = await runWithToolSelectionContext({ explicitObserveDeviceRead: true }, () =>
      ToolRegistry.getTool("observe")!.deviceAwareHandler!(device, args),
    );
    // The shared fake asserts both fields of the fourth argument, including timeoutMs: undefined.
    expect(getStructuredField(response, "crop")).toBeDefined();
    expect(captures).toBe(1);
    expect(modes).toEqual(["settled"]);
  });

  test.each(["full", "skeleton"] as const)(
    "hierarchy/elements remain byte-identical under %s projection",
    async (project) => {
      const baseline = finalizeToolResponse(await call({ project, screenshot: "settled" }), {
        name: "observe",
        args: { project },
      });
      const cropped = finalizeToolResponse(
        await call({ project, crop: { element: { text: "Gmail" } } }),
        { name: "observe", args: { project } },
      );
      for (const field of ["viewHierarchy", "elements", "skeleton", "readouts"]) {
        expect(JSON.stringify(getStructuredField(cropped, field))).toBe(
          JSON.stringify(getStructuredField(baseline, field)),
        );
      }
      expect(getStructuredField(cropped, "crop")).toBeDefined();
      expect(observeToolResultSchema.safeParse(cropped.structuredContent).success).toBe(true);
    },
  );

  test("full screenshot encoding options never resize or re-encode the PNG crop", async () => {
    const options = { format: "webp" as const, quality: 80 };
    const response = await call({ crop: { rect }, screenshotOptions: options });
    expect(fake.getExecuteOptions()[0]?.screenshotOptions).toEqual(options);
    expect(image.lastPipeline?.encoding).toEqual({ mime: "image/png" });
    expect(getStructuredField(response, "crop")).toBeDefined();
  });

  test("waitFor crops only the terminal settled frame after the quiet gate", async () => {
    const first = observation();
    first.viewHierarchy!.updatedAt = 0;
    first.screenshotPath = "/fake/early.png";
    current.viewHierarchy!.updatedAt = 1;
    fake.setObserveSequence([first, current, current]);
    const response = await call({
      waitFor: { text: "Gmail", timeoutMs: 500 },
      settled: { quietPeriodMs: 50 },
      crop: { element: { text: "Gmail" } },
    });
    expect(fake.getExecuteCallCount()).toBeGreaterThan(1);
    expect(fake.getExecuteOptions().every((options) => options?.skipScreenshot)).toBe(true);
    expect(captures).toBe(1);
    expect(reads).toEqual(["/fake/final.png"]);
    expect(getStructuredField(response, "settled")).toBe(true);
  });

  test("raw append leaves element crop resolved on the filtered same-frame tree", async () => {
    const response = await call({ raw: true, crop: { element: { text: "Gmail" } } });
    expect(fake.getExecutedOperations()).toContain("appendRawViewHierarchy");
    expect(getStructuredField(response, "crop")).toMatchObject({ requestedBounds: target.bounds });
  });

  test("full scope excludes an element without retargeting; skeleton retains existing scope behavior", async () => {
    const scope = { region: { x1: 0, y1: 0, x2: 1, y2: 0.05 } };
    await expect(
      call({ project: "full", scope, crop: { element: { text: "Gmail" } } }),
    ).rejects.toThrow("not found");
    expect(writes).toEqual([]);
    const response = await call({
      project: "skeleton",
      scope,
      crop: { element: { text: "Gmail" } },
    });
    expect(getStructuredField(response, "crop")).toMatchObject({ requestedBounds: target.bounds });
  });
});

describe("observe crop failures", () => {
  test.each([
    { element: { text: "missing" } },
    { element: { elementId: "icon" } },
    { element: { accessibilityLink: "Terms" } },
    { rect: { x: 1200, y: 0, width: 10, height: 10 } },
  ])("throws ActionableError without crop fallback for %j", async (crop) => {
    await expect(call({ crop })).rejects.toBeInstanceOf(ActionableError);
    expect(writes).toEqual([]);
  });

  test("missing and ambiguous elements have distinct actionable failures", async () => {
    await expect(call({ crop: { element: { text: "missing" } } })).rejects.toThrow(
      "observe crop element was not found with bounds",
    );
    const roots = current.viewHierarchy!.hierarchy.node;
    if (!Array.isArray(roots)) {
      throw new Error("captured fixture roots must be an array");
    }
    roots.push(structuredClone(target.source));
    await expect(call({ crop: { element: { text: "Gmail" } } })).rejects.toThrow(
      "observe crop element is ambiguous",
    );
    expect(writes).toEqual([]);
    expect(image.executeCalls).toEqual([]);
  });

  test("crop write failure fails the entire observe result", async () => {
    register({
      crop: {
        pathProtection: new FakeScreenshotPathProtection(timer),
        imageBackend: image,
        readFile: async () => source,
        outputDirectory: () => "/fake",
        ids: new CountingIdGenerator(),
        writer: {
          write: async () => {
            throw new Error("secure write failed");
          },
          remove: async () => {},
        },
      },
    });
    await expect(call({ crop: { rect } })).rejects.toThrow("secure write failed");
  });

  test("inline delivery includes only the full captured image, never crop bytes", async () => {
    current.screenshotPath = path.join(
      import.meta.dir,
      "../fixtures/screenshots/overlay-fullscreen.png",
    );
    const response = await call({ crop: { rect }, includeScreenshotImage: true });
    const inline = response.content.find((part) => part.type === "image");
    expect(inline).toBeDefined();
    if (inline?.type !== "image") {
      throw new Error("missing full screenshot image");
    }
    expect(Buffer.from(inline.data, "base64")).toEqual(await fs.readFile(current.screenshotPath));
    expect(Buffer.from(inline.data, "base64")).not.toEqual(Buffer.from("png-crop"));
    expect(getStructuredField(response, "crop")).toBeDefined();
    expect(captures).toBe(1);
  });

  test("ordered text variants select the first uniquely exposed match", async () => {
    const response = await call({ crop: { element: { textAny: ["missing", "Gmail", "Photos"] } } });
    expect(getStructuredField(response, "crop")).toMatchObject({ requestedBounds: target.bounds });
  });

  test("empty runtime rectangle uses the observe label and structured error", async () => {
    await expect(
      createObserveCrop({ rect: { ...rect, width: 0 } }, current, "android", {
        imageBackend: image,
        readFile: async () => source,
      }),
    ).rejects.toThrow("observe crop requires finite, nonempty");
  });

  test.each(["failed", "missing", "cached", "invalid"])(
    "strictly rejects %s screenshot evidence",
    async (failure) => {
      if (failure === "failed") {
        current.screenshotSettled = false;
      }
      if (failure === "missing") {
        current.screenshotPath = undefined;
      }
      if (failure === "cached") {
        current.screenshotSource = "cached";
      }
      if (failure === "invalid") {
        image.setShouldThrowOnMetadata(true);
      }
      await expect(call({ crop: { rect } })).rejects.toBeInstanceOf(ActionableError);
      expect(writes).toEqual([]);
    },
  );

  test("unavailable hierarchy rejects crop even when a screenshot is present", async () => {
    current.viewHierarchy!.hierarchy = { error: "Hierarchy service unavailable" };
    await expect(call({ crop: { rect } })).rejects.toThrow(
      "observe crop requires screen geometry from the captured hierarchy",
    );
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("capture exceptions propagate instead of publishing screenshotSettled:false", async () => {
    fake.setFailureMode("execute", new Error("capture failed"));
    await expect(call({ crop: { rect } })).rejects.toThrow("capture failed");
    expect(reads).toEqual([]);
    expect(writes).toEqual([]);
  });

  test("real device-read settled capture fails before attempting cached fallback", async () => {
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      {
        deviceReadOnly: true,
        hierarchyCapture: {
          capture: async () => ({
            captureId: "fixture",
            platform: "android",
            requestedFreshness: "fresh",
            receivedAt: 0,
            hierarchy: fixture.viewHierarchy!,
            nodes: [],
          }),
        },
        screenshot: {
          execute: async () => ({ success: false, error: "capture unavailable" }),
          generateScreenshotPath: () => "/fake/new.png",
          getActivityHash: async () => "",
        },
      },
      timer,
    );
    await expect(
      screen.executeDeviceRead(undefined, "settled", undefined, { requireFreshScreenshot: true }),
    ).rejects.toThrow("observe crop screenshot capture failed");
  });

  test("device-read options retain strict fresh failure alongside an aggregate timeout budget", async () => {
    let captureCalls = 0;
    const screen = new RealObserveScreen(
      device,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      {
        deviceReadOnly: true,
        hierarchyCapture: {
          capture: async () => ({
            captureId: "fixture",
            platform: "android",
            requestedFreshness: "fresh",
            receivedAt: timer.now(),
            hierarchy: fixture.viewHierarchy!,
            nodes: [],
          }),
        },
        screenshot: {
          execute: async () => {
            captureCalls++;
            return { success: false, error: "capture unavailable" };
          },
          generateScreenshotPath: () => "/fake/new.png",
          getActivityHash: async () => "",
        },
      },
      timer,
    );
    await expect(
      screen.executeDeviceRead(undefined, "settled", undefined, {
        requireFreshScreenshot: true,
        timeoutMs: 500,
      }),
    ).rejects.toThrow("observe crop screenshot capture failed");
    expect(captureCalls).toBe(1);
  });

  test("secure default writer saves crop PNG with owner-only permissions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "observe-crop-"));
    try {
      const crop = await createObserveCrop({ rect }, current, "android", {
        imageBackend: image,
        readFile: async () => source,
        outputDirectory: () => directory,
        ids: new CountingIdGenerator("secure"),
      });
      expect(await fs.readFile(crop.cropPath)).toEqual(Buffer.from("png-crop"));
      if (process.platform !== "win32") {
        expect((await fs.stat(crop.cropPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

test("crop writer refuses capacity with a typed error and retains both devices' paths", async () => {
  const files = new FakeFileSystem();
  files.setFile("/screenshots/screenshot_0_deviceA.png", "a");
  files.setFile("/screenshots/screenshot_0_deviceB.png", "b");
  files.stat = async () => ({ isFile: () => true, size: 64 * 1024 * 1024, mtimeMs: timer.now() });
  const protection = new BoundedScreenshotPathProtection(timer, undefined);
  register({
    crop: {
      pathProtection: protection,
      fileSystem: files,
      readFile: async () => source,
      outputDirectory: () => "/screenshots",
      imageBackend: image,
      writer: {
        write: async () => {
          throw new Error("must not write at capacity");
        },
        remove: async () => {},
      },
    },
  });
  await expect(call({ crop: { rect } })).rejects.toBeInstanceOf(ScreenshotRetentionCapacityError);
  expect(files.existsSync("/screenshots/screenshot_0_deviceA.png")).toBe(true);
  expect(files.existsSync("/screenshots/screenshot_0_deviceB.png")).toBe(true);
});

describe("explicit observe cached-hierarchy verification (#9963)", () => {
  test("a session observe asks the screen to verify a cached Android hierarchy", async () => {
    await call({});
    expect(fake.getExecuteOptions().map((options) => options.verifyCachedHierarchy)).toEqual([
      true,
    ]);
  });
});

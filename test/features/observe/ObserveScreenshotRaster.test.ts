import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { displayTransitions } from "../../../src/features/observe/DisplayTransition";
import { cropSnapshot } from "../../../src/features/observe/screenshot/snapshotCrop";
import { logger } from "../../../src/utils/logger";
import { finalizeToolResponse } from "../../../src/server/finalizeToolResponse";
import { createStructuredToolResponse } from "../../../src/utils/toolUtils";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { existsSync, promises as fsPromises } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { deviceId: "raster-test", name: "Fake", platform: "android" };
const options = {
  screenshot: "settled" as const,
  skipBackStack: true,
  skipRecompositionTracking: true,
  skipPerformanceAudit: true,
  skipAccessibilityAudit: true,
};

afterEach(() => {
  mock.restore();
  resetObserveCacheStore();
  resetScreenshotStateStore();
  displayTransitions.reset(device.deviceId);
});

function setup(
  platform: "android" | "ios" = "android",
  width = 1080,
  height = 2400,
  nativeScale?: number,
  rotation = 0,
  displays?: BootedDevice["displays"],
) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const hierarchy: ViewHierarchyResult = {
    hierarchy: { node: {} },
    screenWidth: width,
    screenHeight: height,
    nativeScale,
    rotation,
    ...(displays ? { displayId: 2 } : {}),
  };
  const viewHierarchy = new FakeViewHierarchy();
  viewHierarchy.configureHierarchy(hierarchy);
  const cacheStore = new FakeObserveCacheStore(timer);
  const store = new FakeScreenshotStateStore(timer);
  const recorder = new FakeScreenshotRecorder();
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("cmd display get-displays", {
    stdout:
      'Display id 0: DisplayInfo{uniqueId "local:cover" type INTERNAL, real 100 x 100}\nDisplay id 2: DisplayInfo{uniqueId "local:external" type EXTERNAL, real 200 x 200}',
    stderr: "",
  });
  let captureFails = false;
  let captureSize: { width: number; height: number } | undefined = { width, height };
  recorder.captureSettled = async (observationId) => {
    recorder.captureSettledCalls++;
    const path = "/fake/settled.png";
    store.updateForObservation(device.deviceId, observationId, path, undefined, captureSize);
    return path;
  };
  let capturedDisplayId: number | undefined;
  const screen = new RealObserveScreen(
    { ...device, platform, displays },
    new FakeAdbClientFactory(adb),
    {
      viewHierarchy,
      hierarchyCapture: new FakeHierarchyCapture(() => hierarchy, platform),
      screenshot: {
        execute: async (captureOptions) => {
          capturedDisplayId = captureOptions?.displayId;
          return captureFails
            ? { success: false, error: "capture failed" }
            : { success: true, path: "/fake/read.png", screenshotImageSize: captureSize };
        },
        generateScreenshotPath: () => "/fake/read.png",
        getActivityHash: async () => "",
      },
      screenshotRecorder: recorder,
      display: displays && platform === "android" ? "external" : undefined,
      screenshotEvidenceFiles: { stat: async () => ({ isFile: () => true, size: 12, mtimeMs: 0 }) },
      cacheStore,
      screenshotStateStore: store,
    },
    timer,
  );
  spyOn(screen["performanceAuditor"], "run").mockResolvedValue(undefined);
  spyOn(screen["accessibilityAuditor"], "run").mockResolvedValue(undefined);
  spyOn(screen["accessibilityStateDetector"], "run").mockResolvedValue(undefined);
  return {
    screen,
    store,
    recorder,
    cacheStore,
    failCapture: () => {
      captureFails = true;
    },
    capturedDisplay: () => capturedDisplayId,
    setCaptureSize: (size: { width: number; height: number } | undefined) => {
      captureSize = size;
    },
  };
}

test("Android identity scale reaches the default skeleton and cached reuse", async () => {
  const { screen } = setup();
  const result = await screen.execute(options);
  const fields = {
    screenshotOrientation: "display",
    screenshotImageSize: { width: 1080, height: 2400 },
    screenshotPixelsPerNativeUnit: { x: 1, y: 1 },
    screenshotScaleProvenance: "raster-dimensions",
  };
  expect(result).toMatchObject(fields);
  await screen.cacheObserveResult(result);
  expect(await screen.getMostRecentCachedObserveResult()).toMatchObject(fields);
  const emitted = finalizeToolResponse(createStructuredToolResponse(result), { name: "observe" });
  expect(emitted.structuredContent).toMatchObject(fields);
  const withoutRaster = { ...result };
  delete withoutRaster.screenshotImageSize;
  delete withoutRaster.screenshotPixelsPerNativeUnit;
  delete withoutRaster.screenshotScaleProvenance;
  const baseline = finalizeToolResponse(createStructuredToolResponse(withoutRaster), {
    name: "observe",
  });
  expect(
    Buffer.byteLength(JSON.stringify(emitted.structuredContent)) -
      Buffer.byteLength(JSON.stringify(baseline.structuredContent)),
  ).toBe(145);
});

test("deviceId read uses capture-buffer dimensions without file metadata I/O", async () => {
  const { screen, setCaptureSize } = setup();
  setCaptureSize({ width: 540, height: 1200 });
  expect(await screen.executeDeviceRead()).toMatchObject({
    screenshotOrientation: "display",
    screenshotImageSize: { width: 540, height: 1200 },
    screenshotPixelsPerNativeUnit: { x: 0.5, y: 0.5 },
  });
});

test.each([2, 3])("iOS %sx scale is confirmed by nativeScale", async (scale) => {
  const { screen, setCaptureSize } = setup("ios", 400, 800, scale);
  setCaptureSize({ width: 400 * scale, height: 800 * scale });
  expect(await screen.execute(options)).toMatchObject({
    screenshotOrientation: "native",
    screenshotImageSize: { width: 400 * scale, height: 800 * scale },
    screenshotPixelsPerNativeUnit: { x: scale, y: scale },
    screenshotScaleProvenance: "native-scale-confirmed",
  });
});

test.each([1, 2, 3])("rotated iOS %s retains portrait raster dimensions", async (rotation) => {
  const { screen, setCaptureSize } = setup(
    "ios",
    rotation === 2 ? 400 : 800,
    rotation === 2 ? 800 : 400,
    3,
    rotation,
  );
  setCaptureSize({ width: 1200, height: 2400 });
  const backend = new FakeImageBackend();
  backend.setMetadataResult({ width: 1200, height: 2400, format: "png", size: 12 });
  const observation = await screen.execute(options);
  expect(observation).toMatchObject({
    screenshotImageSize: { width: 1200, height: 2400 },
    screenshotPixelsPerNativeUnit: { x: 3, y: 3 },
    screenshotScaleProvenance: "native-scale-confirmed",
    screenshotOrientation: "native",
  });
  const crop = await cropSnapshot(
    Buffer.from("in-memory-png"),
    { left: 0, top: 0, right: 200, bottom: 100 },
    {
      platform: "ios",
      screenSize: observation.screenSize,
      rotation: observation.rotation,
      nativeScale: observation.viewHierarchy?.nativeScale,
      rasterOrientation: observation.screenshotOrientation,
    },
    backend,
  );
  expect(crop).toMatchObject({
    imageSize: { width: 600, height: 300 },
    screenshotOrientation: "display",
    pixelsPerNativeUnit: observation.screenshotPixelsPerNativeUnit,
    scaleProvenance: observation.screenshotScaleProvenance,
  });
  expect(observation.screenshotOrientation).toBe("native");
});

test("encoded downscaled capture reports the written raster", async () => {
  const { screen, store, recorder } = setup("android", 1080, 2400, 1);
  recorder.captureSettled = async (observationId, _perf, _signal, _display, encoding) => {
    expect(encoding).toEqual({ format: "webp", quality: 70 });
    store.updateForObservation(device.deviceId, observationId, "/fake/small.webp", undefined, {
      width: 540,
      height: 1200,
    });
    return "/fake/small.webp";
  };
  expect(
    await screen.execute({ ...options, screenshotOptions: { format: "webp", quality: 70 } }),
  ).toMatchObject({
    screenshotPath: "/fake/small.webp",
    screenshotImageSize: { width: 540, height: 1200 },
    screenshotPixelsPerNativeUnit: { x: 0.5, y: 0.5 },
    screenshotScaleProvenance: "raster-dimensions",
  });
});

test("session-less deviceId read reports its fresh file", async () => {
  expect(await setup().screen.executeDeviceRead()).toMatchObject({
    screenshotPath: "/fake/read.png",
    screenshotSource: "fresh",
    screenshotImageSize: { width: 1080, height: 2400 },
    screenshotPixelsPerNativeUnit: { x: 1, y: 1 },
  });
});

test("cached fallback uses cached dimensions without opening the path or writing temp files", async () => {
  const { screen, cacheStore, store, failCapture, setCaptureSize } = setup();
  setCaptureSize({ width: 540, height: 1200 });
  const cached = await screen.executeDeviceRead();
  const cachedPath = "scratch/rastersize/never-opened/never-opened.png";
  expect(existsSync(cachedPath)).toBe(false);
  expect(existsSync(dirname(cachedPath))).toBe(false);
  await cacheStore.put(device.deviceId, { ...cached, screenshotPath: cachedPath });
  store.update(device.deviceId, "/fake/other.png");
  failCapture();
  // Observe this process's I/O, not the temp directory shared with parallel shards.
  // Bun exposes separate bindings for node:fs/promises and node:fs.promises.
  const unexpectedIo = new Error("Cached raster fallback must not open or write files");
  const fileOperations = [fs, fsPromises].flatMap((files) => [
    spyOn(files, "open").mockRejectedValue(unexpectedIo),
    spyOn(files, "readFile").mockRejectedValue(unexpectedIo),
    spyOn(files, "writeFile").mockRejectedValue(unexpectedIo),
    spyOn(files, "mkdtemp").mockRejectedValue(unexpectedIo),
  ]);
  const result = await screen.executeDeviceRead();
  for (const operation of fileOperations) {
    expect(operation).not.toHaveBeenCalled();
  }
  expect(existsSync(cachedPath)).toBe(false);
  expect(existsSync(dirname(cachedPath))).toBe(false);
  expect(existsSync("scratch/rastersize/never-opened.png")).toBe(false);
  expect(result).toMatchObject({
    screenshotPath: cachedPath,
    screenshotSource: "cached",
    screenshotImageSize: { width: 540, height: 1200 },
    screenshotPixelsPerNativeUnit: { x: 0.5, y: 0.5 },
    screenshotScaleProvenance: "raster-dimensions",
    screenshotSettled: false,
  });
});

test("cached fallback with only a state-store path succeeds without raster dimensions and warns", async () => {
  const { screen, store, failCapture } = setup();
  store.update(device.deviceId, "/fake/cached.png");
  failCapture();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const result = await screen.executeDeviceRead();
  expect(result).toMatchObject({
    screenshotPath: "/fake/cached.png",
    screenshotSource: "cached",
    screenshotSettled: false,
  });
  expect(result.screenshotImageSize).toBeUndefined();
  expect(result.screenshotPixelsPerNativeUnit).toBeUndefined();
  expect(result.screenshotScaleProvenance).toBeUndefined();
  expect(warn).toHaveBeenCalledWith("[OBSERVE] Could not read screenshot raster dimensions");
});

test("state-store fallback does not borrow dimensions from a cache entry without a path", async () => {
  const { screen, cacheStore, store, failCapture } = setup();
  const cached = await screen.executeDeviceRead();
  delete cached.screenshotPath;
  await cacheStore.put(device.deviceId, cached);
  store.update(device.deviceId, "/fake/other.png");
  failCapture();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const result = await screen.executeDeviceRead();
  expect(result.screenshotPath).toBe("/fake/other.png");
  expect(result.screenshotImageSize).toBeUndefined();
  expect(result.screenshotPixelsPerNativeUnit).toBeUndefined();
  expect(result.screenshotScaleProvenance).toBeUndefined();
  expect(warn).toHaveBeenCalledWith("[OBSERVE] Could not read screenshot raster dimensions");
});

test("missing capture dimensions succeeds, clears old dimensions, and warns", async () => {
  const { screen, setCaptureSize } = setup();
  const observation = await screen.execute(options);
  setCaptureSize(undefined);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  await screen.captureScreenshot(undefined, undefined, observation, "settled");
  expect(observation.screenshotSettled).toBe(true);
  expect(observation.screenshotImageSize).toBeUndefined();
  expect(observation.screenshotPixelsPerNativeUnit).toBeUndefined();
  expect(observation.screenshotScaleProvenance).toBeUndefined();
  expect(warn).toHaveBeenCalledWith("[OBSERVE] Could not read screenshot raster dimensions");
});

test("incompatible aspect ratio retains imageSize and omits scale without failing observe", async () => {
  const { screen, setCaptureSize } = setup();
  setCaptureSize({ width: 800, height: 800 });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const result = await screen.execute(options);
  expect(result.screenshotImageSize).toEqual({ width: 800, height: 800 });
  expect(result.screenshotPixelsPerNativeUnit).toBeUndefined();
  expect(result.screenshotScaleProvenance).toBeUndefined();
  expect(result.screenshotSettled).toBe(true);
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("incompatible aspect ratios"),
    expect.any(Error),
  );
});

test("per-display settled and device reads use the captured panel geometry", async () => {
  const displays = {
    panels: [
      { key: "cover", role: "cover" as const, sizePx: { width: 100, height: 100 } },
      { key: "external", role: "external" as const, sizePx: { width: 200, height: 200 } },
    ],
    postures: [],
  };
  const { screen, capturedDisplay } = setup("android", 200, 200, undefined, 0, displays);
  const result = await screen.execute({ ...options, display: "external" });
  expect(result.display.key).toBe("external");
  expect(result.screenSize).toMatchObject({ width: 200, height: 200 });
  expect(result.screenshotImageSize).toEqual({ width: 200, height: 200 });
  expect(result.screenshotPixelsPerNativeUnit).toEqual({ x: 1, y: 1 });
  expect(result.screenshotOrientation).toBe("display");
  const read = await screen.executeDeviceRead();
  expect(capturedDisplay()).toBe(2);
  expect(read.display.key).toBe("external");
  expect(read.screenSize).toMatchObject({ width: 200, height: 200 });
  expect(read.screenshotImageSize).toEqual({ width: 200, height: 200 });
  expect(read.screenshotPixelsPerNativeUnit).toEqual({ x: 1, y: 1 });
  expect(read.screenshotOrientation).toBe("display");
});

test("fresh settled capture uses writer dimensions without another file read", async () => {
  const { screen, recorder, store } = setup();
  recorder.captureSettled = async (observationId) => {
    store.updateForObservation(device.deviceId, observationId, "/fake/settled.png", undefined, {
      width: 540,
      height: 1200,
    });
    return "/fake/settled.png";
  };
  const result = await screen.execute(options);
  expect(result.screenshotImageSize).toEqual({ width: 540, height: 1200 });
  expect(result.screenshotPixelsPerNativeUnit).toEqual({ x: 0.5, y: 0.5 });
});

test.each([undefined, 0, -1, 1.5, NaN])(
  "missing or invalid raster width %s warns and omits fields",
  async (width) => {
    const { screen, setCaptureSize } = setup();
    setCaptureSize(width === undefined ? undefined : { width, height: 2400 });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const result = await screen.execute(options);
    expect(result.screenshotImageSize).toBeUndefined();
    expect(result.screenshotPixelsPerNativeUnit).toBeUndefined();
    expect(result.screenshotScaleProvenance).toBeUndefined();
    expect(result.screenshotSettled).toBe(true);
    expect(warn).toHaveBeenCalledWith("[OBSERVE] Could not read screenshot raster dimensions");
  },
);

test("iOS multi-panel landscape capture is already display-oriented", async () => {
  const { screen, setCaptureSize } = setup("ios", 800, 400, 2, 1, {
    panels: [
      { key: "0", role: "primary", sizePx: { width: 800, height: 400 } },
      { key: "1", role: "external", sizePx: { width: 100, height: 100 } },
    ],
    postures: [],
  });
  setCaptureSize({ width: 1600, height: 800 });
  expect(await screen.execute(options)).toMatchObject({
    screenshotImageSize: { width: 1600, height: 800 },
    screenshotOrientation: "display",
    screenshotPixelsPerNativeUnit: { x: 2, y: 2 },
    screenshotScaleProvenance: "native-scale-confirmed",
  });
});

test.each([
  [false, 0],
  [false, 1],
  [true, 0],
  [true, 1],
] as const)(
  "iOS deviceId reads preserve native orientation (multi-panel: %s, rotation: %s)",
  async (multiPanel, rotation) => {
    const width = rotation === 0 ? 400 : 800;
    const height = rotation === 0 ? 800 : 400;
    const displays = multiPanel
      ? {
          panels: [
            { key: "0", role: "primary" as const, sizePx: { width, height } },
            { key: "1", role: "external" as const, sizePx: { width: 100, height: 100 } },
          ],
          postures: [],
        }
      : undefined;
    const { screen, setCaptureSize, cacheStore, failCapture } = setup(
      "ios",
      width,
      height,
      2,
      rotation,
      displays,
    );
    const imageSize = multiPanel
      ? { width: width * 2, height: height * 2 }
      : { width: 800, height: 1600 };
    setCaptureSize(imageSize);
    const fields = {
      screenshotOrientation: "native",
      screenshotImageSize: imageSize,
      screenshotPixelsPerNativeUnit: { x: 2, y: 2 },
      screenshotScaleProvenance: "native-scale-confirmed",
    };
    const fresh = await screen.executeDeviceRead();
    expect(fresh).toMatchObject({ ...fields, screenshotSource: "fresh" });
    await cacheStore.put(device.deviceId, { ...fresh, screenshotPath: "/fake/cached.png" });
    failCapture();
    expect(await screen.executeDeviceRead()).toMatchObject({
      ...fields,
      screenshotSource: "cached",
    });
  },
);

test.each(["portrait", "unavailable", "incompatible"])(
  "iOS multi-panel settled orientation preserves the aspect rule for %s raster",
  async (raster) => {
    const { screen, setCaptureSize } = setup("ios", 800, 400, 2, 1, {
      panels: [
        { key: "0", role: "primary", sizePx: { width: 800, height: 400 } },
        { key: "1", role: "external", sizePx: { width: 100, height: 100 } },
      ],
      postures: [],
    });
    if (raster === "unavailable") {
      setCaptureSize(undefined);
    } else {
      setCaptureSize({
        width: raster === "portrait" ? 800 : 1000,
        height: raster === "portrait" ? 1600 : 800,
      });
    }
    const result = await screen.execute(options);
    expect(result.screenshotOrientation).toBe(raster === "incompatible" ? "display" : "native");
    expect(result.screenshotSettled).toBe(true);
  },
);

test("degraded hierarchy-less read takes screenSize from the known panel so raster geometry works", async () => {
  const warn = spyOn(logger, "warn");
  const { screen, setCaptureSize } = setup("android", 0, 0, undefined, 0, {
    panels: [{ key: "external", role: "external", sizePx: { width: 1080, height: 2400 } }],
    postures: [],
  });
  setCaptureSize({ width: 1080, height: 2400 });
  const result = await screen.execute(options);
  expect(result.screenSize).toMatchObject({ width: 1080, height: 2400 });
  expect(result.screenshotPixelsPerNativeUnit).toEqual({ x: 1, y: 1 });
  expect(
    warn.mock.calls.some((call) => String(call[0]).includes("Could not derive screenshot raster")),
  ).toBe(false);
});

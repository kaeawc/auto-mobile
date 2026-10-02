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
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { FakeViewHierarchy } from "../../fakes/FakeViewHierarchy";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeImageBackend } from "../../fakes/FakeImageBackend";
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
  const backend = new FakeImageBackend();
  backend.setMetadataResult({ width, height, format: "png", size: 12 });
  const readPaths: string[] = [];
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
  let unreadableHeader = false;
  let captureSize: { width: number; height: number } | undefined;
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
      screenshotDimensionsReader: {
        read: async (path) => {
          readPaths.push(path);
          if (unreadableHeader) {
            return null;
          }
          return backend.metadata(Buffer.from(path));
        },
      },
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
    backend,
    store,
    recorder,
    readPaths,
    cacheStore,
    failCapture: () => {
      captureFails = true;
    },
    capturedDisplay: () => capturedDisplayId,
    makeHeaderUnreadable: () => {
      unreadableHeader = true;
    },
    setCaptureSize: (size: { width: number; height: number }) => {
      captureSize = size;
    },
  };
}

test("Android identity scale reaches the default skeleton and cached reuse", async () => {
  const { screen, readPaths } = setup();
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
  expect(readPaths).toEqual([result.screenshotPath!]);
});

test("deviceId read uses capture-buffer dimensions without file metadata I/O", async () => {
  const { screen, setCaptureSize, readPaths } = setup();
  setCaptureSize({ width: 540, height: 1200 });
  expect(await screen.executeDeviceRead()).toMatchObject({
    screenshotOrientation: "display",
    screenshotImageSize: { width: 540, height: 1200 },
    screenshotPixelsPerNativeUnit: { x: 0.5, y: 0.5 },
  });
  expect(readPaths).toEqual([]);
});

test.each([2, 3])("iOS %sx scale is confirmed by nativeScale", async (scale) => {
  const { screen, backend } = setup("ios", 400, 800, scale);
  backend.setMetadataResult({ width: 400 * scale, height: 800 * scale, format: "png", size: 12 });
  expect(await screen.execute(options)).toMatchObject({
    screenshotOrientation: "native",
    screenshotImageSize: { width: 400 * scale, height: 800 * scale },
    screenshotPixelsPerNativeUnit: { x: scale, y: scale },
    screenshotScaleProvenance: "native-scale-confirmed",
  });
});

test.each([1, 2, 3])("rotated iOS %s retains portrait raster dimensions", async (rotation) => {
  const { screen, backend } = setup(
    "ios",
    rotation === 2 ? 400 : 800,
    rotation === 2 ? 800 : 400,
    3,
    rotation,
  );
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
  const { screen, backend, recorder } = setup("android", 1080, 2400, 1);
  backend.setMetadataResult({ width: 540, height: 1200, format: "webp", size: 12 });
  recorder.captureSettled = async (_id, _perf, _signal, _display, encoding) => {
    expect(encoding).toEqual({ format: "webp", quality: 70 });
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

test("cached fallback reads cached file dimensions rather than current screen", async () => {
  const { screen, backend, store, failCapture, readPaths } = setup();
  store.update(device.deviceId, "/fake/cached.png");
  backend.setMetadataResult({ width: 540, height: 1200, format: "png", size: 12 });
  failCapture();
  expect(await screen.executeDeviceRead()).toMatchObject({
    screenshotPath: "/fake/cached.png",
    screenshotSource: "cached",
    screenshotImageSize: { width: 540, height: 1200 },
    screenshotPixelsPerNativeUnit: { x: 0.5, y: 0.5 },
  });
  expect(readPaths).toEqual(["/fake/cached.png"]);
});

test("metadata failure succeeds, clears old dimensions, and warns", async () => {
  const { screen, backend } = setup();
  const observation = await screen.execute(options);
  backend.setShouldThrowOnMetadata(true);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  await screen.captureScreenshot(undefined, undefined, observation, "settled");
  expect(observation.screenshotSettled).toBe(true);
  expect(observation.screenshotImageSize).toBeUndefined();
  expect(observation.screenshotPixelsPerNativeUnit).toBeUndefined();
  expect(observation.screenshotScaleProvenance).toBeUndefined();
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("Could not derive screenshot raster scale"),
    expect.any(Error),
  );
});

test("incompatible aspect ratio retains imageSize and omits scale without failing observe", async () => {
  const { screen, backend } = setup();
  backend.setMetadataResult({ width: 800, height: 800, format: "png", size: 12 });
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
  const { screen, recorder, store, readPaths } = setup();
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
  expect(readPaths).toEqual([]);
});

test("metadata null or invalid raster sizes warn and omit fields", async () => {
  for (const width of [null, 0, -1, 1.5, NaN]) {
    const { screen, backend, makeHeaderUnreadable } = setup();
    if (width === null) {
      makeHeaderUnreadable();
    } else {
      backend.setMetadataResult({ width, height: 2400, format: "png", size: 12 });
    }
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const result = await screen.execute(options);
    expect(result.screenshotImageSize).toBeUndefined();
    expect(result.screenshotPixelsPerNativeUnit).toBeUndefined();
    expect(result.screenshotSettled).toBe(true);
    expect(warn).toHaveBeenCalledWith("[OBSERVE] Could not read screenshot raster dimensions");
  }
});

test("iOS multi-panel landscape capture is already display-oriented", async () => {
  const { screen, backend } = setup("ios", 800, 400, 2, 1, {
    panels: [
      { key: "0", role: "primary", sizePx: { width: 800, height: 400 } },
      { key: "1", role: "external", sizePx: { width: 100, height: 100 } },
    ],
    postures: [],
  });
  backend.setMetadataResult({ width: 1600, height: 800, format: "png", size: 12 });
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
    const { screen, backend, store, failCapture } = setup(
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
    backend.setMetadataResult({ ...imageSize, format: "png", size: 12 });
    const fields = {
      screenshotOrientation: "native",
      screenshotImageSize: imageSize,
      screenshotPixelsPerNativeUnit: { x: 2, y: 2 },
      screenshotScaleProvenance: "native-scale-confirmed",
    };
    expect(await screen.executeDeviceRead()).toMatchObject({
      ...fields,
      screenshotSource: "fresh",
    });
    store.update(device.deviceId, "/fake/cached.png");
    failCapture();
    expect(await screen.executeDeviceRead()).toMatchObject({
      ...fields,
      screenshotSource: "cached",
    });
  },
);

test.each(["portrait", "unreadable", "incompatible"])(
  "iOS multi-panel settled orientation preserves the aspect rule for %s raster",
  async (raster) => {
    const { screen, backend, makeHeaderUnreadable } = setup("ios", 800, 400, 2, 1, {
      panels: [
        { key: "0", role: "primary", sizePx: { width: 800, height: 400 } },
        { key: "1", role: "external", sizePx: { width: 100, height: 100 } },
      ],
      postures: [],
    });
    if (raster === "unreadable") {
      makeHeaderUnreadable();
    } else {
      backend.setMetadataResult({
        width: raster === "portrait" ? 800 : 1000,
        height: raster === "portrait" ? 1600 : 800,
        format: "png",
        size: 12,
      });
    }
    const result = await screen.execute(options);
    expect(result.screenshotOrientation).toBe(raster === "incompatible" ? "display" : "native");
    expect(result.screenshotSettled).toBe(true);
  },
);

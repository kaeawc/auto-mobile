import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { SettledScreenshotCapture } from "../../../src/features/observe/SettledScreenshotCapture";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { logger } from "../../../src/utils/logger";
import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { FakeTimer } from "../../fakes/FakeTimer";
import duoSessionlessObserve from "../../fixtures/ios-duo/observe-sessionless-inner-landscape-17846.json";

// The Duo inventory stores both panels portrait, in pixels (cover 466x678 pt, inner 669x951 pt).
const duo: BootedDevice = {
  deviceId: "D9CE3691-D0DA-44F9-A280-7B03858985BA",
  name: "iPhone Duo",
  platform: "ios",
  displays: {
    panels: [
      { key: "primary", role: "cover", sizePx: { width: 1398, height: 2034 }, scale: 3 },
      { key: "primary-1", role: "inner", sizePx: { width: 2007, height: 2853 }, scale: 3 },
    ],
    postures: ["closed", "opened"],
  },
};

afterEach(() => {
  mock.restore();
});

function capture(device: BootedDevice = duo): SettledScreenshotCapture {
  const timer = new FakeTimer();
  return new SettledScreenshotCapture({
    device: () => device,
    timer: () => timer,
    screenshotRecorder: () => new FakeScreenshotRecorder(),
    screenshotEvidenceFiles: () => undefined,
    pathProtection: () => new FakeScreenshotPathProtection(timer),
  });
}

/** The #17846 sessionless observe as it was before the raster was attached. */
function fixtureObservation(): ObserveResult {
  const observation = structuredClone(duoSessionlessObserve) as ObserveResult;
  delete observation.screenshotImageSize;
  return observation;
}

test("hierarchy-less Duo inner panel takes the landscape screenshot's orientation (#17846)", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const observation = fixtureObservation();
  await capture().attachScreenshotRaster(observation, duoSessionlessObserve.screenshotImageSize);
  expect(observation.screenSize).toEqual({ width: 951, height: 669, units: "points" });
  expect(observation.rotation).toBe(1);
  expect(observation.screenshotImageSize).toEqual({ width: 2853, height: 2007 });
  expect(observation.screenshotPixelsPerNativeUnit).toEqual({ x: 3, y: 3 });
  expect(observation.screenshotScaleProvenance).toBe("raster-dimensions");
  expect(observation.errors).toBeUndefined();
  expect(warn).not.toHaveBeenCalled();
});

test("hierarchy-less Duo inner panel keeps a portrait screenshot's orientation", async () => {
  const observation = fixtureObservation();
  await capture().attachScreenshotRaster(observation, { width: 2007, height: 2853 });
  expect(observation.screenSize).toEqual({ width: 669, height: 951, units: "points" });
  expect(observation.rotation).toBe(0);
  expect(observation.screenshotPixelsPerNativeUnit).toEqual({ x: 3, y: 3 });
});

test("an unreconcilable hierarchy-less panel screenshot reports an actionable error, not a scale", async () => {
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  const observation = fixtureObservation();
  await capture().attachScreenshotRaster(observation, { width: 2000, height: 2000 });
  expect(observation.screenSize).toEqual({ width: 669, height: 951, units: "points" });
  expect(observation.rotation).toBe(0);
  expect(observation.screenshotImageSize).toEqual({ width: 2000, height: 2000 });
  expect(observation.screenshotPixelsPerNativeUnit).toBeUndefined();
  expect(observation.errors).toEqual([
    {
      phase: "screenshot",
      message: expect.stringContaining(
        "Observe from the session that owns the device to reconnect its hierarchy client",
      ),
    },
  ]);
  expect(String(warn.mock.calls[0]?.[0])).toContain("fits neither orientation");
  expect(
    warn.mock.calls.some((call) => String(call[0]).includes("incompatible aspect ratios")),
  ).toBe(false);
});

test("a hierarchy keeps its rotation authority over the screenshot aspect", async () => {
  spyOn(logger, "warn").mockImplementation(() => {});
  const observation = fixtureObservation();
  observation.viewHierarchy = { hierarchy: { node: {} }, rotation: 0 };
  await capture().attachScreenshotRaster(observation, { width: 2853, height: 2007 });
  expect(observation.screenSize).toEqual({ width: 669, height: 951, units: "points" });
  expect(observation.rotation).toBe(0);
  expect(observation.screenshotPixelsPerNativeUnit).toBeUndefined();
  expect(observation.errors).toBeUndefined();
});

test("a single-panel iOS screenshot never reorients the geometry", async () => {
  spyOn(logger, "warn").mockImplementation(() => {});
  const observation = fixtureObservation();
  await capture({ ...duo, displays: undefined }).attachScreenshotRaster(observation, {
    width: 2853,
    height: 2007,
  });
  expect(observation.screenSize).toEqual({ width: 669, height: 951, units: "points" });
  expect(observation.errors).toBeUndefined();
});

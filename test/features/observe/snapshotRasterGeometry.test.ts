import { expect, test } from "bun:test";
import { snapshotRasterGeometry } from "../../../src/features/observe/screenshot/snapshotRasterGeometry";
import { ActionableError } from "../../../src/models/ActionableError";

test.each([undefined, 1])("Android identity provenance with nativeScale %s", (nativeScale) => {
  const screenSize = { width: 1080, height: 2400 };
  expect(
    snapshotRasterGeometry(screenSize, { platform: "android", screenSize, nativeScale }),
  ).toEqual({
    pixelsPerNativeUnit: { x: 1, y: 1 },
    scaleProvenance: nativeScale ? "native-scale-confirmed" : "raster-dimensions",
    quarterTurn: false,
    halfTurn: false,
    screenshotOrientation: "display",
  });
});

test.each([1, 3])("iOS quarter turn %s swaps native dimensions", (rotation) => {
  expect(
    snapshotRasterGeometry(
      { width: 1200, height: 2400 },
      {
        platform: "ios",
        screenSize: { width: 800, height: 400 },
        rotation,
        nativeScale: 3,
      },
    ),
  ).toMatchObject({
    pixelsPerNativeUnit: { x: 3, y: 3 },
    quarterTurn: true,
    halfTurn: false,
    screenshotOrientation: "native",
    scaleProvenance: "native-scale-confirmed",
  });
});

test("display-oriented iOS raster does not apply a half turn", () => {
  const geometry = {
    platform: "ios" as const,
    screenSize: { width: 400, height: 800 },
    rotation: 2,
  };
  expect(snapshotRasterGeometry({ width: 800, height: 1600 }, geometry)).toMatchObject({
    halfTurn: true,
    screenshotOrientation: "native",
  });
  expect(
    snapshotRasterGeometry(
      { width: 800, height: 1600 },
      { ...geometry, rasterOrientation: "display" },
    ),
  ).toMatchObject({ halfTurn: false, screenshotOrientation: "display" });
});

test("fractional raster scale ignores a mismatched nativeScale", () => {
  expect(
    snapshotRasterGeometry(
      { width: 540, height: 1200 },
      {
        platform: "android",
        screenSize: { width: 1080, height: 2400 },
        nativeScale: 1,
      },
    ),
  ).toMatchObject({
    pixelsPerNativeUnit: { x: 0.5, y: 0.5 },
    scaleProvenance: "raster-dimensions",
  });
});

test("native confirmation and aspect tolerance remain 0.02", () => {
  const geometry = {
    platform: "ios" as const,
    screenSize: { width: 1000, height: 1000 },
    nativeScale: 2,
  };
  expect(snapshotRasterGeometry({ width: 2019, height: 2000 }, geometry).scaleProvenance).toBe(
    "native-scale-confirmed",
  );
  expect(snapshotRasterGeometry({ width: 2021, height: 2021 }, geometry).scaleProvenance).toBe(
    "raster-dimensions",
  );
  expect(() =>
    snapshotRasterGeometry({ width: 2021, height: 2000 }, geometry, "observe crop"),
  ).toThrow(
    new ActionableError(
      "observe crop screenshot and screen geometry have incompatible aspect ratios",
    ),
  );
});

test("rejects empty rasters and unusable native dimensions", () => {
  expect(() =>
    snapshotRasterGeometry(
      { width: 0, height: 100 },
      { platform: "android", screenSize: { width: 100, height: 100 } },
    ),
  ).toThrow(ActionableError);
  expect(() =>
    snapshotRasterGeometry(
      { width: 100, height: 100 },
      { platform: "android", screenSize: { width: NaN, height: 100 } },
    ),
  ).toThrow(ActionableError);
});

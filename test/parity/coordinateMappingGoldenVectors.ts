/**
 * Single-source drift-guard helpers for the cross-language coordinate-mapping golden vectors
 * (issue #4547, B0 of the canonical-pixel campaign #4547 -> #4548 -> #4549 -> #4550).
 *
 * Canonical source: `test/fixtures/coordinate-mapping-golden-vectors.json`. Consumers:
 * - Kotlin `CoordinateMappingGoldenVectorTest.kt` (desktop-core) holds inline copies of the five
 *   `DeviceScreenCoordinateMapper` sections, `DevicePoint.clampedTo`, and the scale-reporting
 *   contract; this module parses those committed literals out of the Kotlin source (the
 *   pinch-vector mechanism, see `pinchGoldenVectors.ts`) and the parity test verifies them against
 *   the JSON.
 * - TypeScript daemon tests read the JSON directly: `geometryPairing` drives the daemon's
 *   `pixelsMatchClaimedGeometry` pairing (`test/daemon/deviceDataStreamSocketServer.test.ts`) and
 *   `iosPointToPixel` drives the iOS point->pixel conversion
 *   (`test/daemon/observationInitialFrame.test.ts`).
 * - Swift: deliberately no consumer — the iOS runner performs no viewport<->device mapping (see
 *   the JSON header comment for the evidence trail).
 *
 * The reference implementations below mirror the Kotlin mapper opcode for opcode, with
 * `Math.fround` after each arithmetic step to reproduce Kotlin `Float` (32-bit) semantics exactly,
 * so the JSON is a *derived* source: a test recomputes every row's expected outputs from its
 * inputs and a bad hand-edit is caught at the root. `Math.round` matches Kotlin `roundToInt`
 * (both round ties toward positive infinity).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { extractNumbers, extractNumericTableRegion, REPO_ROOT } from "./pinchGoldenVectors";

export const COORDINATE_CANONICAL_JSON_PATH = join(
  REPO_ROOT,
  "test",
  "fixtures",
  "coordinate-mapping-golden-vectors.json",
);

export const SCALE_REPORTING_SWIFT_TEST_PATH = join(
  REPO_ROOT,
  "ios",
  "control-proxy",
  "Tests",
  "CtrlProxyTests",
  "ElementLocatorTests.swift",
);

export const COORDINATE_KOTLIN_TEST_PATH = join(
  REPO_ROOT,
  "android",
  "desktop-core",
  "src",
  "test",
  "kotlin",
  "dev",
  "jasonpearson",
  "automobile",
  "desktop",
  "core",
  "layout",
  "CoordinateMappingGoldenVectorTest.kt",
);

export interface ViewportToDeviceVector {
  frameWidthPx: number;
  frameHeightPx: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  deviceWidth: number;
  deviceHeight: number;
  viewportX: number;
  viewportY: number;
  expectedX: number;
  expectedY: number;
  /** 1 = in bounds, 0 = out of bounds (kept numeric so the Kotlin table stays purely numeric). */
  expectedInBounds: number;
  willChangeUnderCanonicalPixels?: boolean;
}

export interface DeviceToViewportVector {
  deviceX: number;
  deviceY: number;
  frameWidthPx: number;
  frameHeightPx: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  deviceWidth: number;
  deviceHeight: number;
  expectedX: number;
  expectedY: number;
  willChangeUnderCanonicalPixels?: boolean;
}

export interface ClampedToVector {
  x: number;
  y: number;
  width: number;
  height: number;
  expectedX: number;
  expectedY: number;
  expectedInBounds: number;
}

export interface FitToViewportVector {
  imageWidth: number;
  imageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  padding: number;
  expectedWidthPx: number;
  expectedHeightPx: number;
}

export interface FitScaleVector {
  frameWidthPx: number;
  frameHeightPx: number;
  viewportWidth: number;
  viewportHeight: number;
  padding: number;
  expected: number;
}

export interface ScreenshotRotationVector {
  imageWidth: number;
  imageHeight: number;
  rootWidth: number;
  rootHeight: number;
  expected: number;
}

export interface GeometryPairingVector {
  /** -1 together with measuredHeight = -1 means the frame is unmeasurable. */
  measuredWidth: number;
  measuredHeight: number;
  claimedWidth: number;
  claimedHeight: number;
  /** 1 = the daemon pairs the screenshot with the claimed geometry, 0 = it must not. */
  expectedMatch: number;
}

export interface IosPointToPixelVector {
  pointWidth: number;
  pointHeight: number;
  /** 0 means the hierarchy carried no screenScale (the daemon defaults the multiplier to 1). */
  scale: number;
  expectedPixelWidth: number;
  expectedPixelHeight: number;
  willChangeUnderCanonicalPixels?: boolean;
}

/**
 * One runner-side scale-reporting row (#4548, B1): the physical screenshot pixel dimensions a
 * runner derives from its reported point dimensions and nativeScale
 * (`ElementLocator.computePixelDimensions` on iOS; the Android runner is the nativeScale=1
 * identity row — its bounds are already pixels, so it copies dimensions with no math).
 */
export interface ScaleReportingVector {
  pointWidth: number;
  pointHeight: number;
  nativeScale: number;
  expectedPixelWidth: number;
  expectedPixelHeight: number;
}

export interface CoordinateMappingGoldenVectors {
  viewportToDevice: ViewportToDeviceVector[];
  deviceToViewport: DeviceToViewportVector[];
  clampedTo: ClampedToVector[];
  fitToViewport: FitToViewportVector[];
  fitScale: FitScaleVector[];
  screenshotRotation: ScreenshotRotationVector[];
  geometryPairing: GeometryPairingVector[];
  iosPointToPixel: IosPointToPixelVector[];
  scaleReporting: ScaleReportingVector[];
}

const SECTION_NAMES = [
  "viewportToDevice",
  "deviceToViewport",
  "clampedTo",
  "fitToViewport",
  "fitScale",
  "screenshotRotation",
  "geometryPairing",
  "iosPointToPixel",
  "scaleReporting",
] as const;

export function loadCoordinateMappingVectors(): CoordinateMappingGoldenVectors {
  const parsed = JSON.parse(
    readFileSync(COORDINATE_CANONICAL_JSON_PATH, "utf8"),
  ) as CoordinateMappingGoldenVectors;
  validateCoordinateMappingVectors(parsed, COORDINATE_CANONICAL_JSON_PATH);
  return parsed;
}

/**
 * Strict structural validation of the canonical fixture, applied at LOAD time so every consumer
 * (Kotlin parity, daemon geometry-pairing, daemon point->pixel) fails closed on a malformed file.
 *
 * The Kotlin-backed sections are additionally guarded by `diffNumericRows`, but the daemon-only
 * sections (`geometryPairing`, `iosPointToPixel`) are consumed directly, where JS coercion would
 * hide corruption: `"375" * 2` is `750`, so a string-typed `pointWidth` passes BOTH the reference
 * recalculation and the real daemon path. Every declared numeric field must therefore be a raw,
 * finite `number` — a missing field (`undefined`) or a coercible impostor (`"375"`, `null`,
 * `false`) fails with the section, row, and field named. This also guarantees no expected field
 * is silently unmatched by a typo'd key: the canonical field list drives the check, not the row.
 */
export function validateCoordinateMappingVectors(
  parsed: CoordinateMappingGoldenVectors,
  source: string = COORDINATE_CANONICAL_JSON_PATH,
): void {
  for (const section of SECTION_NAMES) {
    if (!Array.isArray(parsed[section]) || parsed[section].length === 0) {
      throw new Error(`${source}: missing non-empty "${section}" array`);
    }
    const fields = SECTION_NUMERIC_FIELDS[section];
    parsed[section].forEach((row, index) => {
      for (const field of fields) {
        const value = (row as Record<string, unknown>)[field];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(
            `${source}: section ${section} row ${index} field ${field}: ` +
              `missing or non-numeric value (${JSON.stringify(value)})`,
          );
        }
      }
    });
  }
}

/** Chunk a flat number sequence into fixed-width rows, failing closed on misalignment. */
function chunkRows(numbers: number[], width: number, label: string): number[][] {
  if (numbers.length === 0 || numbers.length % width !== 0) {
    throw new Error(
      `${label}: expected a positive multiple of ${width} numbers, got ${numbers.length}`,
    );
  }
  const rows: number[][] = [];
  for (let i = 0; i < numbers.length; i += width) {
    rows.push(numbers.slice(i, i + width));
  }
  return rows;
}

/** Parse one Kotlin inline table (a `val <marker> = listOf(...)` literal) into fixed-width rows. */
function parseKotlinSection(marker: string, rowWidth: number): number[][] {
  const region = extractNumericTableRegion(COORDINATE_KOTLIN_TEST_PATH, marker, "(", ")");
  return chunkRows(
    extractNumbers(region),
    rowWidth,
    `${COORDINATE_KOTLIN_TEST_PATH} (${marker.trim()})`,
  );
}

/**
 * Parse the Swift inline copy of the scaleReporting table out of ElementLocatorTests.swift
 * (`let scaleReportingVectors: [[Double]] = [...]`) — the pinch-vector mechanism, so a
 * coordinated one-sided edit of the Swift math and its golden literals fails the parity test.
 */
export function parseSwiftScaleReportingTable(): ScaleReportingVector[] {
  const region = extractNumericTableRegion(
    SCALE_REPORTING_SWIFT_TEST_PATH,
    "let scaleReportingVectors: [[Double]] =",
    "[",
    "]",
  );
  return chunkRows(
    extractNumbers(region),
    5,
    `${SCALE_REPORTING_SWIFT_TEST_PATH} (scaleReportingVectors)`,
  ).map((row) => ({
    pointWidth: row[0],
    pointHeight: row[1],
    nativeScale: row[2],
    expectedPixelWidth: row[3],
    expectedPixelHeight: row[4],
  }));
}

export function parseKotlinViewportToDeviceTable(): ViewportToDeviceVector[] {
  return parseKotlinSection("val viewportToDeviceVectors =", 12).map((row) => ({
    frameWidthPx: row[0],
    frameHeightPx: row[1],
    scale: row[2],
    offsetX: row[3],
    offsetY: row[4],
    deviceWidth: row[5],
    deviceHeight: row[6],
    viewportX: row[7],
    viewportY: row[8],
    expectedX: row[9],
    expectedY: row[10],
    expectedInBounds: row[11],
  }));
}

export function parseKotlinDeviceToViewportTable(): DeviceToViewportVector[] {
  return parseKotlinSection("val deviceToViewportVectors =", 11).map((row) => ({
    deviceX: row[0],
    deviceY: row[1],
    frameWidthPx: row[2],
    frameHeightPx: row[3],
    scale: row[4],
    offsetX: row[5],
    offsetY: row[6],
    deviceWidth: row[7],
    deviceHeight: row[8],
    expectedX: row[9],
    expectedY: row[10],
  }));
}

export function parseKotlinClampedToTable(): ClampedToVector[] {
  return parseKotlinSection("val clampedToVectors =", 7).map((row) => ({
    x: row[0],
    y: row[1],
    width: row[2],
    height: row[3],
    expectedX: row[4],
    expectedY: row[5],
    expectedInBounds: row[6],
  }));
}

export function parseKotlinFitToViewportTable(): FitToViewportVector[] {
  return parseKotlinSection("val fitToViewportVectors =", 7).map((row) => ({
    imageWidth: row[0],
    imageHeight: row[1],
    viewportWidth: row[2],
    viewportHeight: row[3],
    padding: row[4],
    expectedWidthPx: row[5],
    expectedHeightPx: row[6],
  }));
}

export function parseKotlinFitScaleTable(): FitScaleVector[] {
  return parseKotlinSection("val fitScaleVectors =", 6).map((row) => ({
    frameWidthPx: row[0],
    frameHeightPx: row[1],
    viewportWidth: row[2],
    viewportHeight: row[3],
    padding: row[4],
    expected: row[5],
  }));
}

export function parseKotlinScreenshotRotationTable(): ScreenshotRotationVector[] {
  return parseKotlinSection("val screenshotRotationVectors =", 5).map((row) => ({
    imageWidth: row[0],
    imageHeight: row[1],
    rootWidth: row[2],
    rootHeight: row[3],
    expected: row[4],
  }));
}

export function parseKotlinScaleReportingTable(): ScaleReportingVector[] {
  return parseKotlinSection("val scaleReportingVectors =", 5).map((row) => ({
    pointWidth: row[0],
    pointHeight: row[1],
    nativeScale: row[2],
    expectedPixelWidth: row[3],
    expectedPixelHeight: row[4],
  }));
}

// ---------------------------------------------------------------------------
// Reference implementations (float32-exact ports of DeviceScreenCoordinateMapper)
// ---------------------------------------------------------------------------

const f = Math.fround;

/** Fallback aspect ratio for unknown image width — mirrors `FALLBACK_ASPECT_RATIO = 2.16f`. */
const FALLBACK_ASPECT_RATIO = f(2.16);

export function referenceViewportToDevice(vector: ViewportToDeviceVector): {
  x: number;
  y: number;
  inBounds: boolean;
} {
  const frameX = f(f(vector.viewportX - vector.offsetX) / vector.scale);
  const frameY = f(f(vector.viewportY - vector.offsetY) / vector.scale);
  const frameToDevice = vector.frameWidthPx > 0 ? f(vector.deviceWidth / vector.frameWidthPx) : 1;
  const x = Math.round(f(frameX * frameToDevice));
  const y = Math.round(f(frameY * frameToDevice));
  const inBounds = x >= 0 && x < vector.deviceWidth && y >= 0 && y < vector.deviceHeight;
  return { x, y, inBounds };
}

export function referenceDeviceToViewport(vector: DeviceToViewportVector): {
  x: number;
  y: number;
} {
  const deviceToFrame = vector.deviceWidth > 0 ? f(vector.frameWidthPx / vector.deviceWidth) : 1;
  const frameX = f(vector.deviceX * deviceToFrame);
  const frameY = f(vector.deviceY * deviceToFrame);
  return {
    x: f(f(frameX * vector.scale) + vector.offsetX),
    y: f(f(frameY * vector.scale) + vector.offsetY),
  };
}

/** Mirrors `DevicePoint.clampedTo`: pin to an addressable edge without inventing a point in an empty rect. */
export function referenceClampedTo(vector: ClampedToVector): {
  x: number;
  y: number;
  inBounds: number;
} {
  return {
    x: Math.min(Math.max(vector.x, 0), Math.max(vector.width - 1, 0)),
    y: Math.min(Math.max(vector.y, 0), Math.max(vector.height - 1, 0)),
    inBounds: vector.width > 0 && vector.height > 0 ? 1 : 0,
  };
}

export function referenceFitToViewport(vector: FitToViewportVector): {
  widthPx: number;
  heightPx: number;
} {
  const aspect =
    vector.imageWidth > 0 ? f(vector.imageHeight / vector.imageWidth) : FALLBACK_ASPECT_RATIO;
  const maxFrameWidth = Math.max(f(vector.viewportWidth - f(vector.padding * 2)), 1);
  const maxFrameHeight = Math.max(f(vector.viewportHeight - f(vector.padding * 2)), 1);
  if (f(maxFrameWidth * aspect) <= maxFrameHeight) {
    return { widthPx: maxFrameWidth, heightPx: f(maxFrameWidth * aspect) };
  }
  return { widthPx: f(maxFrameHeight / aspect), heightPx: maxFrameHeight };
}

export function referenceFitScale(vector: FitScaleVector): number {
  const paddedWidth = f(vector.frameWidthPx + f(vector.padding * 2));
  const paddedHeight = f(vector.frameHeightPx + f(vector.padding * 2));
  const raw = Math.min(
    f(vector.viewportWidth / paddedWidth),
    f(vector.viewportHeight / paddedHeight),
    1,
  );
  return Math.min(Math.max(raw, f(0.3)), 1);
}

export function referenceDetectScreenshotRotation(vector: ScreenshotRotationVector): number {
  const { imageWidth, imageHeight, rootWidth, rootHeight } = vector;
  if (imageWidth <= 0 || imageHeight <= 0 || rootWidth <= 0 || rootHeight <= 0) {
    return 0;
  }
  const imageIsPortrait = imageHeight > imageWidth;
  const boundsIsPortrait = rootHeight > rootWidth;
  if (imageIsPortrait && !boundsIsPortrait) {
    return 3;
  }
  if (!imageIsPortrait && boundsIsPortrait) {
    return 1;
  }
  return 0;
}

/** Mirrors the daemon's `pixelsMatchClaimedGeometry` (exact match OR swapped WxH, never scale). */
export function referenceGeometryPairing(vector: GeometryPairingVector): boolean {
  if (vector.measuredWidth < 0 || vector.measuredHeight < 0) {
    return false;
  }
  const sameOrientation =
    vector.measuredWidth === vector.claimedWidth && vector.measuredHeight === vector.claimedHeight;
  const swappedOrientation =
    vector.measuredWidth === vector.claimedHeight && vector.measuredHeight === vector.claimedWidth;
  return sameOrientation || swappedOrientation;
}

/** Mirrors the daemon's iOS point->pixel conversion: `Math.round(points * (scale || 1))`. */
export function referenceIosPointToPixel(vector: IosPointToPixelVector): {
  width: number;
  height: number;
} {
  const scale = vector.scale === 0 ? 1 : vector.scale;
  return {
    width: Math.round(vector.pointWidth * scale),
    height: Math.round(vector.pointHeight * scale),
  };
}

/**
 * Mirrors the runners' scale-reporting pixel-dimension derivation (#4548):
 * `ElementLocator.computePixelDimensions` computes `(point * nativeScale).rounded()` — round half
 * away from zero, which equals JS `Math.round` for the positive values these dimensions are. The
 * Android runner is the `nativeScale === 1` identity case (bounds are already pixels).
 */
export function referenceScaleReporting(vector: ScaleReportingVector): {
  pixelWidth: number;
  pixelHeight: number;
} {
  return {
    pixelWidth: Math.round(vector.pointWidth * vector.nativeScale),
    pixelHeight: Math.round(vector.pointHeight * vector.nativeScale),
  };
}

/**
 * Compare two same-shape numeric row arrays and return human-readable mismatch strings (empty
 * array === identical). This is the drift detector for the Kotlin inline tables: feed it a table
 * with a one-sided edit and it reports exactly which row and field diverged.
 */
export function diffNumericRows<T extends Record<string, number | boolean | undefined>>(
  actual: T[],
  expected: T[],
  fields: ReadonlyArray<keyof T & string>,
  tolerance = 1e-3,
): string[] {
  const diffs: string[] = [];
  if (actual.length !== expected.length) {
    diffs.push(`row count ${actual.length} !== ${expected.length}`);
    return diffs;
  }
  for (let i = 0; i < expected.length; i++) {
    for (const field of fields) {
      const a = actual[i][field];
      const e = expected[i][field];
      // Fail CLOSED on a missing, non-numeric, or non-finite field — validating the RAW value,
      // never a coerced one. `Number(undefined)` is NaN (silently "not different" under any
      // tolerance), and `Number(null)` / `Number(false)` / `Number("0")` all coerce to 0, so a
      // zero-valued canonical input corrupted to one of those would pass a coercing comparison
      // and neuter the drift guard exactly when the fixture is broken.
      if (
        typeof a !== "number" ||
        !Number.isFinite(a) ||
        typeof e !== "number" ||
        !Number.isFinite(e)
      ) {
        diffs.push(
          `row ${i} field ${field}: missing or non-numeric value ` +
            `(actual=${JSON.stringify(a)}, expected=${JSON.stringify(e)})`,
        );
        continue;
      }
      if (Math.abs(a - e) > tolerance) {
        diffs.push(`row ${i} field ${field}: ${a} !== ${e}`);
      }
    }
  }
  return diffs;
}

export const VIEWPORT_TO_DEVICE_FIELDS = [
  "frameWidthPx",
  "frameHeightPx",
  "scale",
  "offsetX",
  "offsetY",
  "deviceWidth",
  "deviceHeight",
  "viewportX",
  "viewportY",
  "expectedX",
  "expectedY",
  "expectedInBounds",
] as const;

export const DEVICE_TO_VIEWPORT_FIELDS = [
  "deviceX",
  "deviceY",
  "frameWidthPx",
  "frameHeightPx",
  "scale",
  "offsetX",
  "offsetY",
  "deviceWidth",
  "deviceHeight",
  "expectedX",
  "expectedY",
] as const;

export const CLAMPED_TO_FIELDS = [
  "x",
  "y",
  "width",
  "height",
  "expectedX",
  "expectedY",
  "expectedInBounds",
] as const;

export const FIT_TO_VIEWPORT_FIELDS = [
  "imageWidth",
  "imageHeight",
  "viewportWidth",
  "viewportHeight",
  "padding",
  "expectedWidthPx",
  "expectedHeightPx",
] as const;

export const FIT_SCALE_FIELDS = [
  "frameWidthPx",
  "frameHeightPx",
  "viewportWidth",
  "viewportHeight",
  "padding",
  "expected",
] as const;

export const SCREENSHOT_ROTATION_FIELDS = [
  "imageWidth",
  "imageHeight",
  "rootWidth",
  "rootHeight",
  "expected",
] as const;

export const GEOMETRY_PAIRING_FIELDS = [
  "measuredWidth",
  "measuredHeight",
  "claimedWidth",
  "claimedHeight",
  "expectedMatch",
] as const;

export const IOS_POINT_TO_PIXEL_FIELDS = [
  "pointWidth",
  "pointHeight",
  "scale",
  "expectedPixelWidth",
  "expectedPixelHeight",
] as const;

export const SCALE_REPORTING_FIELDS = [
  "pointWidth",
  "pointHeight",
  "nativeScale",
  "expectedPixelWidth",
  "expectedPixelHeight",
] as const;

/** Per-section canonical numeric field lists driving the load-time strict validation. */
const SECTION_NUMERIC_FIELDS: Record<(typeof SECTION_NAMES)[number], readonly string[]> = {
  viewportToDevice: VIEWPORT_TO_DEVICE_FIELDS,
  deviceToViewport: DEVICE_TO_VIEWPORT_FIELDS,
  clampedTo: CLAMPED_TO_FIELDS,
  fitToViewport: FIT_TO_VIEWPORT_FIELDS,
  fitScale: FIT_SCALE_FIELDS,
  screenshotRotation: SCREENSHOT_ROTATION_FIELDS,
  geometryPairing: GEOMETRY_PAIRING_FIELDS,
  iosPointToPixel: IOS_POINT_TO_PIXEL_FIELDS,
  scaleReporting: SCALE_REPORTING_FIELDS,
};

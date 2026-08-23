/**
 * Drift guard for the cross-language coordinate-mapping golden vectors (issue #4547, B0 of the
 * canonical-pixel campaign #4547 -> #4548 -> #4549 -> #4550).
 *
 * Single source of truth: `test/fixtures/coordinate-mapping-golden-vectors.json`. The Kotlin
 * consumer (`CoordinateMappingGoldenVectorTest.kt`, desktop-core) holds committed inline copies of
 * the five `DeviceScreenCoordinateMapper` sections; this suite parses those literals out of the
 * Kotlin source and asserts they match the JSON, so a coordinated one-sided edit (change the
 * mapper's math AND its golden literals without updating the JSON, or vice versa) fails here —
 * the same mechanism as `pinchGoldenVectorParity.test.ts`.
 *
 * The JSON is also a DERIVED source, not a hand-copy: float32-exact reference ports of the Kotlin
 * mapper (and of the daemon's pairing / point->pixel logic) recompute every row's expected outputs
 * from its inputs. The daemon sections (`geometryPairing`, `iosPointToPixel`) are additionally
 * consumed against the REAL daemon code in `test/daemon/deviceDataStreamSocketServer.test.ts` and
 * `test/daemon/observationInitialFrame.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import {
  CLAMPED_TO_FIELDS,
  COORDINATE_KOTLIN_TEST_PATH,
  DEVICE_TO_VIEWPORT_FIELDS,
  diffNumericRows,
  FIT_SCALE_FIELDS,
  FIT_TO_VIEWPORT_FIELDS,
  loadCoordinateMappingVectors,
  parseKotlinClampedToTable,
  parseSwiftScaleReportingTable,
  parseKotlinDeviceToViewportTable,
  parseKotlinFitScaleTable,
  parseKotlinFitToViewportTable,
  parseKotlinScaleReportingTable,
  parseKotlinScreenshotRotationTable,
  parseKotlinViewportToDeviceTable,
  referenceDetectScreenshotRotation,
  referenceClampedTo,
  referenceDeviceToViewport,
  referenceFitScale,
  referenceFitToViewport,
  referenceGeometryPairing,
  referenceIosPointToPixel,
  referenceScaleReporting,
  referenceViewportToDevice,
  SCALE_REPORTING_FIELDS,
  SCALE_REPORTING_SWIFT_TEST_PATH,
  SCREENSHOT_ROTATION_FIELDS,
  validateCoordinateMappingVectors,
  VIEWPORT_TO_DEVICE_FIELDS,
} from "./coordinateMappingGoldenVectors";

describe("coordinate-mapping golden vector parity (issue #4547)", function () {
  const canonical = loadCoordinateMappingVectors();
  const kotlinViewportToDevice = parseKotlinViewportToDeviceTable();
  const kotlinDeviceToViewport = parseKotlinDeviceToViewportTable();
  const kotlinClampedTo = parseKotlinClampedToTable();
  const kotlinFitToViewport = parseKotlinFitToViewportTable();
  const kotlinFitScale = parseKotlinFitScaleTable();
  const kotlinScreenshotRotation = parseKotlinScreenshotRotationTable();
  const kotlinScaleReporting = parseKotlinScaleReportingTable();
  const swiftScaleReporting = parseSwiftScaleReportingTable();

  test("canonical JSON exposes non-trivial tables for every section", function () {
    // Guards against an empty/renamed fixture silently making every parity assertion vacuous.
    expect(canonical.viewportToDevice.length).toBeGreaterThanOrEqual(10);
    expect(canonical.deviceToViewport.length).toBeGreaterThanOrEqual(3);
    expect(canonical.clampedTo.length).toBeGreaterThanOrEqual(4);
    expect(canonical.fitToViewport.length).toBeGreaterThanOrEqual(4);
    expect(canonical.fitScale.length).toBeGreaterThanOrEqual(3);
    expect(canonical.screenshotRotation.length).toBeGreaterThanOrEqual(6);
    expect(canonical.geometryPairing.length).toBeGreaterThanOrEqual(6);
    expect(canonical.iosPointToPixel.length).toBeGreaterThanOrEqual(4);
    expect(canonical.scaleReporting.length).toBeGreaterThanOrEqual(5);
  });

  test("issue #4569: the canonical source covers the deferred coordinate-mapping gaps", function () {
    expect(
      canonical.clampedTo.some(
        (row) =>
          row.x === -5 &&
          row.y === 102 &&
          row.width === 100 &&
          row.height === 100 &&
          row.expectedX === 0 &&
          row.expectedY === 99 &&
          row.expectedInBounds === 1,
      ),
    ).toBe(true);
    expect(
      canonical.clampedTo.some(
        (row) =>
          row.x === 5 &&
          row.y === 5 &&
          row.width === 0 &&
          row.height === 100 &&
          row.expectedX === 0 &&
          row.expectedY === 5 &&
          row.expectedInBounds === 0,
      ),
    ).toBe(true);
    expect(
      canonical.geometryPairing.some(
        (row) =>
          row.measuredHeight === row.claimedWidth &&
          row.measuredWidth !== row.claimedHeight &&
          row.expectedMatch === 0,
      ),
    ).toBe(true);
    expect(
      canonical.fitScale.some(
        (row) =>
          row.viewportWidth === row.frameWidthPx + row.padding * 2 &&
          row.viewportHeight === row.frameHeightPx + row.padding * 2 &&
          row.expected === 1,
      ),
    ).toBe(true);
    expect(
      canonical.fitScale.some(
        (row) =>
          row.viewportWidth / (row.frameWidthPx + row.padding * 2) === 0.3 && row.expected === 0.3,
      ),
    ).toBe(true);
    expect(
      canonical.iosPointToPixel.some(
        (row) =>
          row.pointWidth === 450 &&
          row.pointHeight === 750 &&
          row.scale === 2.61 &&
          row.expectedPixelWidth === 1175 &&
          row.expectedPixelHeight === 1958,
      ),
    ).toBe(true);
    expect(
      canonical.scaleReporting.some(
        (row) =>
          row.pointWidth === 450 &&
          row.pointHeight === 750 &&
          row.nativeScale === 2.61 &&
          row.expectedPixelWidth === 1175 &&
          row.expectedPixelHeight === 1958,
      ),
    ).toBe(true);
    expect(
      canonical.deviceToViewport.some(
        (row) =>
          row.deviceWidth === 0 && row.scale === 2 && row.offsetX === 10 && row.offsetY === 20,
      ),
    ).toBe(true);
  });

  test("B1: Swift scaleReporting literals are verified against the single source (issue #4548)", function () {
    expect(
      diffNumericRows(swiftScaleReporting, canonical.scaleReporting, SCALE_REPORTING_FIELDS),
    ).toEqual([]);
  });

  test("B1: Kotlin scaleReporting literals are verified against the single source", function () {
    expect(
      diffNumericRows(kotlinScaleReporting, canonical.scaleReporting, SCALE_REPORTING_FIELDS),
    ).toEqual([]);
  });

  test("B1: every scaleReporting row's expected pixels are DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.scaleReporting.length; i++) {
      const row = canonical.scaleReporting[i];
      const computed = referenceScaleReporting(row);
      expect(`${i}:${computed.pixelWidth}x${computed.pixelHeight}`).toBe(
        `${i}:${row.expectedPixelWidth}x${row.expectedPixelHeight}`,
      );
    }
  });

  test("B1: the scaleReporting table pins the scale/nativeScale distinction and the Android identity", function () {
    // At least one row must have a non-integral nativeScale a scale-based implementation could
    // not produce (Display Zoom / Plus downsampling), and the Android scale-1 identity row must
    // be present so both platforms' contracts live in the same table.
    expect(canonical.scaleReporting.some((row) => !Number.isInteger(row.nativeScale))).toBe(true);
    expect(
      canonical.scaleReporting.some(
        (row) =>
          row.nativeScale === 1 &&
          row.expectedPixelWidth === row.pointWidth &&
          row.expectedPixelHeight === row.pointHeight,
      ),
    ).toBe(true);
  });

  test("B1: the Swift runtime golden loop still drives computePixelDimensions", function () {
    // Literals <-> JSON parity alone would stay green if the Swift assertion loop were deleted.
    const swiftSource = readFileSync(SCALE_REPORTING_SWIFT_TEST_PATH, "utf8");
    expect(swiftSource).toContain("ElementLocator.computePixelDimensions(");
    expect(swiftSource).toContain("for (index, row) in scaleReportingVectors.enumerated()");
  });

  test("AC1: Kotlin viewportToDevice literals are verified against the single source", function () {
    expect(
      diffNumericRows(
        kotlinViewportToDevice,
        canonical.viewportToDevice,
        VIEWPORT_TO_DEVICE_FIELDS,
      ),
    ).toEqual([]);
  });

  test("AC1: Kotlin deviceToViewport literals are verified against the single source", function () {
    expect(
      diffNumericRows(
        kotlinDeviceToViewport,
        canonical.deviceToViewport,
        DEVICE_TO_VIEWPORT_FIELDS,
      ),
    ).toEqual([]);
  });

  test("AC1: Kotlin clampedTo literals are verified against the single source", function () {
    expect(diffNumericRows(kotlinClampedTo, canonical.clampedTo, CLAMPED_TO_FIELDS)).toEqual([]);
  });

  test("AC1: Kotlin fitToViewport literals are verified against the single source", function () {
    expect(
      diffNumericRows(kotlinFitToViewport, canonical.fitToViewport, FIT_TO_VIEWPORT_FIELDS),
    ).toEqual([]);
  });

  test("AC1: Kotlin fitScale literals are verified against the single source", function () {
    expect(diffNumericRows(kotlinFitScale, canonical.fitScale, FIT_SCALE_FIELDS)).toEqual([]);
  });

  test("AC1: Kotlin screenshotRotation literals are verified against the single source", function () {
    expect(
      diffNumericRows(
        kotlinScreenshotRotation,
        canonical.screenshotRotation,
        SCREENSHOT_ROTATION_FIELDS,
      ),
    ).toEqual([]);
  });

  test("AC2: a coordinated one-sided edit of the Kotlin table is detected", function () {
    // Simulate the failure mode the guard exists for: someone changes the Kotlin mapper's rounding
    // AND updates only the Kotlin golden literals. The untouched JSON no longer matches.
    const tampered = kotlinViewportToDevice.map((row) => ({ ...row }));
    tampered[0] = { ...tampered[0], expectedX: tampered[0].expectedX + 5 };
    const diffs = diffNumericRows(tampered, canonical.viewportToDevice, VIEWPORT_TO_DEVICE_FIELDS);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("row 0 field expectedX"))).toBe(true);
  });

  test("AC2: an input-tuple divergence is also detected", function () {
    const tampered = kotlinScreenshotRotation.map((row) => ({ ...row }));
    tampered[2] = { ...tampered[2], rootWidth: tampered[2].rootWidth + 1 };
    const diffs = diffNumericRows(
      tampered,
      canonical.screenshotRotation,
      SCREENSHOT_ROTATION_FIELDS,
    );
    expect(diffs.some((d) => d.includes("rootWidth"))).toBe(true);
  });

  test("AC2: the guard fails CLOSED on a missing field, not open", function () {
    // `Number(undefined)` is NaN and NaN compares as "not different" under any tolerance check,
    // so a malformed row (deleted field, typo'd key) must be reported as drift — silently
    // passing would neuter the guard exactly when the fixture is broken.
    const tampered = kotlinViewportToDevice.map((row) => ({ ...row }));
    delete (tampered[3] as Partial<(typeof tampered)[number]>).expectedY;
    const diffs = diffNumericRows(tampered, canonical.viewportToDevice, VIEWPORT_TO_DEVICE_FIELDS);
    expect(
      diffs.some(
        (d) => d.includes("row 3 field expectedY") && d.includes("missing or non-numeric"),
      ),
    ).toBe(true);
  });

  test("AC2: the guard rejects a coercible non-numeric field, not just a missing one", function () {
    // `Number(null)`, `Number(false)`, and `Number("0")` all coerce to 0, so a ZERO-valued
    // canonical input (offsetX is 0 in most rows) corrupted to one of those would pass a
    // coercing comparison — the raw value must be validated as a genuine finite number.
    for (const corrupted of [null, false, "0"]) {
      const tampered = canonical.viewportToDevice.map((row) => ({ ...row }));
      expect(tampered[0].offsetX).toBe(0); // the coercion-equivalent target the guard must catch
      (tampered[0] as Record<string, unknown>).offsetX = corrupted;
      const diffs = diffNumericRows(kotlinViewportToDevice, tampered, VIEWPORT_TO_DEVICE_FIELDS);
      expect(
        diffs.some(
          (d) => d.includes("row 0 field offsetX") && d.includes("missing or non-numeric"),
        ),
      ).toBe(true);
    }
  });

  test("AC2: daemon-only sections are strictly validated at load time", function () {
    // The Kotlin-backed sections get a second layer via diffNumericRows, but geometryPairing and
    // iosPointToPixel are consumed directly by the daemon tests, where JS coercion hides
    // corruption: `"375" * 2 === 750`, so a string-typed pointWidth would pass BOTH the reference
    // recalculation and the real daemon path. The loader must reject it with the location named.
    const corrupted = structuredClone(canonical);
    (corrupted.iosPointToPixel[0] as Record<string, unknown>).pointWidth = "375";
    expect(() => validateCoordinateMappingVectors(corrupted, "fixture.json")).toThrow(
      /fixture\.json: section iosPointToPixel row 0 field pointWidth: missing or non-numeric value \("375"\)/,
    );
    // A deleted expected field in a daemon-only section must also fail (no silent unmatch).
    const missing = structuredClone(canonical);
    delete (missing.geometryPairing[2] as Partial<(typeof missing.geometryPairing)[number]>)
      .expectedMatch;
    expect(() => validateCoordinateMappingVectors(missing, "fixture.json")).toThrow(
      /section geometryPairing row 2 field expectedMatch/,
    );
    // And the shipped fixture passes (already exercised by loadCoordinateMappingVectors above).
    expect(() => validateCoordinateMappingVectors(canonical, "fixture.json")).not.toThrow();
  });

  test("the Kotlin runtime golden loops still drive the real mapper", function () {
    // This guard only proves literals <-> JSON. The math <-> literals half lives in the Kotlin
    // test's runtime loops. If someone deleted those loops but kept the tables, this parity suite
    // would still pass while the mapper drifted — assert the assertion-driving symbols exist.
    const kotlinSource = readFileSync(COORDINATE_KOTLIN_TEST_PATH, "utf8");
    for (const symbol of [
      "viewportToDevice(",
      "deviceToViewport(",
      "clampedTo(",
      "fitToViewport(",
      "fitScale(",
      "detectScreenshotRotation(",
      "assertEquals",
    ]) {
      expect(kotlinSource).toContain(symbol);
    }
    for (const methodName of [
      "viewportToDevice matches the golden vectors",
      "deviceToViewport matches the golden vectors",
      "clampedTo matches the golden vectors",
      "fitToViewport matches the golden vectors",
      "fitScale matches the golden vectors",
      "detectScreenshotRotation matches the golden vectors",
      "scale reporting matches the golden vectors",
    ]) {
      expect(kotlinSource).toMatch(new RegExp(String.raw`@Test\s+fun \`${methodName}\`\(\)`));
    }
    for (const [methodName, productionCall] of [
      ["viewportToDevice matches the golden vectors", "mapper.viewportToDevice("],
      ["deviceToViewport matches the golden vectors", "mapper.deviceToViewport("],
      [
        "clampedTo matches the golden vectors",
        "DevicePoint(vector.x, vector.y, inBounds = false).clampedTo(",
      ],
      ["fitToViewport matches the golden vectors", "mapper.fitToViewport("],
      ["fitScale matches the golden vectors", "mapper.fitScale("],
      ["detectScreenshotRotation matches the golden vectors", "mapper.detectScreenshotRotation("],
      [
        "scale reporting matches the golden vectors",
        "(vector.pointWidth * vector.nativeScale).roundToInt()",
      ],
    ]) {
      const methodStart = kotlinSource.indexOf(`fun \`${methodName}\`()`);
      const bodyStart = kotlinSource.indexOf("{", methodStart);
      const nextTest = kotlinSource.indexOf("\n  @Test", bodyStart);
      const body = kotlinSource.slice(bodyStart, nextTest === -1 ? kotlinSource.length : nextTest);
      expect(methodStart).toBeGreaterThanOrEqual(0);
      expect(body).toContain(productionCall);
      expect(body).toContain("assertEquals(");
    }
  });

  test("every viewportToDevice row's expected outputs are DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.viewportToDevice.length; i++) {
      const row = canonical.viewportToDevice[i];
      const computed = referenceViewportToDevice(row);
      expect(`${i}:${computed.x},${computed.y},${computed.inBounds ? 1 : 0}`).toBe(
        `${i}:${row.expectedX},${row.expectedY},${row.expectedInBounds}`,
      );
    }
  });

  test("every deviceToViewport row's expected outputs are DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.deviceToViewport.length; i++) {
      const row = canonical.deviceToViewport[i];
      const computed = referenceDeviceToViewport(row);
      expect(Math.abs(computed.x - row.expectedX)).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(computed.y - row.expectedY)).toBeLessThanOrEqual(1e-3);
    }
  });

  test("every clampedTo row's expected output is DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.clampedTo.length; i++) {
      const row = canonical.clampedTo[i];
      const computed = referenceClampedTo(row);
      expect(`${i}:${computed.x},${computed.y},${computed.inBounds}`).toBe(
        `${i}:${row.expectedX},${row.expectedY},${row.expectedInBounds}`,
      );
    }
  });

  test("every fitToViewport row's expected outputs are DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.fitToViewport.length; i++) {
      const row = canonical.fitToViewport[i];
      const computed = referenceFitToViewport(row);
      expect(Math.abs(computed.widthPx - row.expectedWidthPx)).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(computed.heightPx - row.expectedHeightPx)).toBeLessThanOrEqual(1e-3);
    }
  });

  test("every fitScale row's expected output is DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.fitScale.length; i++) {
      const row = canonical.fitScale[i];
      expect(referenceFitScale(row)).toBe(Math.fround(row.expected));
    }
  });

  test("every screenshotRotation row's expected code is DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.screenshotRotation.length; i++) {
      const row = canonical.screenshotRotation[i];
      expect(`${i}:${referenceDetectScreenshotRotation(row)}`).toBe(`${i}:${row.expected}`);
    }
  });

  test("every geometryPairing row's expected match is DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.geometryPairing.length; i++) {
      const row = canonical.geometryPairing[i];
      expect(`${i}:${referenceGeometryPairing(row) ? 1 : 0}`).toBe(`${i}:${row.expectedMatch}`);
    }
  });

  test("every iosPointToPixel row's expected pixels are DERIVABLE from its inputs", function () {
    for (let i = 0; i < canonical.iosPointToPixel.length; i++) {
      const row = canonical.iosPointToPixel[i];
      const computed = referenceIosPointToPixel(row);
      expect(`${i}:${computed.width}x${computed.height}`).toBe(
        `${i}:${row.expectedPixelWidth}x${row.expectedPixelHeight}`,
      );
    }
  });

  test("the reference math catches a corrupted expected value in the source", function () {
    // Negative control: a mis-typed expected endpoint must trip the derivation check.
    const row = canonical.viewportToDevice[0];
    const computed = referenceViewportToDevice(row);
    expect(computed.x).not.toBe(row.expectedX + 7);
  });

  test("AC3: the iOS rows were converted to canonical pixels under #4549", function () {
    // The flags are the campaign's cross-language marker; #4549 UPDATED these rows to their
    // post-conversion (canonical-pixel) values (the review artifact is this fixture's diff). The
    // flags are retained so a FUTURE conversion change still has to touch the fixture deliberately.
    expect(
      canonical.viewportToDevice.some((row) => row.willChangeUnderCanonicalPixels === true),
    ).toBe(true);
    expect(
      canonical.deviceToViewport.some((row) => row.willChangeUnderCanonicalPixels === true),
    ).toBe(true);
    expect(
      canonical.iosPointToPixel.every((row) => row.willChangeUnderCanonicalPixels === true),
    ).toBe(true);
    // Post-#4549 the flagged viewportToDevice rows are in PHYSICAL-PIXEL device space, which upscales
    // the point-space display frame: deviceWidth = frameWidthPx * nativeScale, strictly greater than
    // the frame width (an iOS point-class device dim equal to the frame width was the pre-#4549 state).
    for (const row of canonical.viewportToDevice) {
      if (row.willChangeUnderCanonicalPixels) {
        expect(row.deviceWidth).toBeGreaterThan(row.frameWidthPx);
      }
    }
  });
});

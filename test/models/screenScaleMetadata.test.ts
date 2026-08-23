import { describe, expect, test } from "bun:test";
import {
  readScreenScaleMetadata,
  screenScaleMetadataSpread,
} from "../../src/models/ScreenScaleMetadata";

describe("readScreenScaleMetadata (#4548)", () => {
  test("extracts complete, well-formed metadata", () => {
    expect(
      readScreenScaleMetadata({ nativeScale: 3.144, pixelWidth: 1179, pixelHeight: 2553 }),
    ).toEqual({ nativeScale: 3.144, pixelWidth: 1179, pixelHeight: 2553 });
    // The Android scale-1 identity contract.
    expect(
      readScreenScaleMetadata({ nativeScale: 1, pixelWidth: 1080, pixelHeight: 2340 }),
    ).toEqual({ nativeScale: 1, pixelWidth: 1080, pixelHeight: 2340 });
  });

  test("returns null for absent sources and pre-#4548 payloads", () => {
    expect(readScreenScaleMetadata(null)).toBeNull();
    expect(readScreenScaleMetadata(undefined)).toBeNull();
    expect(readScreenScaleMetadata({})).toBeNull();
    // The Android runner serializes absent optionals as JSON null (encodeDefaults=true).
    expect(
      readScreenScaleMetadata({ nativeScale: null, pixelWidth: null, pixelHeight: null }),
    ).toBeNull();
  });

  test("is all-or-nothing: partial metadata is never retained", () => {
    expect(readScreenScaleMetadata({ nativeScale: 3, pixelWidth: 1179 })).toBeNull();
    expect(readScreenScaleMetadata({ nativeScale: 3, pixelHeight: 2553 })).toBeNull();
    expect(readScreenScaleMetadata({ pixelWidth: 1179, pixelHeight: 2553 })).toBeNull();
  });

  test("rejects degenerate numeric values", () => {
    const valid = { nativeScale: 3, pixelWidth: 1179, pixelHeight: 2553 };
    expect(readScreenScaleMetadata({ ...valid, nativeScale: 0 })).toBeNull();
    expect(readScreenScaleMetadata({ ...valid, nativeScale: -2 })).toBeNull();
    expect(readScreenScaleMetadata({ ...valid, nativeScale: Number.NaN })).toBeNull();
    expect(readScreenScaleMetadata({ ...valid, pixelWidth: 0 })).toBeNull();
    expect(readScreenScaleMetadata({ ...valid, pixelWidth: -1 })).toBeNull();
    expect(readScreenScaleMetadata({ ...valid, pixelHeight: Number.POSITIVE_INFINITY })).toBeNull();
    // A coercible impostor (e.g. a string that survived JSON parsing) must not pass.
    expect(
      readScreenScaleMetadata({
        nativeScale: "3" as unknown as number,
        pixelWidth: 1179,
        pixelHeight: 2553,
      }),
    ).toBeNull();
  });
});

describe("screenScaleMetadataSpread (#4548)", () => {
  test("spreads the full tuple only when complete-finite-positive", () => {
    expect(
      screenScaleMetadataSpread({ nativeScale: 3.144, pixelWidth: 1179, pixelHeight: 2553 }),
    ).toEqual({ nativeScale: 3.144, pixelWidth: 1179, pixelHeight: 2553 });
  });

  test("spreads nothing (omits all keys) for absent / partial / degenerate input", () => {
    for (const source of [
      null,
      undefined,
      {},
      { nativeScale: 3, pixelWidth: 1179 }, // partial
      { nativeScale: 0, pixelWidth: 1179, pixelHeight: 2553 }, // degenerate
      { nativeScale: null, pixelWidth: null, pixelHeight: null }, // runner JSON nulls
    ]) {
      const spread = screenScaleMetadataSpread(source as never);
      expect(Object.keys(spread)).toEqual([]);
      // Spreading it into an object adds no keys — the byte-identical-legacy guarantee.
      expect({ a: 1, ...spread }).toEqual({ a: 1 });
    }
  });

  test("uses the SAME acceptance rule as readScreenScaleMetadata", () => {
    const cases = [
      { nativeScale: 3.144, pixelWidth: 1179, pixelHeight: 2553 },
      { nativeScale: 3.144, pixelWidth: 1179 },
      { nativeScale: -1, pixelWidth: 1179, pixelHeight: 2553 },
      {},
    ];
    for (const c of cases) {
      const validated = readScreenScaleMetadata(c as never);
      const spread = screenScaleMetadataSpread(c as never);
      expect(spread).toEqual(validated ?? {});
    }
  });
});

import { describe, expect, test } from "bun:test";
import {
  capToQualityPreset,
  qualityPresetBitrateBps,
  QUALITY_PRESET_MAX_LONG_SIDE,
  type CaptureQualityPreset,
} from "../../../src/features/webrtc/qualityPresets";

describe("qualityPresets", () => {
  test("returns the exact input without a quality preset", () => {
    const size = { width: 3, height: 2000 };
    expect(capToQualityPreset(size, undefined)).toBe(size);
  });

  const presets: [CaptureQualityPreset, number, number][] = [
    ["low", 540, 2_000_000],
    ["medium", 720, 4_000_000],
    ["high", 1080, 8_000_000],
  ];
  for (const [preset, cap, bitrate] of presets) {
    test(`${preset} caps portrait, landscape and square long edges`, () => {
      expect(capToQualityPreset({ width: 1200, height: 2400 }, preset)).toEqual({
        width: cap / 2,
        height: cap,
      });
      expect(capToQualityPreset({ width: 2400, height: 1200 }, preset)).toEqual({
        width: cap,
        height: cap / 2,
      });
      expect(capToQualityPreset({ width: 2400, height: 2400 }, preset)).toEqual({
        width: cap,
        height: cap,
      });
    });
    test(`${preset} even-rounds within-cap sizes`, () => {
      expect(capToQualityPreset({ width: cap - 1, height: 301 }, preset)).toEqual({
        width: cap - 2,
        height: 300,
      });
      expect(capToQualityPreset({ width: 301, height: cap - 1 }, preset)).toEqual({
        width: 300,
        height: cap - 2,
      });
    });
    test(`${preset} matches the bitrate and long-edge table`, () => {
      expect(qualityPresetBitrateBps(preset)).toBe(bitrate);
      expect(QUALITY_PRESET_MAX_LONG_SIDE[preset]).toBe(cap);
    });
  }
  test("has no default bitrate without a preset", () => {
    expect(qualityPresetBitrateBps(undefined)).toBeUndefined();
  });
  test("clamps a degenerate portrait after even-rounding", () => {
    expect(capToQualityPreset({ width: 3, height: 2000 }, "high")).toEqual({
      width: 2,
      height: 1080,
    });
  });
  test("clamps a degenerate landscape after even-rounding", () => {
    expect(capToQualityPreset({ width: 2000, height: 3 }, "high")).toEqual({
      width: 1080,
      height: 2,
    });
  });
  test("clamps tiny within-cap dimensions", () => {
    expect(capToQualityPreset({ width: 1, height: 1 }, "low")).toEqual({ width: 2, height: 2 });
    expect(capToQualityPreset({ width: 0.5, height: 3 }, "low")).toEqual({ width: 2, height: 2 });
  });
  test("preserves even within-cap dimensions without a clamp", () => {
    expect(capToQualityPreset({ width: 2, height: 4 }, "low")).toEqual({ width: 2, height: 4 });
  });
  for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
    for (const axis of ["width", "height"] as const) {
      test(`preserves input with invalid ${axis} ${invalid}`, () => {
        const size = { width: 2000, height: 2000, [axis]: invalid };
        expect(capToQualityPreset(size, "high")).toBe(size);
      });
    }
  }
});

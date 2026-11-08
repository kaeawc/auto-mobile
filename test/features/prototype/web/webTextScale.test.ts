import { describe, expect, test } from "bun:test";
import { PrototypeWebInputError } from "../../../../src/features/prototype/web/prototypeWebInputError";
import {
  androidTextScale,
  iosTextScale,
  stillTextScale,
  type PrototypeContentSize,
} from "../../../../src/features/prototype/web/webTextScale";

const round = (value: number): number => Number(value.toFixed(3));

describe("still text scale (#16552)", () => {
  test("Android 14 maps sp through the non-linear table at 200 %", () => {
    const scale = androidTextScale(2);
    expect(scale.font(14)).toBe(26);
    // Between table keys: 16 sp sits halfway between 14 (26 dp) and 18 (30 dp).
    expect(scale.font(16)).toBe(28);
    // Below the first key it interpolates from zero.
    expect(scale.font(4)).toBe(8);
    // At and past the last key large text stops growing.
    expect(scale.font(200)).toBe(200);
    expect(round(scale.font(57))).toBe(61.914);
    expect(scale.tracking(14)).toBe(26);
  });

  test("Android interpolates between neighbouring tables, and from 1x below 1.15", () => {
    expect(round(androidTextScale(1.65).font(14))).toBe(23.2);
    expect(round(androidTextScale(1.1).font(14))).toBe(15.6);
  });

  test("Android scales linearly below 1.03", () => {
    expect(round(androidTextScale(0.85).font(20))).toBe(17);
    expect(round(androidTextScale(1.02).font(14))).toBe(14.28);
  });

  test("iOS scales by the body style's point size and leaves tracking alone", () => {
    const largest = iosTextScale("accessibility-extra-extra-extra-large");
    expect(round(largest.font(17))).toBe(53);
    expect(round(largest.font(14))).toBe(43.647);
    expect(largest.tracking(0.5)).toBe(0.5);
    expect(round(iosTextScale("extra-small").font(17))).toBe(14);
  });

  test("the default size on either platform needs no scale", () => {
    expect(stillTextScale("android", undefined)).toBeUndefined();
    expect(stillTextScale("android", { fontScale: 1 })).toBeUndefined();
    expect(stillTextScale("ios", { contentSize: "large" })).toBeUndefined();
  });

  test("refuses the other platform's option, out-of-range scales and unknown sizes", () => {
    expect(() => stillTextScale("android", { contentSize: "small" })).toThrow(
      PrototypeWebInputError,
    );
    expect(() => stillTextScale("ios", { fontScale: 1.5 })).toThrow(PrototypeWebInputError);
    expect(() => stillTextScale("android", { fontScale: 2.5 })).toThrow("outside Android's range");
    expect(() => stillTextScale("android", { fontScale: Number.NaN })).toThrow(
      PrototypeWebInputError,
    );
    // A caller outside TypeScript (a library embed) can pass any string.
    const huge: string = "huge";
    expect(() => stillTextScale("ios", { contentSize: huge as PrototypeContentSize })).toThrow(
      "Unknown contentSize",
    );
  });
});

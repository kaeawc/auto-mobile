import { describe, expect, test } from "bun:test";
import { formFactorFrom } from "../../src/models/formFactor";

describe("formFactorFrom", () => {
  test.each([
    ["phone geometry", { width: 1080, height: 2400, density: 420 }, "phone"],
    ["tablet geometry", { width: 1600, height: 2560, density: 320 }, "tablet"],
    ["foldable profile", { deviceType: "pixel_fold" }, "foldable"],
    ["foldable hint", { hint: "7.6in Flip" }, "foldable"],
    ["missing metadata", {}, "unknown"],
    ["zero density", { width: 1080, height: 2400, density: 0 }, "unknown"],
  ] as const)("returns %s", (_name, input, expected) => {
    expect(formFactorFrom(input)).toBe(expected);
  });

  test("documents deviceType fold precedence before an explicit phone hint", () => {
    expect(formFactorFrom({ deviceType: "pixel_fold", hint: "phone" })).toBe("foldable");
  });
});

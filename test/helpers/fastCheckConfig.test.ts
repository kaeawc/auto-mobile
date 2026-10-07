import { describe, expect, test } from "bun:test";
import { propertyParams } from "./fastCheckConfig";

describe("propertyParams", () => {
  test("uses a fixed seed and clamps requested runs to the shared cap", () => {
    expect(propertyParams({ numRuns: 500 })).toEqual({ numRuns: 50, seed: 1_234_567 });
    expect(propertyParams({ numRuns: 12 })).toEqual({ numRuns: 12, seed: 1_234_567 });
    expect(propertyParams()).toEqual({ numRuns: 50, seed: 1_234_567 });
  });
});

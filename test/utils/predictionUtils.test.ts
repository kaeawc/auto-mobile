import { describe, expect, test } from "bun:test";
import { normalizeToolArgs } from "../../src/utils/predictionUtils";

describe("predictionUtils", () => {
  test("normalizes tool args with stable nested key ordering", () => {
    const first = normalizeToolArgs({
      z: 1,
      nested: { beta: true, alpha: false },
      a: 2
    });
    const second = normalizeToolArgs({
      a: 2,
      nested: { alpha: false, beta: true },
      z: 1
    });

    expect(first).toBe(second);
    expect(first).toBe(
      '{"a":2,"nested":{"alpha":false,"beta":true},"z":1}'
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  parsePrototypeDegradedEffects,
  prototypeDegradedEffectsOutput,
} from "../../../src/features/prototype/prototypeDegradedEffects";

describe("prototype degraded effect diagnostics", () => {
  const effect = { path: "root.style.effects[0]", type: "blur", reason: "api" as const };
  test("filters malformed entries individually and strips unknown fields", () => {
    expect(
      parsePrototypeDegradedEffects([
        null,
        [],
        1,
        {},
        { ...effect, path: 1 },
        { ...effect, type: "" },
        { ...effect, reason: "unknown" },
        { ...effect, extra: true },
      ]),
    ).toEqual([effect]);
  });
  test("empty, missing and malformed lists add no diagnostic fields", () => {
    for (const value of [undefined, null, {}, "bad", [], [null]]) {
      expect(prototypeDegradedEffectsOutput(value)).toEqual({});
    }
  });
});

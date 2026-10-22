import { findOffenseLines } from "./noLegacyAutomobilePathScan";
import { describe, expect, test } from "bun:test";

describe("legacy AutoMobile path matcher", () => {
  test("matches only quoted .automobile literals", () => {
    expect(findOffenseLines("const a = \".automobile\";\nconst b = '.automobile';")).toEqual([
      1, 2,
    ]);
    expect(
      findOffenseLines(
        'const a = ".automobile\';\nconst b = \'.automobile";\nconst c = ".automobile-foo";',
      ),
    ).toEqual([]);
  });
});

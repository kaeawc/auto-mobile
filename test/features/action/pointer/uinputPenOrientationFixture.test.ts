import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("pen orientation fixtures", () => {
  it.each([0, 1, 2, 3])("preserves orientation at rotation %i", (rotation) => {
    const fixture = readFileSync(
      resolve(import.meta.dir, `../../../fixtures/android-pointer-probe/rotation-${rotation}.txt`),
      "utf8",
    );
    const readings = fixture
      .split("\n")
      .filter((line) => line.includes("PointerProbe"))
      .flatMap((line) => {
        const match = /orientation=(-?\d+(?:\.\d+)?)/.exec(line);
        return match ? [Number(match[1])] : [];
      });

    expect(readings.length).toBeGreaterThan(0);
    for (const orientation of readings) {
      expect(Math.abs(orientation - 0.8)).toBeLessThanOrEqual(0.01);
    }
  });
});

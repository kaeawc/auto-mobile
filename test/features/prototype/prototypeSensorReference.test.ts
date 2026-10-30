import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  detectPrototypeShakes,
  prototypeSensorRateValid,
  STANDARD_GRAVITY,
  roundPrototypeSensorValue,
  throttlePrototypeSensorSamples,
  type PrototypeAccelerationSample,
  type PrototypeSensorKey,
  type PrototypeSensorSample,
} from "../../../src/features/prototype/prototypeSensorReference";

const directory = path.join(import.meta.dir, "../../fixtures/prototype-sensors");
const fixtures = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, value: JSON.parse(readFileSync(path.join(directory, name), "utf8")) }));

interface ThrottleFixture {
  key: PrototypeSensorKey;
  rateHz: number;
  samples: PrototypeSensorSample[];
  expectedWrites: PrototypeSensorSample[];
}
interface ShakeFixture {
  samples: PrototypeAccelerationSample[];
  expectedShakes: number[];
}

describe("shared sensor sample streams", () => {
  test("the fixture set covers throttling and shake detection", () => {
    expect(fixtures.some(({ name }) => name.startsWith("throttle-"))).toBe(true);
    expect(fixtures.some(({ name }) => name.startsWith("shake-"))).toBe(true);
  });

  for (const { name, value } of fixtures) {
    test(name, () => {
      if (name.startsWith("throttle-")) {
        const fixture = value as ThrottleFixture;
        expect(
          throttlePrototypeSensorSamples(fixture.key, fixture.samples, fixture.rateHz),
        ).toEqual(fixture.expectedWrites);
      } else {
        const fixture = value as ShakeFixture;
        expect(detectPrototypeShakes(fixture.samples)).toEqual(fixture.expectedShakes);
      }
    });
  }
});

describe("roundPrototypeSensorValue", () => {
  test("rounds to whole units and folds or clamps by key", () => {
    expect(roundPrototypeSensorValue("headingDeg", 359.5)).toBe(0);
    expect(roundPrototypeSensorValue("headingDeg", -90)).toBe(270);
    expect(roundPrototypeSensorValue("rollDeg", -181)).toBe(-180);
    expect(roundPrototypeSensorValue("lightLux", 12.49)).toBe(12);
    expect(roundPrototypeSensorValue("steps", -1)).toBe(0);
  });
});

describe("throttlePrototypeSensorSamples", () => {
  test("refuses a rate outside 1 to 30 Hz and skips non-finite samples", () => {
    expect(prototypeSensorRateValid(30)).toBe(true);
    expect(prototypeSensorRateValid(0)).toBe(false);
    expect(prototypeSensorRateValid(31)).toBe(false);
    expect(prototypeSensorRateValid(2.5)).toBe(false);
    expect(() => throttlePrototypeSensorSamples("lightLux", [], 31)).toThrow(RangeError);
    expect(
      throttlePrototypeSensorSamples(
        "lightLux",
        [
          { timestampMs: 0, value: Number.NaN },
          { timestampMs: 10, value: 4 },
        ],
        1,
      ),
    ).toEqual([{ timestampMs: 10, value: 4 }]);
  });
});

describe("detectPrototypeShakes", () => {
  test("a peak exactly at the threshold is a shake", () => {
    const peak = { timestampMs: 5, x: 0, y: 0, z: 2 * STANDARD_GRAVITY };
    expect(detectPrototypeShakes([peak], 2)).toEqual([5]);
    expect(detectPrototypeShakes([{ ...peak, z: 1.99 * STANDARD_GRAVITY }], 2)).toEqual([]);
  });
});

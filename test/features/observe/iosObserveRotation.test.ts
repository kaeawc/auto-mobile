import { expect, test } from "bun:test";
import { resolveIosObserveRotation } from "../../../src/features/observe/iosObserveRotation";

const portrait = { width: 402, height: 874 };
const landscape = { width: 874, height: 402 };

test.each([
  [0, portrait, 0],
  [1, landscape, 1],
  [2, portrait, 2],
  [3, landscape, 3],
  [undefined, portrait, 0],
  [undefined, landscape, 1],
  [undefined, { width: 400, height: 400 }, 1],
  [1, portrait, 0],
  [3, portrait, 0],
  [0, { width: 951, height: 669 }, 0],
  [2, { width: 951, height: 669 }, 2],
  [0.5, portrait, 0],
  [-1, landscape, 1],
  [4, portrait, 0],
  [NaN, landscape, 1],
] as const)("resolves runner %s with screen %j to %s", (rotation, screenSize, expected) => {
  expect(resolveIosObserveRotation(rotation, screenSize)).toBe(expected);
});

test("does not invent rotation without usable screen dimensions", () => {
  for (const screenSize of [
    { width: 0, height: 0 },
    { width: NaN, height: 400 },
    { width: 400, height: Infinity },
  ]) {
    expect(resolveIosObserveRotation(undefined, screenSize)).toBeUndefined();
    expect(resolveIosObserveRotation(3, screenSize)).toBe(3);
  }
});

test("returns unknown without runner rotation or screen size", () => {
  expect(resolveIosObserveRotation(undefined, undefined)).toBeUndefined();
});

test.each([0, 1, 2, 3])("preserves runner rotation %s without screen size", (rotation) => {
  expect(resolveIosObserveRotation(rotation, undefined)).toBe(rotation);
});

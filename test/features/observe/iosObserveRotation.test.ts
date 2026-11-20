import { expect, test } from "bun:test";
import { observedIosOrientation } from "../../../src/features/action/iosRotateVerification";
import type { ObserveResult } from "../../../src/models";
import {
  hasMultiplePanels,
  resolveIosObserveRotation,
  resolveIosRunnerRotation,
} from "../../../src/features/observe/iosObserveRotation";
import staleAfterUnfold from "../../fixtures/ios-duo/observe-inner-stale-portrait-after-unfold-18831.json";

const portrait = { width: 402, height: 874 };
const landscape = { width: 874, height: 402 };
const floatingWindow = { width: 997, height: 782 };

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
  [0, { width: 400, height: 400 }, 0],
  [3, { width: 400, height: 400 }, 3],
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

test("a stale runner portrait right after a Duo unfold resolves to landscape (#18831)", () => {
  const { runnerRotation, screenSize } = staleAfterUnfold;
  const rotation = resolveIosObserveRotation(runnerRotation, screenSize, true);
  expect(rotation).toBe(1);
  const observation = { screenSize, rotation } as Pick<ObserveResult, "screenSize" | "rotation">;
  expect(observedIosOrientation(observation as ObserveResult)).toBe("landscape");
});

test.each([
  [0, { width: 951, height: 669 }, 0],
  [2, { width: 951, height: 669 }, 2],
  [1, portrait, 0],
  [3, landscape, 3],
  [undefined, landscape, 1],
] as const)(
  "runner geometry keeps a stale portrait: runner %s with %j is %s",
  (rotation, size, expected) => {
    expect(resolveIosRunnerRotation(rotation, size)).toBe(expected);
  },
);

test.each([
  [0, 1],
  [2, 1],
] as const)(
  "a multi-panel device corrects runner %s on a landscape-shaped panel to %s",
  (runner, expected) => {
    expect(resolveIosObserveRotation(runner, { width: 951, height: 669 }, true)).toBe(expected);
  },
);

test("a single-panel iPad portrait with a landscape-shaped floating window stays portrait", () => {
  expect(resolveIosObserveRotation(0, floatingWindow)).toBe(0);
  expect(resolveIosObserveRotation(2, floatingWindow, false)).toBe(2);
});

test("a Duo cover panel and a plain iPhone resolve the same with or without the panel flag", () => {
  for (const [runner, size] of [
    [0, portrait],
    [1, portrait],
    [1, landscape],
    [3, landscape],
    [undefined, landscape],
  ] as const) {
    expect(resolveIosObserveRotation(runner, size, true)).toBe(
      resolveIosObserveRotation(runner, size, false),
    );
  }
});

test("hasMultiplePanels needs two or more panels", () => {
  expect(hasMultiplePanels({})).toBe(false);
  expect(hasMultiplePanels({ displays: { panels: [{}] } })).toBe(false);
  expect(hasMultiplePanels({ displays: { panels: [{}, {}] } })).toBe(true);
});

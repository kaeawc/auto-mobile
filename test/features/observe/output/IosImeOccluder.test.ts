import { describe, expect, test } from "bun:test";
import {
  getIosImeOccluder,
  getVisibleIosImeBounds,
  type ImeOccluder,
} from "../../../../src/features/observe/output/SkeletonProjection";
import { iosKeyboardCapture } from "../../../fixtures/observe/iosKeyboardTabbar";

const measured: ImeOccluder = {
  bounds: iosKeyboardCapture.ime.bounds,
  group: 1,
  windowRank: 2,
  spanEnter: 3,
  spanExit: 4,
};
const screen = iosKeyboardCapture.screenSize;

describe("iOS action keyboard geometry", () => {
  test("docked key union extends to both screen edges and screen bottom without mutation", () => {
    const original = structuredClone(measured);
    expect(getIosImeOccluder(measured, screen)).toEqual({
      ...measured,
      bounds: [0, measured.bounds[1], screen.width, screen.height],
    });
    expect(measured).toEqual(original);
  });

  test("90 percent horizontal span qualifies as docked", () => {
    const boundary = {
      ...measured,
      bounds: [
        0,
        measured.bounds[1],
        screen.width * 0.9,
        measured.bounds[3],
      ] as ImeOccluder["bounds"],
    };
    expect(getIosImeOccluder(boundary, screen).bounds).toEqual([
      0,
      measured.bounds[1],
      screen.width,
      screen.height,
    ]);
  });

  test("floating keyboard and unknown or invalid screen dimensions retain measured union", () => {
    const floating = {
      ...measured,
      bounds: [
        screen.width / 4,
        measured.bounds[1],
        (screen.width * 3) / 4,
        measured.bounds[3],
      ] as ImeOccluder["bounds"],
    };
    expect(getIosImeOccluder(floating, screen)).toBe(floating);
    for (const size of [
      undefined,
      { width: 0, height: screen.height },
      { width: screen.width, height: NaN },
      { width: Infinity, height: screen.height },
    ]) {
      expect(getIosImeOccluder(measured, size)).toBe(measured);
    }
  });
});

describe("visible iOS keyboard intersection", () => {
  test.each([
    ["fully visible floating", [50, 500, 250, 700], [50, 500, 250, 700]],
    ["partially visible floating", [-20, 800, 250, 1000], [0, 800, 250, 874]],
    ["partially off top", [50, -20, 250, 100], [50, 0, 250, 100]],
    ["docked", [0, 600, 402, 800], [0, 600, 402, 874]],
    ["off bottom per issue #9083", [0, 918, 402, 1144], undefined],
    ["at bottom", [0, 874, 402, 1144], undefined],
    ["off top docked", [0, -200, 402, 0], undefined],
    ["off left wide", [-500, 600, 0, 800], undefined],
    ["off right wide", [402, 600, 902, 800], undefined],
    ["sub-point sliver", [0, 873.5, 402, 1144], undefined],
    ["thin docked element above bottom", [0, 600, 402, 600.5], undefined],
    ["zero height", [0, 600, 402, 600], undefined],
    ["two-point minimum", [0, 872, 402, 1144], [0, 872, 402, 874]],
    ["zero width", [10, 500, 10, 700], undefined],
    ["invalid bounds", [0, NaN, 402, 800], undefined],
  ] as const)("clips %s without fabricating height", (_name, bounds, expected) => {
    const ime: ImeOccluder = { ...measured, bounds: [...bounds] };
    const original = structuredClone(ime);
    expect(getVisibleIosImeBounds(ime, { width: 402, height: 874 })).toEqual(expected);
    expect(ime).toEqual(original);
    if (
      expected === undefined &&
      bounds.every(Number.isFinite) &&
      bounds[1] !== 873.5 &&
      bounds[3] !== 600.5
    ) {
      expect(getIosImeOccluder(ime, { width: 402, height: 874 })).toBe(ime);
    }
  });

  test.each([
    undefined,
    { width: 0, height: 874 },
    { width: 402, height: 0 },
    { width: NaN, height: 874 },
    { width: 402, height: NaN },
    { width: Infinity, height: 874 },
    { width: 402, height: -1 },
  ])("unknown or invalid screen has no visible rectangle: %j", (size) => {
    expect(getVisibleIosImeBounds(measured, size)).toBeUndefined();
  });
});

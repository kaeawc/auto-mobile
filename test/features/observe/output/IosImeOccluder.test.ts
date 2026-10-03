import { describe, expect, test } from "bun:test";
import {
  getIosImeOccluder,
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

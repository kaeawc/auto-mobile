import { describe, expect, test } from "bun:test";
import {
  OBSERVED_INTERACTION_PROFILES,
  SETTLE_BUDGET_MS,
} from "../../../src/features/action/observedInteractionProfiles";

/**
 * Each profile replaced a flag bag that call sites used to spell out. The expectations below are
 * those literal flag sets, so changing a profile changes this test and not just the call sites.
 */
describe("observed interaction profiles", () => {
  test("rawCoordinateGesture is the bare changeExpected:false bag", () => {
    expect(OBSERVED_INTERACTION_PROFILES.rawCoordinateGesture).toEqual({ changeExpected: false });
  });

  test("selectorResolvedGesture adds resolvesTargetFromRead", () => {
    expect(OBSERVED_INTERACTION_PROFILES.selectorResolvedGesture).toEqual({
      changeExpected: false,
      resolvesTargetFromRead: true,
    });
  });

  test("noTreeResolution never resolves coordinates from the prior tree", () => {
    expect(OBSERVED_INTERACTION_PROFILES.noTreeResolution).toEqual({
      usesObservationForResolution: false,
      changeExpected: false,
    });
  });

  test("textEdit is hardware navigation that also skips the UI-stability wait", () => {
    expect(OBSERVED_INTERACTION_PROFILES.textEdit).toEqual({
      usesObservationForResolution: false,
      changeExpected: false,
      skipUiStability: true,
    });
  });

  test("appLaunch skips the previous read and defers the screenshot", () => {
    expect(OBSERVED_INTERACTION_PROFILES.appLaunch).toEqual({
      changeExpected: false,
      skipPreviousObserve: true,
      deferPostActionScreenshot: true,
    });
  });

  test("exactly the documented profiles exist", () => {
    expect(Object.keys(OBSERVED_INTERACTION_PROFILES).sort()).toEqual([
      "appLaunch",
      "noTreeResolution",
      "rawCoordinateGesture",
      "selectorResolvedGesture",
      "textEdit",
    ]);
  });

  test("a later key overrides the profile, as call sites rely on", () => {
    expect({
      ...OBSERVED_INTERACTION_PROFILES.noTreeResolution,
      changeExpected: true,
    }).toEqual({ usesObservationForResolution: false, changeExpected: true });
  });

  test("settle budgets keep the literal values the call sites used", () => {
    expect(SETTLE_BUDGET_MS).toEqual({
      immediate: 100,
      brief: 500,
      gesture: 800,
      navigation: 2000,
      systemUi: 3000,
      lifecycle: 5000,
      longGesture: 8000,
      urlDispatch: 12000,
    });
  });
});

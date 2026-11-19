import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../../src/models/ActionableError";
import { carPlayCaptureDisplay, captureCarPlayScreen } from "../../../src/utils/ios/carPlayCapture";
import {
  assertCarPlayProjecting,
  parseCarPlayProjectionState,
} from "../../../src/utils/ios/carPlayProjection";
import { FakeCarPlayProjectionProbe } from "../../fakes/FakeCarPlayProjectionProbe";

function readProjectionFixture(state: "car" | "airplay" | "not-found") {
  const path = join(
    import.meta.dir,
    "../../fixtures/ios-carplay",
    `projection-probe-ios26.5-${state}.json`,
  );
  return parseCarPlayProjectionState(readFileSync(path, "utf8"));
}

describe("CarPlay capture", () => {
  test("uses the projecting display's numeric ID", () => {
    const state = readProjectionFixture("car");
    assertCarPlayProjecting(state);
    expect(carPlayCaptureDisplay(state)).toBe("2");
    expect(carPlayCaptureDisplay({ ...state, displayId: 7 })).toBe("7");
  });

  test("probes first and captures TVOut with the caller's signal", async () => {
    const probe = new FakeCarPlayProjectionProbe(readProjectionFixture("car"));
    const image = Buffer.from("screenshot");
    const screenshot = mock(async () => {
      expect(probe.calls).toEqual(["udid"]);
      return image;
    });
    const { signal } = new AbortController();

    expect(await captureCarPlayScreen("udid", { probe, screenshot }, signal)).toBe(image);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(screenshot).toHaveBeenCalledWith("udid", "2", signal);
  });

  test.each([
    ["airplay", "not projecting (AirPlay[2])"],
    ["not-found", "No CarPlay display was found"],
  ] as const)("refuses %s before taking a screenshot", async (fixture, message) => {
    const probe = new FakeCarPlayProjectionProbe(readProjectionFixture(fixture));
    const screenshot = mock(async () => Buffer.from("screenshot"));

    await expect(captureCarPlayScreen("udid", { probe, screenshot })).rejects.toThrow(message);
    expect(screenshot).not.toHaveBeenCalled();
  });

  test("propagates a probe failure without taking a screenshot", async () => {
    const probe = new FakeCarPlayProjectionProbe(readProjectionFixture("car"));
    const failure = new ActionableError("probe failed");
    probe.error = failure;
    const screenshot = mock(async () => Buffer.from("screenshot"));

    await expect(captureCarPlayScreen("udid", { probe, screenshot })).rejects.toBe(failure);
    expect(screenshot).not.toHaveBeenCalled();
  });
});

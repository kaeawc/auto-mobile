import { describe, expect, mock, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { carPlayCaptureDisplay, captureCarPlayScreen } from "../../../src/utils/ios/carPlayCapture";
import {
  assertCarPlayProjecting,
  parseCarPlayProjectionState,
} from "../../../src/utils/ios/carPlayProjection";
import { FakeCarPlayProjectionProbe } from "../../fakes/FakeCarPlayProjectionProbe";
import { FakeCarPlayRuntimeReader } from "../../fakes/FakeCarPlayRuntimeReader";

// Real projection probe captures from fresh iPhone 17 Pro simulators (#18728), the same lines
// test/utils/ios/carPlayProjection.test.ts parses.
// iOS 26.5 after carplay-power-helper power-on: TVOut is the car display.
const carJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Car[2]","isCarDisplay":true,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":32}';
// iOS 26.5 after boot, before power-on: TVOut attached, untagged.
const untaggedJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Untagged[2]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":0}';
// iOS 27.0 wireless0 AirPlay capture.
const airPlayJson =
  '{"deviceName":"wireless0","displayId":3,"displayType":2,"found":true,"identity":"AirPlay[3]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":"Wireless","tag":4}';
const absentJson =
  '{"deviceName":null,"displayId":null,"displayType":null,"found":false,"identity":null,"isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":null,"tag":null}';

describe("CarPlay capture", () => {
  test("uses the projecting display's numeric ID", () => {
    const state = parseCarPlayProjectionState(carJson);
    assertCarPlayProjecting(state);
    expect(carPlayCaptureDisplay(state)).toBe("2");
    expect(carPlayCaptureDisplay({ ...state, displayId: 7 })).toBe("7");
  });

  test("probes first and captures TVOut with the caller's signal", async () => {
    const probe = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(carJson));
    const image = Buffer.from("screenshot");
    const screenshot = mock(async () => {
      expect(probe.calls).toEqual(["udid"]);
      return image;
    });
    const { signal } = new AbortController();

    expect(
      await captureCarPlayScreen(
        "udid",
        { probe, runtime: new FakeCarPlayRuntimeReader(), screenshot },
        signal,
      ),
    ).toBe(image);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(screenshot).toHaveBeenCalledWith("udid", "2", signal);
  });

  test.each([
    [untaggedJson, "not projecting (Untagged[2])"],
    [airPlayJson, "not projecting (AirPlay[3])"],
    [absentJson, "No CarPlay screen (TVOut or AirPlay"],
  ] as const)(
    "refuses %s with the power-on remedy before taking a screenshot",
    async (json, message) => {
      const probe = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(json));
      const screenshot = mock(async () => Buffer.from("screenshot"));

      const result = captureCarPlayScreen("udid", {
        probe,
        runtime: new FakeCarPlayRuntimeReader(),
        screenshot,
      });
      await expect(result).rejects.toThrow(message);
      await expect(result).rejects.toThrow("carplay-power-helper power-on");
      expect(screenshot).not.toHaveBeenCalled();
    },
  );

  test("propagates a probe failure without taking a screenshot", async () => {
    const probe = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(carJson));
    const failure = new ActionableError("probe failed");
    probe.error = failure;
    const screenshot = mock(async () => Buffer.from("screenshot"));

    await expect(
      captureCarPlayScreen("udid", { probe, runtime: new FakeCarPlayRuntimeReader(), screenshot }),
    ).rejects.toBe(failure);
    expect(screenshot).not.toHaveBeenCalled();
  });
});

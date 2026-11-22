import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { parseCarPlayProjectionState } from "../../../src/utils/ios/carPlayProjection";
import {
  type CarPlayTapper,
  type CarPlayTapResult,
  DefaultCarPlayTapper,
  parseCarPlayTapResult,
  tapCarPlayScreen,
} from "../../../src/utils/ios/carPlayTap";
import { FakeCarPlayProjectionProbe } from "../../fakes/FakeCarPlayProjectionProbe";

// carplay-power-helper tap 558 80 stdout, captured on a fresh iOS 26.5 iPhone 17 Pro simulator
// after power-on; the tap opened CarPlay Settings.
const tapJson =
  '{"tapped":{"screenID":2,"height":480,"width":800,"y":80,"screenType":1,"x":558,"target":1}}';
// Projection probe captures from the same kind of simulator (#18728), as in carPlayCapture.test.ts.
const carJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Car[2]","isCarDisplay":true,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":32}';
const untaggedJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Untagged[2]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":0}';

class FakeCarPlayTapper implements CarPlayTapper {
  readonly calls: Array<{ udid: string; x: number; y: number; signal?: AbortSignal }> = [];
  constructor(private readonly result: CarPlayTapResult) {}
  async tap(udid: string, x: number, y: number, signal?: AbortSignal) {
    this.calls.push({ udid, x, y, signal });
    return this.result;
  }
}

describe("CarPlay tap", () => {
  test("parses the helper's tap JSON and rejects other shapes", () => {
    expect(parseCarPlayTapResult(tapJson).tapped).toEqual({
      x: 558,
      y: 80,
      screenID: 2,
      screenType: 1,
      target: 1,
      width: 800,
      height: 480,
    });
    for (const value of [
      "not json",
      "{}",
      tapJson.replace('"target":1', '"target":"1"'),
      tapJson.replace("}}", ',"extra":true}}'),
      tapJson.replace('"width":800', '"width":0'),
    ]) {
      expect(() => parseCarPlayTapResult(value)).toThrow(ActionableError);
    }
  });

  test("runs the tap argv through the helper seam with the caller's signal", async () => {
    const seen: unknown[] = [];
    const tapper = new DefaultCarPlayTapper(
      async (file, args, options) => {
        seen.push([file, ...args], options);
        return { stdout: tapJson, stderr: "" };
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper" },
    );
    const { signal } = new AbortController();
    expect((await tapper.tap("udid", 558, 80.5, signal)).tapped.target).toBe(1);
    expect(seen).toEqual([
      ["/helper", "udid", "tap", "558", "80.5"],
      { timeout: 30000, maxBuffer: 1024 * 1024, signal },
    ]);
  });

  test("maps the helper's refusal from stderr", async () => {
    const tapper = new DefaultCarPlayTapper(
      async () => {
        throw Object.assign(new Error("exit 1"), {
          stderr: JSON.stringify({
            error: { code: "carplay-not-powered", message: "power it on" },
          }),
        });
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper" },
    );
    await expect(tapper.tap("udid", 1, 1)).rejects.toThrow("[carplay-not-powered] power it on");
  });

  test("probes first, then taps and reports the car display", async () => {
    const probe = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(carJson));
    const tapper = new FakeCarPlayTapper(parseCarPlayTapResult(tapJson));
    const { signal } = new AbortController();

    const result = await tapCarPlayScreen("udid", { x: 558, y: 80 }, { probe, tapper }, signal);

    expect(probe.calls).toEqual(["udid"]);
    expect(probe.options).toEqual([{ signal }]);
    expect(tapper.calls).toEqual([{ udid: "udid", x: 558, y: 80, signal }]);
    expect(result.display.identity).toBe("Car[2]");
    expect(result.tap.width).toBe(800);
  });

  test("refuses a screen that is not projecting without sending a touch", async () => {
    const probe = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(untaggedJson));
    const tapper = new FakeCarPlayTapper(parseCarPlayTapResult(tapJson));

    const result = tapCarPlayScreen("udid", { x: 1, y: 1 }, { probe, tapper });
    await expect(result).rejects.toThrow("not projecting (Untagged[2]). No touch was sent.");
    await expect(result).rejects.toThrow("carplay-power-helper power-on");
    expect(tapper.calls).toEqual([]);
  });
});

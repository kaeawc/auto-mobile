import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import {
  CARPLAY_INPUTS,
  DefaultCarPlayInputSender,
  parseCarPlayInputResult,
  sendCarPlayInput,
} from "../../../src/utils/ios/carPlayInput";
import { parseCarPlayProjectionState } from "../../../src/utils/ios/carPlayProjection";
import { FakeCarPlayInputSender } from "../../fakes/FakeCarPlayInputSender";
import { FakeCarPlayProjectionProbe } from "../../fakes/FakeCarPlayProjectionProbe";
import { FakeCarPlayRuntimeReader } from "../../fakes/FakeCarPlayRuntimeReader";

// The helper's `input` JSON contract (CarPlayInputSent in ios/carplay-power): a usage press carries
// usagePage and usage, a knob rotation scrollDelta. Not yet captured on a simulator (#19059).
const backJson =
  '{"sent":{"input":"back","count":1,"screenID":2,"screenType":1,"target":1,"usagePage":12,"usage":548}}';
const rotateJson =
  '{"sent":{"input":"knob-cw","count":3,"screenID":2,"screenType":1,"target":1,"scrollDelta":-1}}';
// Projection probe captures from an iOS 26.5 iPhone 17 Pro simulator (#18728), as in carPlayTap.test.ts.
const carJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Car[2]","isCarDisplay":true,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":32}';
const untaggedJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Untagged[2]","isCarDisplay":false,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":0}';

describe("CarPlay head-unit input", () => {
  test("lists the helper's input names in its order", () => {
    expect(CARPLAY_INPUTS).toEqual([
      "back",
      "home",
      "siri",
      "knob-select",
      "knob-up",
      "knob-down",
      "knob-left",
      "knob-right",
      "knob-cw",
      "knob-ccw",
    ]);
  });

  test("parses the helper's input JSON and rejects other shapes", () => {
    expect(parseCarPlayInputResult(backJson).sent).toEqual({
      input: "back",
      count: 1,
      screenID: 2,
      screenType: 1,
      target: 1,
      usagePage: 12,
      usage: 548,
    });
    expect(parseCarPlayInputResult(rotateJson).sent.scrollDelta).toBe(-1);
    for (const value of [
      "not json",
      "{}",
      backJson.replace('"input":"back"', '"input":"menu"'),
      backJson.replace('"count":1', '"count":0'),
      backJson.replace("}}", ',"extra":true}}'),
    ]) {
      expect(() => parseCarPlayInputResult(value)).toThrow(ActionableError);
    }
  });

  test("runs the input argv through the helper seam with the caller's signal", async () => {
    const seen: unknown[] = [];
    const sender = new DefaultCarPlayInputSender(
      async (file, args, options) => {
        seen.push([file, ...args], options);
        return { stdout: rotateJson, stderr: "" };
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper" },
    );
    const { signal } = new AbortController();
    expect((await sender.send("udid", "knob-cw", 3, signal)).sent.count).toBe(3);
    expect(seen).toEqual([
      ["/helper", "udid", "input", "knob-cw", "3"],
      { timeout: 30000, maxBuffer: 1024 * 1024, signal },
    ]);
  });

  test("maps the helper's head-unit-inputs refusal from stderr", async () => {
    const sender = new DefaultCarPlayInputSender(
      async () => {
        throw Object.assign(new Error("exit 1"), {
          stderr: JSON.stringify({
            error: { code: "head-unit-inputs-disabled", message: "power on with inputs" },
          }),
        });
      },
      { AUTOMOBILE_CARPLAY_POWER_HELPER_PATH: "/helper" },
    );
    await expect(sender.send("udid", "back", 1)).rejects.toThrow(
      "[head-unit-inputs-disabled] power on with inputs",
    );
  });

  test("probes first, then sends and reports the car display", async () => {
    const probe = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(carJson));
    const sender = new FakeCarPlayInputSender();
    const { signal } = new AbortController();

    const result = await sendCarPlayInput(
      "udid",
      { name: "knob-ccw", count: 2 },
      { probe, runtime: new FakeCarPlayRuntimeReader(), sender },
      signal,
    );

    expect(probe.options).toEqual([{ signal }]);
    expect(sender.calls).toEqual([{ udid: "udid", input: "knob-ccw", count: 2, signal }]);
    expect(result.display.identity).toBe("Car[2]");
    expect(result.sent.scrollDelta).toBe(1);
  });

  test("refuses a screen that is not projecting without sending an input", async () => {
    const probe = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(untaggedJson));
    const sender = new FakeCarPlayInputSender();

    const result = sendCarPlayInput(
      "udid",
      { name: "back", count: 1 },
      { probe, runtime: new FakeCarPlayRuntimeReader(), sender },
    );
    await expect(result).rejects.toThrow("not projecting (Untagged[2]). No input was sent.");
    expect(sender.calls).toEqual([]);
  });
});

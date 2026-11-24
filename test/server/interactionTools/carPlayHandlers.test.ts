import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  registerInteractionTools,
  type InteractionToolDependencies,
} from "../../../src/server/interactionTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { PressButtonArgs, TapAtArgs } from "../../../src/server/interactionToolTypes";
import type { CarPlayInput } from "../../../src/utils/ios/carPlayInput";
import { parseCarPlayProjectionState } from "../../../src/utils/ios/carPlayProjection";
import { type CarPlayTapper, parseCarPlayTapResult } from "../../../src/utils/ios/carPlayTap";
import { FakeCarPlayInputSender } from "../../fakes/FakeCarPlayInputSender";
import { FakeCarPlayProjectionProbe } from "../../fakes/FakeCarPlayProjectionProbe";
import { toolJson } from "../../helpers/toolResponse";
import { isolateToolRegistry } from "../../helpers/withTemporaryTool";

isolateToolRegistry();

// Real captures from an iOS 26.5 iPhone 17 Pro simulator after power-on (see carPlayTap.test.ts).
const carJson =
  '{"deviceName":"PurpleTVOut","displayId":2,"displayType":1,"found":true,"identity":"Car[2]","isCarDisplay":true,"isCarInstrumentsDisplay":false,"name":"TVOut","tag":32}';
const tapJson =
  '{"tapped":{"screenID":2,"height":480,"width":800,"y":80,"screenType":1,"x":558,"target":1}}';

const taps: Array<[number, number]> = [];
const probe = new FakeCarPlayProjectionProbe(parseCarPlayProjectionState(carJson));
const tapper: CarPlayTapper = {
  async tap(_udid, x, y) {
    taps.push([x, y]);
    return parseCarPlayTapResult(tapJson);
  },
};
const sender = new FakeCarPlayInputSender();
const deps: InteractionToolDependencies = {
  carPlayTapFactory: () => ({ probe, tapper }),
  carPlayInputFactory: () => ({ probe, sender }),
  pressButtonFactory: () => {
    throw new Error("the phone pressButton path must not run");
  },
};

beforeAll(() => {
  registerInteractionTools(deps);
});

afterAll(() => {
  ToolRegistry.clearTools();
});

function tapAt(device: BootedDevice, args: Partial<TapAtArgs>) {
  const handler = ToolRegistry.getTool("tapAt")?.deviceAwareHandler;
  if (!handler) {
    throw new Error("tapAt is not registered");
  }
  return handler(device, { display: "carPlay", ...args });
}

const iphone: BootedDevice = { deviceId: "SIM-UDID", platform: "ios", name: "iPhone 17 Pro" };

describe('tapAt display "carPlay"', () => {
  test("taps the CarPlay screen in its pixels and reports the car display", async () => {
    taps.length = 0;
    const payload = toolJson(await tapAt(iphone, { x: 558, y: 80 }));
    expect(taps).toEqual([[558, 80]]);
    expect(payload).toMatchObject({
      success: true,
      action: "tap",
      x: 558,
      y: 80,
      carPlay: { display: "Car[2]", displayId: 2, width: 800, height: 480 },
      deviceId: "SIM-UDID",
      platform: "ios",
    });
  });

  test("refuses Android, phone-only fields and a missing point before tapping", async () => {
    taps.length = 0;
    const android: BootedDevice = { deviceId: "emulator-5560", platform: "android", name: "Pixel" };
    await expect(tapAt(android, { x: 1, y: 1 })).rejects.toThrow('display "headUnit"');
    await expect(tapAt(iphone, { x: 1, y: 1, action: "longPress" })).rejects.toThrow(
      "action is not supported there",
    );
    await expect(
      tapAt(iphone, { x: 1, y: 1, coordinateSpace: "normalized", durationMs: 600 }),
    ).rejects.toThrow("coordinateSpace, durationMs are not supported there");
    await expect(tapAt(iphone, { x: 1 })).rejects.toThrow("requires x and y");
    expect(taps).toEqual([]);
  });
});

function pressButton(device: BootedDevice, args: Partial<PressButtonArgs>) {
  const handler = ToolRegistry.getTool("pressButton")?.deviceAwareHandler;
  if (!handler) {
    throw new Error("pressButton is not registered");
  }
  return handler(device, args);
}

describe('pressButton display "carPlay"', () => {
  test("sends each head-unit button as its CarPlay input", async () => {
    sender.calls.length = 0;
    const expected: Array<[PressButtonArgs["button"], CarPlayInput]> = [
      ["back", "back"],
      ["home", "home"],
      ["siri", "siri"],
      ["rotary_select", "knob-select"],
      ["rotary_nudge_up", "knob-up"],
      ["rotary_nudge_down", "knob-down"],
      ["rotary_nudge_left", "knob-left"],
      ["rotary_nudge_right", "knob-right"],
      ["rotary_rotate_cw", "knob-cw"],
      ["rotary_rotate_ccw", "knob-ccw"],
    ];
    for (const [button] of expected) {
      await pressButton(iphone, { button, display: "carPlay" });
    }
    expect(sender.calls.map(({ input, count }) => ({ input, count }))).toEqual(
      expected.map(([, input]) => ({ input, count: 1 })),
    );
  });

  test("rotates the knob by steps and reports what was sent", async () => {
    sender.calls.length = 0;
    const payload = toolJson(
      await pressButton(iphone, { button: "rotary_rotate_cw", steps: 3, display: "carPlay" }),
    );
    expect(sender.calls).toEqual([
      { udid: "SIM-UDID", input: "knob-cw", count: 3, signal: undefined },
    ]);
    expect(payload).toMatchObject({
      success: true,
      button: "rotary_rotate_cw",
      message: "Sent rotary_rotate_cw x3 to the CarPlay screen Car[2] as knob-cw",
      carPlay: {
        display: "Car[2]",
        displayId: 2,
        input: "knob-cw",
        count: 3,
        target: 1,
        scrollDelta: -1,
      },
      deviceId: "SIM-UDID",
      platform: "ios",
    });
    const back = toolJson(await pressButton(iphone, { button: "back", display: "carPlay" }));
    expect(back).toMatchObject({ carPlay: { input: "back", usagePage: 12, usage: 0x224 } });
  });

  test("refuses Android, other buttons, durationMs and stray steps before sending", async () => {
    sender.calls.length = 0;
    const android: BootedDevice = { deviceId: "emulator-5560", platform: "android", name: "Pixel" };
    await expect(pressButton(android, { button: "back", display: "carPlay" })).rejects.toThrow(
      'display "headUnit"',
    );
    await expect(pressButton(iphone, { button: "volume_up", display: "carPlay" })).rejects.toThrow(
      "volume_up is not a CarPlay head-unit input",
    );
    await expect(
      pressButton(iphone, { button: "rotary_select", durationMs: 600, display: "carPlay" }),
    ).rejects.toThrow("durationMs is not supported there");
    await expect(
      pressButton(iphone, { button: "back", steps: 2, display: "carPlay" }),
    ).rejects.toThrow("back is a single event");
    await expect(
      pressButton(iphone, { button: "rotary_rotate_ccw", steps: 51, display: "carPlay" }),
    ).rejects.toThrow("steps must be a whole number from 1 to 50");
    expect(sender.calls).toEqual([]);
  });

  test("refuses siri on any other display without pressing a phone button", async () => {
    sender.calls.length = 0;
    await expect(pressButton(iphone, { button: "siri" })).rejects.toThrow('pass display "carPlay"');
    expect(sender.calls).toEqual([]);
  });
});

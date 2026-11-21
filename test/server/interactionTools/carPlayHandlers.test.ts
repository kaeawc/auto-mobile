import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  registerInteractionTools,
  type InteractionToolDependencies,
} from "../../../src/server/interactionTools";
import { ToolRegistry } from "../../../src/server/toolRegistry";
import type { TapAtArgs } from "../../../src/server/interactionToolTypes";
import { parseCarPlayProjectionState } from "../../../src/utils/ios/carPlayProjection";
import { type CarPlayTapper, parseCarPlayTapResult } from "../../../src/utils/ios/carPlayTap";
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
const deps: InteractionToolDependencies = { carPlayTapFactory: () => ({ probe, tapper }) };

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

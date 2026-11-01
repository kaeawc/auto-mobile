import { afterEach, beforeEach, expect, test } from "bun:test";
import { PressButton } from "../../../src/features/action/PressButton";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAtCoordinate } from "../../../src/features/action/TapAtCoordinate";
import { SwipeOn } from "../../../src/features/action/swipeon/SwipeOn";
import { PinchOn } from "../../../src/features/action/PinchOn";
import { MultiTouchGesture } from "../../../src/features/action/MultiTouchGesture";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { TV_REMOTE_BUTTONS } from "../../../src/features/tvos/TvosRunnerClient";
import { tvosRunners } from "../../../src/features/tvos/TvosRunnerRegistry";
import { tapOnHandler } from "../../../src/server/interactionTools/tapHandlers";
import { pressButtonHandler } from "../../../src/server/interactionTools/deviceHandlers";
import { pressButtonTool, tapOnSchema } from "../../../src/server/interactionTools";
import { assertToolSupportsDevicePlatform } from "../../../src/server/applePlatformToolSupport";
import { FakeTvosRunnerClient } from "../../fakes/FakeTvosRunnerClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const device: BootedDevice = { platform: "tvos", name: "TV", deviceId: "tvos-actions" };
let client: FakeTvosRunnerClient;
let unregister: () => void;
beforeEach(() => {
  client = new FakeTvosRunnerClient();
  unregister = tvosRunners.register(device.deviceId, client);
});
afterEach(() => unregister());

test.each(TV_REMOTE_BUTTONS)("pressButton routes %s to the tvOS runner", async (button) => {
  const args = pressButtonTool.schema.parse({
    button,
    platform: "tvos",
    deviceId: device.deviceId,
  });
  assertToolSupportsDevicePlatform("pressButton", device);
  await pressButtonHandler(device, args, {
    deps: { pressButtonFactory: (device) => new PressButton(device, null, new FakeTimer()) },
  });
  expect(client.commands).toEqual([{ type: "request_press_button", action: button }]);
});

test("refuses unsupported remote options before dispatch", async () => {
  const press = new PressButton(device, null, new FakeTimer());
  await expect(press.execute("right", { steps: 2 })).rejects.toThrow("pressButton");
  await expect(press.execute("power")).rejects.toThrow("pressButton");
  expect(client.commands).toEqual([]);
});

test("touch entry points refuse tvOS with actionable focus navigation guidance", async () => {
  const timer = new FakeTimer();
  const calls = [
    async () => new TapAtCoordinate(device, null, { timer }).execute({ x: 1, y: 2 }),
    async () => new SwipeOn(device, null, { timer }).execute({ direction: "right" }),
    async () => new PinchOn(device, null, { timer }).execute({ direction: "in" }),
    async () =>
      new MultiTouchGesture(device, null, { timer }).execute({
        action: "swipe",
        x: 1,
        y: 2,
        direction: "up",
        fingers: 2,
      }),
  ];
  for (const call of calls) {
    const error = await call().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("focus navigation via pressButton (up/down/left/right/select)");
  }
  for (const tool of ["tapAt", "swipeOn", "pinchOn", "multiTouch"]) {
    expect(() => assertToolSupportsDevicePlatform(tool, device)).toThrow("pressButton");
  }
  expect(client.commands).toEqual([]);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("tapOn routes tvOS to focus selection without sleeps", async () => {
  const timer = new FakeTimer();
  assertToolSupportsDevicePlatform("tapOn", device);
  const result = await new TapOnElement(device, null, { timer }).execute({
    action: "tap",
    elementId: "B01",
  });
  expect(result.success).toBe(true);
  expect(client.commands).toEqual([
    { type: "request_hierarchy" },
    { type: "request_press_button", action: "select" },
  ]);
  expect(timer.getSleepHistory()).toEqual([]);
});

test("tapOn default handler factory reaches the tvOS runner", async () => {
  const args = tapOnSchema.parse({
    selector: { elementId: "B01" },
    platform: "tvos",
    deviceId: device.deviceId,
  });
  await tapOnHandler(device, args);
  expect(client.commands).toEqual([
    { type: "request_hierarchy" },
    { type: "request_press_button", action: "select" },
  ]);
});

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
import { createSendKeysHandler } from "../../../src/server/interactionToolHandlers";
import { sendKeysSchema } from "../../../src/server/interactionTools/inputSchemas";
import { TvosRunnerError } from "../../../src/features/tvos/TvosRunnerError";
import { toolStructured, toolIsError } from "../../helpers/toolResponse";
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

const sendKeys = createSendKeysHandler({
  sendKeysFactory: () => {
    throw new Error("tvOS must bypass SendKeys");
  },
  keyboardFactory: () => {
    throw new Error("tvOS must not dismiss the keyboard");
  },
});

test("sendKeys type reaches the tvOS runner with the standard structured result", async () => {
  const result = await sendKeys(
    device,
    sendKeysSchema.parse({ commands: [{ action: "type", text: "hello" }] }),
  );
  expect(client.commands).toEqual([{ type: "request_append_text", text: "hello" }]);
  expect(toolStructured(result)).toMatchObject({
    success: true,
    completedCommands: 1,
    commands: [{ index: 0, action: "type", success: true, textLength: 5 }],
  });
  expect(toolIsError(result)).toBe(false);
});

test("sendKeys sends two type commands in order", async () => {
  await sendKeys(
    device,
    sendKeysSchema.parse({
      commands: [
        { action: "type", text: "one" },
        { action: "type", text: "two" },
      ],
    }),
  );
  expect(client.commands).toEqual([
    { type: "request_append_text", text: "one" },
    { type: "request_append_text", text: "two" },
  ]);
});

test.each([
  {
    commands: [
      { action: "type", text: "first" },
      { action: "key", key: "enter" },
    ],
  },
  { commands: [{ action: "clear" }] },
  { selector: { text: "field" } },
  { container: { text: "panel" } },
  { selectionStrategy: "first" },
  { layer: "app" },
  { display: "active" },
])("sendKeys refuses unsupported tvOS input before dispatch: %j", async (unsupported) => {
  const args = Object.assign(
    sendKeysSchema.parse({ commands: [{ action: "type", text: "hello" }] }),
    unsupported,
  );
  await expect(sendKeys(device, args)).rejects.toBeInstanceOf(ActionableError);
  await expect(sendKeys(device, args)).rejects.toThrow(
    "tvOS sendKeys supports only type commands into the already focused field",
  );
  expect(client.commands).toEqual([]);
});

test("sendKeys refuses empty text before dispatch", async () => {
  const args = sendKeysSchema.parse({ commands: [{ action: "type", text: "hello" }] });
  args.commands = [{ action: "type", text: "", operation: "insert", mode: "auto" }];
  await expect(sendKeys(device, args)).rejects.toBeInstanceOf(ActionableError);
  expect(client.commands).toEqual([]);
});

test("sendKeys stops at the runner's actionable failure", async () => {
  client.failure = new TvosRunnerError("no focused text input", "invalid_parameter");
  const result = await sendKeys(
    device,
    sendKeysSchema.parse({
      commands: [
        { action: "type", text: "one" },
        { action: "type", text: "two" },
      ],
    }),
  );
  expect(client.commands).toEqual([{ type: "request_append_text", text: "one" }]);
  expect(toolStructured(result)).toMatchObject({
    success: false,
    completedCommands: 0,
    failedIndex: 0,
    error: "no focused text input",
  });
  expect(toolIsError(result)).toBe(true);
});

test("sendKeys opts into tvOS while touch remains unsupported", () => {
  expect(() => assertToolSupportsDevicePlatform("sendKeys", device)).not.toThrow();
  expect(() => assertToolSupportsDevicePlatform("tapAt", device)).toThrow(ActionableError);
});

test("sendKeys preserves completed commands when a later runner request fails", async () => {
  const request = client.request.bind(client);
  client.request = (command, signal, options) => {
    if (client.commands.length === 1) {
      client.failure = new ActionableError("field lost focus; pressButton select first");
    }
    return request(command, signal, options);
  };
  const result = await sendKeys(
    device,
    sendKeysSchema.parse({
      commands: [
        { action: "type", text: "one" },
        { action: "type", text: "two" },
        { action: "type", text: "three" },
      ],
    }),
  );
  expect(client.commands).toEqual([
    { type: "request_append_text", text: "one" },
    { type: "request_append_text", text: "two" },
  ]);
  expect(toolStructured(result)).toMatchObject({
    success: false,
    completedCommands: 1,
    failedIndex: 1,
    error: "field lost focus; pressButton select first",
  });
  expect(toolIsError(result)).toBe(true);
});

test("sendKeys observes cancellation before dispatch", async () => {
  const controller = new AbortController();
  controller.abort(new ActionableError("cancelled"));
  await expect(
    sendKeys(
      device,
      sendKeysSchema.parse({ commands: [{ action: "type", text: "hello" }] }),
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow("cancelled");
  expect(client.commands).toEqual([]);
});

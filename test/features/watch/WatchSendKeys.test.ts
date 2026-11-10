import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  WATCH_FOCUS_WAIT_DELAYS_MS,
  watchSendKeys,
} from "../../../src/features/watch/WatchSendKeys";
import { WatchRunnerError } from "../../../src/features/watch/WatchRunnerError";
import { FakeTimer } from "../../fakes/FakeTimer";
import { watchRunners } from "../../../src/features/watch/WatchRunnerRegistry";
import { FakeWatchRunnerClient } from "../../fakes/FakeWatchRunnerClient";
import { createSendKeysHandler } from "../../../src/server/interactionToolHandlers";
import { sendKeysSchema } from "../../../src/server/interactionTools/inputSchemas";
import { readToolResponse } from "../../helpers/toolResponse";
import type {
  SendKeysCommand,
  SendKeysFocusOptions,
  SendKeysSelector,
} from "../../../src/features/action/SendKeys";

const device = { platform: "watchos", deviceId: "watch-sendkeys", name: "Watch" } as const;
let client: FakeWatchRunnerClient;
let unregister: () => void;
beforeEach(() => {
  client = new FakeWatchRunnerClient();
  unregister = watchRunners.register(device.deviceId, client);
});
afterEach(() => unregister());

test("handler routes watch typing through its runner without creating Android/iOS sendKeys", async () => {
  const response = await createSendKeysHandler({
    sendKeysFactory: () => {
      throw new Error("Android/iOS factory ran");
    },
  })(device, { commands: [{ action: "type", text: "hello", operation: "insert", mode: "auto" }] });
  expect(readToolResponse(response).isError).not.toBe(true);
  expect(client.commands).toEqual([{ type: "type", text: "hello" }]);
});

test("focused input types only and reports the input method and Unicode text length", async () => {
  expect(await watchSendKeys(device.deviceId, [{ action: "type", text: "hi🐾" }])).toEqual({
    success: true,
    completedCommands: 1,
    commands: [
      { index: 0, action: "type", success: true, textLength: 3, resolvedMode: "xcuiTypeText" },
    ],
  });
  expect(client.commands).toEqual([{ type: "type", text: "hi🐾" }]);
});

test.each<SendKeysSelector>([{ elementId: "ctrlproxy-crown" }, { text: "CtrlProxy Watch" }])(
  "selector focuses with a tap before typing: %j",
  async (selector) => {
    const result = await watchSendKeys(
      device.deviceId,
      [{ action: "type", text: "hello" }],
      selector,
    );
    expect(result.success).toBe(true);
    expect(client.commands).toEqual([
      { type: "face", op: "dump" },
      { type: "hierarchy" },
      { type: "tap", identifier: "ctrlproxy-crown" },
      { type: "type", text: "hello" },
    ]);
  },
);

test.each<SendKeysCommand>([
  { action: "type", text: "replace", operation: "replace" },
  { action: "clear" },
  { action: "key", key: "enter" },
  { action: "type", text: "" },
  ...(["ime", "imeKeyEvents", "a11y", "eventOnly", "eventAll", "eventLast"] as const).map(
    (mode) => ({ action: "type" as const, text: "hello", mode }),
  ),
  { action: "type", text: "hello", keyboardProfile: "gboard" },
])("refuses unsupported command before focus or typing: %j", async (command) => {
  await expect(
    watchSendKeys(device.deviceId, [{ action: "type", text: "valid" }, command], {
      elementId: "ctrlproxy-crown",
    }),
  ).rejects.toThrow("non-empty append");
  expect(client.commands).toEqual([]);
});

test("refuses an empty batch", async () => {
  await expect(watchSendKeys(device.deviceId, [])).rejects.toThrow("focused field");
  expect(client.commands).toEqual([]);
});

test.each<SendKeysFocusOptions & { display?: string }>([
  { container: { elementId: "container" } },
  { layer: "app" },
  { display: "0" },
  { selectionStrategy: "first" },
])("refuses unsupported focus scopes before input: %j", async (options) => {
  await expect(
    watchSendKeys(device.deviceId, [{ action: "type", text: "hello" }], undefined, options),
  ).rejects.toThrow("focused field");
  expect(client.commands).toEqual([]);
});

test.each<SendKeysSelector>([
  { testTag: "field" },
  { textAny: ["field"] },
  {},
  { elementId: "ctrlproxy-crown", textAny: [] },
])("refuses unsupported selectors before input: %j", async (selector) => {
  await expect(
    watchSendKeys(device.deviceId, [{ action: "type", text: "hello" }], selector),
  ).rejects.toThrow("selector supports only");
  expect(client.commands).toEqual([]);
});

test.each(["\u0008", "a\u007f", "\uf728"])(
  "refuses delete characters before input: %j",
  async (text) => {
    await expect(watchSendKeys(device.deviceId, [{ action: "type", text }])).rejects.toThrow(
      "delete key",
    );
    expect(client.commands).toEqual([]);
  },
);

test("runner failure preserves completed commands and failedIndex", async () => {
  class FailingSecondTypeClient extends FakeWatchRunnerClient {
    override async request(
      ...args: Parameters<FakeWatchRunnerClient["request"]>
    ): Promise<unknown> {
      if (this.commands.length === 1) {
        this.failure = new Error("No focused text field; tap the field first");
      }
      return super.request(...args);
    }
  }
  unregister();
  client = new FailingSecondTypeClient();
  unregister = watchRunners.register(device.deviceId, client);
  const result = await watchSendKeys(device.deviceId, [
    { action: "type", text: "first" },
    { action: "type", text: "second" },
    { action: "type", text: "never" },
  ]);
  expect(result).toMatchObject({
    success: false,
    completedCommands: 1,
    failedIndex: 1,
    commands: [
      { index: 0, success: true },
      { index: 1, success: false, resolvedMode: "xcuiTypeText" },
    ],
  });
  expect(result.error).toContain("No focused text field");
  expect(client.commands).toHaveLength(2);
});

test("handler marks a runner failure as an error response", async () => {
  client.failure = new Error("No focused text field; tap the field first");
  const response = await createSendKeysHandler({})(device, {
    commands: [{ action: "type", text: "hello", operation: "insert", mode: "auto" }],
  });
  expect(readToolResponse(response).isError).toBe(true);
});

test("aborted input never reaches the runner", async () => {
  await expect(
    watchSendKeys(device.deviceId, [{ action: "type", text: "hello" }], undefined, {
      signal: AbortSignal.abort(new Error("cancelled")),
    }),
  ).rejects.toThrow("cancelled");
  expect(client.commands).toEqual([]);
});

test("sendKeys tool schema accepts platform watchos", () => {
  const parsed = sendKeysSchema.safeParse({
    commands: [{ action: "type", text: "hello" }],
    platform: "watchos",
  });
  expect(parsed.success).toBe(true);
});

test.each([
  ["the typed value", "helloAB", "text-entry-field-value.json"],
  ["the placeholder of an empty field", "Text", "text-entry-field-empty.json"],
] as const)(
  "text selector on %s focuses the text field, not static text",
  async (_, text, file) => {
    const tree: unknown = await Bun.file(
      new URL(`../../fixtures/watchos-xcuitest/${file}`, import.meta.url),
    ).json();
    const fake = new FakeWatchRunnerClient(tree);
    const release = watchRunners.register("watch-text-entry", fake);
    try {
      await watchSendKeys("watch-text-entry", [{ action: "type", text: "CD" }], { text });
    } finally {
      release();
    }
    expect(fake.commands.filter((command) => command.type !== "hierarchy")).toEqual([
      { type: "face", op: "dump" },
      { type: "tap", identifier: "watch-text-field" },
      { type: "type", text: "CD" },
    ]);
  },
);

test("text selector reaches a labeled field by its value through the value child", async () => {
  const bounds = { left: 0, top: 0, right: 100, bottom: 40 };
  const field = { className: "XCUIElementType(49)", bounds, accessibilityIdentifier: "name-field" };
  const tree = {
    timestamp: 1,
    screenWidth: 208,
    screenHeight: 248,
    screenScale: 1,
    root: {
      className: "XCUIElementType(1)",
      bounds: { left: 0, top: 0, right: 208, bottom: 248 },
      children: [
        {
          ...field,
          accessibilityLabel: "Name",
          children: [{ ...field, accessibilityLabel: "helloAB" }],
        },
      ],
    },
  };
  const fake = new FakeWatchRunnerClient(tree);
  const release = watchRunners.register("watch-labeled-field", fake);
  try {
    await watchSendKeys("watch-labeled-field", [{ action: "type", text: "CD" }], {
      text: "helloAB",
    });
  } finally {
    release();
  }
  expect(fake.commands.filter((command) => command.type !== "hierarchy")).toEqual([
    { type: "face", op: "dump" },
    // The field and its value child share an identifier, so the tap falls back to coordinates.
    { type: "tap", x: 50, y: 20 },
    { type: "type", text: "CD" },
  ]);
});

/** Refuses type until the keyboard sheet opens, the way the runner does before focus lands. */
class LateFocusClient extends FakeWatchRunnerClient {
  constructor(private refusals: number) {
    super();
  }
  override async request(...args: Parameters<FakeWatchRunnerClient["request"]>): Promise<unknown> {
    const result = await super.request(...args);
    if (args[0].type === "type" && this.refusals > 0) {
      this.refusals--;
      throw new WatchRunnerError("No focused text field; tap the field first", "command_failed");
    }
    return result;
  }
}

function useLateFocusClient(refusals: number): FakeWatchRunnerClient {
  unregister();
  client = new LateFocusClient(refusals);
  unregister = watchRunners.register(device.deviceId, client);
  return client;
}

const typeHello: SendKeysCommand[] = [{ action: "type", text: "hello" }];
const typeCalls = () => client.commands.filter((command) => command.type === "type");

test("selector waits for the keyboard sheet before reporting no focused field", async () => {
  useLateFocusClient(2);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const result = await watchSendKeys(
    device.deviceId,
    typeHello,
    { elementId: "ctrlproxy-crown" },
    { timer },
  );
  expect(result).toMatchObject({ success: true, completedCommands: 1 });
  expect(typeCalls()).toEqual([
    { type: "type", text: "hello" },
    { type: "type", text: "hello" },
    { type: "type", text: "hello" },
  ]);
  expect(timer.now()).toBe(WATCH_FOCUS_WAIT_DELAYS_MS[0]! + WATCH_FOCUS_WAIT_DELAYS_MS[1]!);
});

test("selector focus wait is bounded and then reports the existing error", async () => {
  useLateFocusClient(Number.POSITIVE_INFINITY);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const result = await watchSendKeys(
    device.deviceId,
    typeHello,
    { elementId: "ctrlproxy-crown" },
    { timer },
  );
  expect(result).toMatchObject({ success: false, completedCommands: 0, failedIndex: 0 });
  expect(result.error).toContain("No focused text field");
  expect(typeCalls()).toHaveLength(WATCH_FOCUS_WAIT_DELAYS_MS.length + 1);
  expect(timer.now()).toBe(WATCH_FOCUS_WAIT_DELAYS_MS.reduce((sum, delay) => sum + delay, 0));
});

test("without a selector a focus refusal fails at once", async () => {
  useLateFocusClient(1);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const result = await watchSendKeys(device.deviceId, typeHello, undefined, { timer });
  expect(result).toMatchObject({ success: false, failedIndex: 0 });
  expect(typeCalls()).toHaveLength(1);
  expect(timer.now()).toBe(0);
});

test("other runner failures after a selector are not retried", async () => {
  class FailingTypeClient extends FakeWatchRunnerClient {
    override async request(
      ...args: Parameters<FakeWatchRunnerClient["request"]>
    ): Promise<unknown> {
      const result = await super.request(...args);
      if (args[0].type === "type") {
        throw new WatchRunnerError(
          "The watch runner does not support type.",
          "unsupported_on_watchos",
        );
      }
      return result;
    }
  }
  unregister();
  client = new FailingTypeClient();
  unregister = watchRunners.register(device.deviceId, client);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const result = await watchSendKeys(
    device.deviceId,
    typeHello,
    { elementId: "ctrlproxy-crown" },
    { timer },
  );
  expect(result.success).toBe(false);
  expect(typeCalls()).toHaveLength(1);
});

test("cancelling during the focus wait stops typing", async () => {
  useLateFocusClient(Number.POSITIVE_INFINITY);
  const timer = new FakeTimer();
  const controller = new AbortController();
  const pending = watchSendKeys(
    device.deviceId,
    typeHello,
    { elementId: "ctrlproxy-crown" },
    { timer, signal: controller.signal },
  );
  await Bun.sleep(0);
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(typeCalls()).toHaveLength(1);
});

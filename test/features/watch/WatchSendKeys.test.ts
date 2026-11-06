import { afterEach, beforeEach, expect, test } from "bun:test";
import { watchSendKeys } from "../../../src/features/watch/WatchSendKeys";
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

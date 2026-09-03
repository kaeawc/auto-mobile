import { describe, expect, mock, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import {
  DefaultSendKeysCommandExecutor,
  SendKeys,
  type SendKeysCommandExecutor,
  type SendKeysInputKey,
  type SendKeysObserver,
  type SendKeysTextClient,
} from "../../../src/features/action/SendKeys";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

const iosDevice: BootedDevice = {
  deviceId: "ios-sim",
  name: "iPhone",
  platform: "ios",
};

function createObserver(): SendKeysObserver & { calls: number } {
  return {
    calls: 0,
    async execute() {
      this.calls++;
      return { timestamp: Date.now() } as ObserveResult;
    },
  };
}

function createTextClient() {
  const calls: string[] = [];
  const client: SendKeysTextClient = {
    replace: async (text) => {
      calls.push(`replace:${text}`);
      return { success: true };
    },
    insert: async (text) => {
      calls.push(`insert:${text}`);
      return { success: true };
    },
    clear: async () => {
      calls.push("clear");
      return { success: true };
    },
    ime: async (action) => {
      calls.push(`ime:${action}`);
      return { success: true };
    },
  };
  return { client, calls };
}

function createAdbFactory(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

describe("SendKeys", () => {
  test("executes commands in order, stops on failure, and observes once", async () => {
    const calls: string[] = [];
    const executor: SendKeysCommandExecutor = {
      type: mock(async (command) => {
        calls.push(`type:${command.text}`);
        return {
          index: -1,
          action: "type",
          success: true,
          textLength: command.text.length,
          operation: command.operation ?? "insert",
          requestedMode: command.mode ?? "auto",
          resolvedMode: "eventAll",
        };
      }),
      key: mock(async (command) => {
        calls.push(`key:${command.key}`);
        return { index: -1, action: "key", key: command.key, success: false, error: "blocked" };
      }),
      clear: mock(async () => {
        calls.push("clear");
        return { success: true };
      }),
    };
    const observer = createObserver();
    const sendKeys = new SendKeys(androidDevice, undefined, {
      executor,
      observer,
      focuser: { focus: async () => ({ success: true }) },
    });

    const result = await sendKeys.execute(
      [{ action: "type", text: "secret" }, { action: "key", key: "tab" }, { action: "clear" }],
      { text: "First name" },
    );

    expect(calls).toEqual(["type:secret", "key:tab"]);
    expect(result.success).toBe(false);
    expect(result.completedCommands).toBe(1);
    expect(result.failedIndex).toBe(1);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).not.toHaveProperty("text");
    expect(observer.calls).toBe(1);
  });

  test("does not execute commands when initial targeting fails", async () => {
    const observer = createObserver();
    const type = mock(async () => {
      throw new Error("must not execute");
    });
    const sendKeys = new SendKeys(androidDevice, undefined, {
      observer,
      focuser: { focus: async () => ({ success: false, error: "field missing" }) },
      executor: {
        type,
        key: mock(async () => {
          throw new Error("must not execute");
        }),
        clear: mock(async () => {
          throw new Error("must not execute");
        }),
      },
    });

    const result = await sendKeys.execute([{ action: "type", text: "value" }], {
      text: "missing",
    });

    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      failedIndex: 0,
      error: "field missing",
    });
    expect(type).not.toHaveBeenCalled();
    expect(observer.calls).toBe(1);
  });
});

describe("DefaultSendKeysCommandExecutor", () => {
  test("auto insert uses eventAll and accessibility-inserts unsupported runs", async () => {
    const adb = new FakeAdbExecutor();
    const observer = createObserver();
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      observer,
      { textClient: client },
    );

    const result = await executor.type({ action: "type", text: "a🙂" });

    expect(result).toMatchObject({
      success: true,
      operation: "insert",
      requestedMode: "auto",
      resolvedMode: "eventAll",
      textLength: 2,
    });
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
    expect(calls).toEqual(["insert:🙂"]);
  });

  test("eventAll resolves to a11y when no character has a key event", async () => {
    const adb = new FakeAdbExecutor();
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.type({
      action: "type",
      text: "🙂",
      operation: "replace",
      mode: "eventAll",
    });

    expect(result).toMatchObject({
      success: true,
      requestedMode: "eventAll",
      resolvedMode: "a11y",
    });
    expect(calls).toEqual(["replace:🙂"]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("replace a11y remains atomic and reports the selected mode", async () => {
    const adb = new FakeAdbExecutor();
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
      mode: "a11y",
    });

    expect(result).toMatchObject({ success: true, resolvedMode: "a11y" });
    expect(calls).toEqual(["replace:replacement"]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("semantic keys ignore modifiers while raw keys preserve them", async () => {
    const adb = new FakeAdbExecutor();
    const { client, calls } = createTextClient();
    const press = mock(async () => ({ success: true }));
    const inputKey: SendKeysInputKey = { press };
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: client, inputKey },
    );

    await executor.key({ action: "key", key: "next", modifiers: ["shift"] });
    await executor.key({ action: "key", key: "tab", modifiers: ["shift"] });

    expect(calls).toEqual(["ime:next"]);
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledWith("tab", undefined, undefined, ["shift"]);
  });

  test("iOS honors every explicit mode with insert/replace semantics", async () => {
    for (const mode of ["a11y", "eventLast", "eventAll", "eventOnly"] as const) {
      const adb = new FakeAdbExecutor();
      const { client, calls } = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        iosDevice,
        createAdbFactory(adb),
        createObserver(),
        { textClient: client },
      );

      const result = await executor.type({
        action: "type",
        text: "value",
        operation: "replace",
        mode,
      });

      expect(result).toMatchObject({ success: true, resolvedMode: mode });
      expect(calls).toEqual(["clear", "insert:value"]);
    }
  });
});

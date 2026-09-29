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
import { defaultTimer } from "../../../src/utils/SystemTimer";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  clearAndroidImeQuarantine,
  withAndroidImeLock,
} from "../../../src/features/action/androidImeLock";

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

const unicodeCorpus = [
  "a😀b👍🏽c👨‍👩‍👧d🇯🇵e❤️fé日本",
  "1️⃣",
  "é",
  "🏳️‍🌈",
  "👩🏽‍💻",
  "ไทย",
  "हिन्दी",
  "مرحبا",
  "한국어",
] as const;

function createObserver(
  result: ObserveResult = { timestamp: Date.now() } as ObserveResult,
): SendKeysObserver & {
  calls: number;
  options: Array<Parameters<SendKeysObserver["execute"]>[0]>;
} {
  return {
    calls: 0,
    options: [],
    async execute(options) {
      this.calls++;
      this.options.push(options);
      return result;
    },
  };
}

function focusedAndroidObservation(
  text: string = "",
  properties: Record<string, unknown> = {},
  timestamp: number = Date.now(),
): ObserveResult {
  return {
    timestamp,
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            focused: "true",
            text,
            class: "android.widget.EditText",
            ...properties,
          },
        },
      },
    },
  } as ObserveResult;
}

function createTextClient(
  options: {
    supportsImeCommit?: boolean;
    supportsImeKeyEvents?: boolean;
    supportsKeyboardProfiles?: boolean;
    setKeyboardProfile?: (
      id: string,
    ) => Promise<{ success: boolean; previousProfileId?: string; error?: string }>;
    commitViaIme?: (
      text: string,
      priorImeId: string | null,
    ) => Promise<{
      success: boolean;
      error?: string;
      partialApplication?: boolean;
      sessionUnsafe?: boolean;
    }>;
  } = {},
) {
  const calls: string[] = [];
  const commitViaImeCalls: Array<{ text: string; priorImeId: string | null }> = [];
  const commitDeliveries: Array<"commit" | "keyEvents" | undefined> = [];
  let supportsImeCommitCalls = 0;
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
    supportsImeCommit: async () => {
      supportsImeCommitCalls++;
      calls.push("supportsImeCommit");
      return options.supportsImeCommit ?? true;
    },
    supportsImeKeyEvents: async () => options.supportsImeKeyEvents ?? true,
    supportsKeyboardProfiles: async () => options.supportsKeyboardProfiles ?? true,
    setKeyboardProfile: async (id) => {
      calls.push(`setKeyboardProfile:${id}`);
      return options.setKeyboardProfile?.(id) ?? { success: true, previousProfileId: "direct" };
    },
    commitViaIme: async (text, priorImeId, _signal, delivery) => {
      calls.push(`commitViaIme:${text}:${priorImeId ?? "none"}`);
      commitViaImeCalls.push({ text, priorImeId });
      commitDeliveries.push(delivery);
      return options.commitViaIme ? options.commitViaIme(text, priorImeId) : { success: true };
    },
  };
  return {
    client,
    calls,
    commitViaImeCalls,
    commitDeliveries,
    getSupportsImeCommitCalls: () => supportsImeCommitCalls,
  };
}

function createAdbFactory(adb: FakeAdbExecutor): AdbClientFactory {
  // The catalog verifies component state with argv reads after `ime set`.
  // Existing command stubs model the commit path; this adapter models the
  // installed catalog and the device's post-selection readback.
  let selectedIme: string | undefined;
  const execute = adb.execute.bind(adb);
  const catalogAdb = new Proxy(adb, {
    get(target, property, receiver) {
      if (property === "execute") {
        return async (args: string[], options?: Parameters<FakeAdbExecutor["execute"]>[1]) => {
          const result = await execute(args, options);
          const command = args.join(" ");
          if (command === "shell ime list -a -s" && !result.stdout.trim()) {
            return { ...result, stdout: `${priorImeIdForFake}\n${commitImeIdForFake}\n` };
          }
          if (command === "shell ime list -s" && !result.stdout.trim()) {
            return { ...result, stdout: `${priorImeIdForFake}\n${commitImeIdForFake}\n` };
          }
          if (command.startsWith("shell ime set ") && !result.stderr.trim()) {
            selectedIme = args[3];
          }
          if (command === "shell settings get secure default_input_method" && selectedIme) {
            return { ...result, stdout: selectedIme };
          }
          return result;
        };
      }
      if (property === "executeCommand") {
        return async (...args: Parameters<FakeAdbExecutor["executeCommand"]>) => {
          const result = await target.executeCommand(...args);
          if (args[0].startsWith("shell ime set ") && !result.stderr.trim()) {
            selectedIme = args[0].slice("shell ime set ".length);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { create: () => catalogAdb };
}

const priorImeIdForFake = "com.example.keyboard/.Ime";
const commitImeIdForFake = "dev.jasonpearson.automobile.ctrlproxy/.ime.CtrlProxyIme";

describe("SendKeys", () => {
  test("a dispatched iOS semantic key with a lost response is indeterminate and non-retryable", async () => {
    const timer = new FakeTimer();
    let dispatch: (() => void) | undefined;
    const executor: SendKeysCommandExecutor = {
      type: async () => {
        throw new Error("unexpected type");
      },
      clear: async () => {
        throw new Error("unexpected clear");
      },
      key: async (_command, _signal, onDispatch) => {
        dispatch = onDispatch;
        return new Promise(() => {});
      },
    };
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer: createObserver({ timestamp: 0 } as ObserveResult),
      timestampProvider: { now: async () => 0 },
      timer,
    });
    const resultPromise = sendKeys.execute([{ action: "key", key: "done" }]);
    for (let index = 0; index < 5 && !dispatch; index++) {
      await Promise.resolve();
    }
    dispatch?.();
    timer.advanceTime(5000);
    const result = await resultPromise;
    expect(result).toMatchObject({
      success: false,
      retryable: false,
      completedCommands: 0,
      commands: [{ key: "done", retryable: false }],
    });
    expect(result.error).toContain("indeterminate");
  });

  test("a stalled iOS IME pre-action path times out before dispatch without claiming mutation", async () => {
    const timer = new FakeTimer();
    const executor: SendKeysCommandExecutor = {
      type: async () => {
        throw new Error("unexpected type");
      },
      clear: async () => {
        throw new Error("unexpected clear");
      },
      key: async () => {
        throw new Error("key must not dispatch");
      },
    };
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer: createObserver({ timestamp: 0 } as ObserveResult),
      timestampProvider: { now: async () => new Promise(() => {}) },
      timer,
    });
    const resultPromise = sendKeys.execute([{ action: "key", key: "search" }]);
    timer.advanceTime(5000);
    expect(await resultPromise).toMatchObject({ success: false, retryable: true });
  });

  test("a completed iOS IME action survives a stalled final observation", async () => {
    const timer = new FakeTimer();
    const executor: SendKeysCommandExecutor = {
      type: async () => {
        throw new Error("unexpected type");
      },
      clear: async () => {
        throw new Error("unexpected clear");
      },
      key: async (command, _signal, onDispatch) => {
        onDispatch?.();
        return { index: -1, action: "key", key: command.key, success: true };
      },
    };
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer: { execute: async () => new Promise(() => {}) },
      timestampProvider: { now: async () => 0 },
      timer,
    });
    const resultPromise = sendKeys.execute([{ action: "key", key: "next" }]);
    for (let index = 0; index < 8; index++) {
      await Promise.resolve();
    }
    timer.advanceTime(5000);
    expect(await resultPromise).toMatchObject({
      success: true,
      completedCommands: 1,
      commands: [{ key: "next", success: true }],
    });
  });

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
      focuser: {
        focus: async () => {
          calls.push("focus");
          return { success: true };
        },
      },
      timestampProvider: {
        now: async () => {
          calls.push("timestamp");
          return 1234;
        },
      },
    });

    const result = await sendKeys.execute(
      [{ action: "type", text: "secret" }, { action: "key", key: "tab" }, { action: "clear" }],
      { text: "First name" },
    );

    expect(calls).toEqual(["timestamp", "focus", "type:secret", "key:tab"]);
    expect(result.success).toBe(false);
    expect(result.completedCommands).toBe(1);
    expect(result.failedIndex).toBe(1);
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).not.toHaveProperty("text");
    expect(observer.calls).toBe(1);
    expect(observer.options).toEqual([
      { signal: undefined, skipWaitForFresh: false, minTimestamp: 1234 },
    ]);
  });

  test("accepts a hierarchy pushed before command delivery returns", async () => {
    let deviceTime = 1000;
    const pushedObservation = { timestamp: 1001 } as ObserveResult;
    const sendKeys = new SendKeys(androidDevice, undefined, {
      timestampProvider: { now: async () => deviceTime },
      executor: {
        type: async () => {
          deviceTime = 1002;
          return { index: -1, action: "type", success: true };
        },
        key: async () => {
          throw new Error("unexpected key");
        },
        clear: async () => {
          throw new Error("unexpected clear");
        },
      },
      observer: {
        execute: async (options) => {
          expect(options?.minTimestamp).toBeLessThanOrEqual(pushedObservation.timestamp);
          return pushedObservation;
        },
      },
    });

    const result = await sendKeys.execute([{ action: "type", text: "updated" }]);
    expect(result.success).toBe(true);
    expect(result.observation).toBe(pushedObservation);
  });

  test("does not execute commands when initial targeting fails", async () => {
    const observer = createObserver();
    const type = mock(async () => {
      throw new Error("must not execute");
    });
    const sendKeys = new SendKeys(androidDevice, undefined, {
      observer,
      focuser: { focus: async () => ({ success: false, error: "field missing" }) },
      timestampProvider: { now: async () => 1234 },
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
    expect(observer.options).toEqual([
      { signal: undefined, skipWaitForFresh: false, minTimestamp: undefined },
    ]);
  });

  test("rejects invalid imeKeyEvents anywhere in a targeted batch before focus or commands", async () => {
    const calls: string[] = [];
    const sendKeys = new SendKeys(androidDevice, undefined, {
      observer: createObserver(),
      timestampProvider: { now: async () => 1234 },
      focuser: {
        focus: async () => {
          calls.push("focus");
          return { success: true };
        },
      },
      executor: {
        type: async () => {
          calls.push("type");
          return { index: -1, action: "type", success: true };
        },
        key: async () => {
          calls.push("key");
          return { index: -1, action: "key", key: "tab", success: true };
        },
        clear: async () => {
          calls.push("clear");
          return { success: true };
        },
      },
    });

    const result = await sendKeys.execute(
      [
        { action: "type", text: "valid", mode: "imeKeyEvents" },
        { action: "type", text: "é", mode: "imeKeyEvents" },
      ],
      { text: "Email" },
    );

    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      failedIndex: 1,
      error: expect.stringContaining("printable ASCII"),
    });
    expect(result.commands.every((command) => !command.partialApplication)).toBe(true);
  });
});

describe("DefaultSendKeysCommandExecutor", () => {
  const commitImeId = "dev.jasonpearson.automobile.ctrlproxy/.ime.CtrlProxyIme";
  const priorImeId = "com.example.keyboard/.Ime";

  test.each(unicodeCorpus)("iOS forwards Unicode corpus %s intact for every mode", async (text) => {
    for (const mode of [
      "auto",
      "a11y",
      "ime",
      "eventAll",
      "eventLast",
      "eventOnly",
      "imeKeyEvents",
    ] as const) {
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        iosDevice,
        createAdbFactory(new FakeAdbExecutor()),
        createObserver(),
        { textClient: textClient.client },
      );
      expect(await executor.type({ action: "type", text, mode })).toMatchObject({
        success: true,
        resolvedMode: "xcuiTypeText",
        textLength: Array.from(text).length,
      });
      expect(textClient.calls).toEqual([`insert:${text}`]);
    }
  });

  test.each(unicodeCorpus)(
    "Android a11y and IME forward Unicode corpus %s intact",
    async (text) => {
      for (const mode of ["a11y", "ime", "auto"] as const) {
        const adb = new FakeAdbExecutor();
        adb.setCommandResponseSequence("shell settings get secure default_input_method", [
          { stdout: priorImeId, stderr: "" },
          { stdout: commitImeId, stderr: "" },
        ]);
        const textClient = createTextClient();
        const executor = new DefaultSendKeysCommandExecutor(
          androidDevice,
          createAdbFactory(adb),
          createObserver(focusedAndroidObservation()),
          { textClient: textClient.client },
        );
        expect(await executor.type({ action: "type", text, mode })).toMatchObject({
          success: true,
          resolvedMode: mode === "a11y" ? "a11y" : "ime",
        });
        if (mode === "a11y") {
          expect(textClient.calls).toEqual([`insert:${text}`]);
        } else {
          expect(textClient.commitViaImeCalls).toEqual([{ text, priorImeId }]);
        }
      }
    },
  );

  test.each(unicodeCorpus)(
    "Android ASCII-only modes reject Unicode corpus %s before mutation",
    async (text) => {
      for (const mode of ["eventOnly", "imeKeyEvents"] as const) {
        const adb = new FakeAdbExecutor();
        const textClient = createTextClient();
        const executor = new DefaultSendKeysCommandExecutor(
          androidDevice,
          createAdbFactory(adb),
          createObserver(focusedAndroidObservation("old")),
          { textClient: textClient.client },
        );
        expect(
          await executor.type({ action: "type", text, mode, operation: "replace" }),
        ).toMatchObject({
          success: false,
          error: expect.stringContaining(mode === "eventOnly" ? "cannot type" : "printable ASCII"),
        });
        expect(textClient.calls).toEqual([]);
        expect(adb.getExecutedCommands()).toEqual([]);
      }
    },
  );

  test.each(["eventAll", "eventLast"] as const)(
    "%s delivers Unicode runs intact around ASCII key events",
    async (mode) => {
      const text = unicodeCorpus[0];
      const adb = new FakeAdbExecutor();
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation()),
        { textClient: textClient.client },
      );
      expect(await executor.type({ action: "type", text, mode })).toMatchObject({
        success: true,
        resolvedMode: mode,
      });
      expect(textClient.calls).toEqual(
        mode === "eventAll"
          ? ["insert:😀", "insert:👍🏽", "insert:👨‍👩‍👧", "insert:🇯🇵", "insert:❤️", "insert:é日本"]
          : ["insert:a😀b👍🏽c👨‍👩‍👧d🇯🇵e❤️", "insert:é日本"],
      );
      expect(
        textClient.calls
          .filter((call) => call.startsWith("insert:"))
          .every((call) => !/^[\p{M}\u200D\uDC00-\uDFFF]/u.test(call.slice(7))),
      ).toBe(true);
    },
  );

  test.each(["eventAll", "eventLast"] as const)(
    "%s documents a11y inserts that start inside ASCII-base graphemes",
    async (mode) => {
      for (const [text, remainder] of [
        ["1️⃣", "️⃣"],
        ["e\u0301", "\u0301"],
      ] as const) {
        const textClient = createTextClient();
        const executor = new DefaultSendKeysCommandExecutor(
          androidDevice,
          createAdbFactory(new FakeAdbExecutor()),
          createObserver(focusedAndroidObservation()),
          { textClient: textClient.client },
        );
        // Current event modes split after the ASCII base; the a11y suffix begins with a mark.
        expect(await executor.type({ action: "type", text, mode })).toMatchObject({
          success: true,
        });
        expect(textClient.calls).toEqual([`insert:${remainder}`]);
      }
    },
  );

  test("iOS insert keeps existing text at the caret", async () => {
    const adb = new FakeAdbExecutor();
    let field = "before";
    let clearCalls = 0;
    const textClient = createTextClient().client;
    textClient.insert = async (text) => {
      field += text;
      return { success: true };
    };
    textClient.clear = async () => {
      clearCalls++;
      field = "";
      return { success: true };
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(adb),
      createObserver({ timestamp: 0 } as ObserveResult),
      { textClient },
    );

    expect(
      await executor.type({ action: "type", text: " after", operation: "insert" }),
    ).toMatchObject({ success: true, resolvedMode: "xcuiTypeText" });
    expect(field).toBe("before after");
    expect(clearCalls).toBe(0);
  });

  test("standalone Android clear falls back to ADB deletes after accessibility failure", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient().client;
    textClient.clear = async () => ({ success: false, error: "accessibility unavailable" });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("old", {}, 0)),
      { textClient },
    );

    expect(await executor.clear()).toMatchObject({ success: true });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
      "shell input keyevent KEYCODE_DEL",
    ]);
  });

  test("iOS semantic key forwards dispatch evidence to the text client", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient().client;
    const dispatches: string[] = [];
    textClient.ime = async (_action, _signal, onDispatch) => {
      onDispatch?.();
      return { success: true };
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient },
    );

    expect(
      await executor.key({ action: "key", key: "done" }, undefined, () => dispatches.push("sent")),
    ).toMatchObject({ success: true });
    expect(dispatches).toEqual(["sent"]);
  });

  test("auto password typing uses legacy delivery before any IME mutation", async () => {
    for (const [operation, expectedMode] of [
      ["insert", "eventAll"],
      ["replace", "a11y"],
    ] as const) {
      const adb = new FakeAdbExecutor();
      const textClient = createTextClient({
        commitViaIme: async () => ({ success: false, error: "password input rejected" }),
      });
      const observer = createObserver(focusedAndroidObservation("secret", { password: "true" }));
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        observer,
        { textClient: textClient.client },
      );

      const result = await executor.type({ action: "type", text: "new", operation });

      expect(result).toMatchObject({ success: true, resolvedMode: expectedMode });
      expect(textClient.commitViaImeCalls).toEqual([]);
      expect(textClient.calls).not.toContain("clear");
      expect(observer.calls).toBe(1);
      if (operation === "replace") {
        expect(textClient.calls).toContain("replace:new");
      }
    }
  });

  test("explicit IME mode retains password rejection", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: `${priorImeId}\n`, stderr: "" },
      { stdout: `${commitImeId}\n`, stderr: "" },
    ]);
    const textClient = createTextClient({
      commitViaIme: async () => ({ success: false, error: "password input rejected" }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("secret", { password: "true" })),
      { textClient: textClient.client },
    );

    expect(await executor.type({ action: "type", text: "new", mode: "ime" })).toMatchObject({
      success: false,
      resolvedMode: "ime",
      error: "password input rejected",
    });
    expect(textClient.commitViaImeCalls).toEqual([{ text: "new", priorImeId }]);
  });

  test("auto mode routes plain and formatting text through IME for insert and replace", async () => {
    for (const [operation, text] of [
      ["insert", "plain"],
      ["replace", "plain"],
      ["insert", "note `x`"],
      ["replace", "note `x`"],
    ] as const) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: `${priorImeId}\n`, stderr: "" },
        { stdout: `${commitImeId}\n`, stderr: "" },
      ]);
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation()),
        { textClient: textClient.client },
      );

      const result = await executor.type({ action: "type", text, operation });

      expect(result.resolvedMode).toBe("ime");
      expect(textClient.commitViaImeCalls).toEqual([{ text, priorImeId }]);
      expect(
        adb.getExecutedCommands().every((command) => !command.startsWith("shell input keyevent")),
      ).toBe(true);
    }
  });

  test("auto IME falls back to the previous delivery modes when commit is unavailable", async () => {
    for (const [operation, mode] of [
      ["insert", "eventAll"],
      ["replace", "a11y"],
    ] as const) {
      const adb = new FakeAdbExecutor();
      const textClient = createTextClient({ supportsImeCommit: false });
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation()),
        { textClient: textClient.client },
      );

      const result = await executor.type({ action: "type", text: "note `x`", operation });

      expect(result).toMatchObject({ success: true, resolvedMode: mode });
      expect(result.backend).toBeUndefined();
      expect(textClient.commitViaImeCalls).toEqual([]);
      if (mode === "eventAll") {
        expect(adb.getExecutedCommands().length).toBeGreaterThan(0);
      } else {
        expect(textClient.calls).toContain("replace:note `x`");
      }
    }
  });

  test("a failing non-IME fallback does not claim AutoMobile IME delivery", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient({ supportsImeCommit: false });
    textClient.client.replace = async () => {
      throw new Error("fallback rejected");
    };
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: textClient.client },
    );
    const result = await executor.type({
      action: "type",
      text: "value",
      operation: "replace",
      mode: "auto",
    });
    expect(result).toMatchObject({
      success: false,
      resolvedMode: "a11y",
      error: "fallback rejected",
    });
    expect(result.backend).toBeUndefined();
    expect(result.keyboard).toBeUndefined();
  });

  test("auto IME activation failure falls back before any editor mutation", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell ime set", { stdout: "", stderr: "selection failed" });
    adb.setCommandResponse("shell settings get secure default_input_method", {
      stdout: priorImeId,
      stderr: "",
    });
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "abc" });

    expect(result).toMatchObject({ success: true, resolvedMode: "eventAll" });
    expect(textClient.commitViaImeCalls).toEqual([]);
    expect(adb.getExecutedCommands()).toContain(`shell ime set ${commitImeId}`);
    expect(adb.getExecutedCommands()).toContain("shell input keyevent KEYCODE_A");
  });

  test("auto IME does not fall back after a partial commit", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      commitViaIme: async () => ({
        success: false,
        error: "commit interrupted",
        partialApplication: true,
      }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "abc" });

    expect(result).toMatchObject({ success: false, partialApplication: true, resolvedMode: "ime" });
    expect(textClient.calls).not.toContain("insert:abc");
    expect(adb.getExecutedCommands()).not.toContain("shell input keyevent KEYCODE_A");
  });

  test("auto fallback reports a11y when eventAll cannot encode any character", async () => {
    const textClient = createTextClient({ supportsImeCommit: false });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(focusedAndroidObservation()),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "😀" });

    expect(result).toMatchObject({ success: true, resolvedMode: "a11y" });
    expect(textClient.calls).toContain("insert:😀");
  });

  test("explicit IME key events require capability and use event delivery", async () => {
    const supported = createTextClient();
    const supportedAdb = new FakeAdbExecutor();
    supportedAdb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: `${priorImeId}\n`, stderr: "" },
      { stdout: `${commitImeId}\n`, stderr: "" },
    ]);
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(supportedAdb),
      createObserver(focusedAndroidObservation()),
      { textClient: supported.client },
    );
    const result = await executor.type({ action: "type", text: "Ab!", mode: "imeKeyEvents" });
    expect(result).toMatchObject({ success: true, resolvedMode: "imeKeyEvents" });
    expect(supported.commitDeliveries).toEqual(["keyEvents"]);

    const unsupported = createTextClient({ supportsImeKeyEvents: false });
    const adb = new FakeAdbExecutor();
    const unsupportedExecutor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: unsupported.client },
    );
    const rejected = await unsupportedExecutor.type({
      action: "type",
      text: "Ab!",
      mode: "imeKeyEvents",
    });
    expect(rejected).toMatchObject({
      success: false,
      error: expect.stringContaining("unavailable"),
    });
    expect(unsupported.commitDeliveries).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test.each(["é", "😀", "a😀", "line\nbreak", "a\tb", "ASCII then é"])(
    "imeKeyEvents replacement rejects %j before any mutation",
    async (text) => {
      const adb = new FakeAdbExecutor();
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation("original")),
        { textClient: textClient.client },
      );
      const result = await executor.type({
        action: "type",
        text,
        operation: "replace",
        mode: "imeKeyEvents",
      });
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining("printable ASCII"),
      });
      expect(result.partialApplication).toBeUndefined();
      expect(textClient.calls).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([]);
    },
  );

  test("imeKeyEvents ASCII and empty replacements still commit and clear", async () => {
    for (const text of ["Ab!", ""]) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: priorImeId, stderr: "" },
        { stdout: commitImeId, stderr: "" },
      ]);
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation("original")),
        { textClient: textClient.client },
      );
      expect(
        await executor.type({ action: "type", text, operation: "replace", mode: "imeKeyEvents" }),
      ).toMatchObject({ success: true });
      expect(textClient.calls).toContain("clear");
      expect(textClient.commitDeliveries).toEqual(["keyEvents"]);
    }
  });

  test("ime mode still accepts Unicode replacement text", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("original")),
      { textClient: textClient.client },
    );
    expect(
      await executor.type({ action: "type", text: "a😀", operation: "replace", mode: "ime" }),
    ).toMatchObject({ success: true });
    expect(textClient.calls).toContain("clear");
    expect(textClient.commitViaImeCalls[0]?.text).toBe("a😀");
  });

  test("explicit modes take precedence over trigger text and do not auto-fallback", async () => {
    const explicitImeClient = createTextClient({ supportsImeCommit: false });
    const explicitImeExecutor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver({ timestamp: 0 } as ObserveResult),
      { textClient: explicitImeClient.client },
    );
    const imeResult = await explicitImeExecutor.type({
      action: "type",
      text: "note `x`",
      mode: "ime",
    });
    expect(imeResult).toMatchObject({ success: false, resolvedMode: "ime" });

    const explicitA11yClient = createTextClient();
    const explicitA11yExecutor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: explicitA11yClient.client },
    );
    const a11yResult = await explicitA11yExecutor.type({
      action: "type",
      text: "note `x`",
      mode: "a11y",
    });
    expect(a11yResult).toMatchObject({ success: true, resolvedMode: "a11y" });
    expect(explicitA11yClient.calls).toContain("insert:note `x`");
  });

  test("ime mode activates the companion IME, commits with the prior id, and restores it", async () => {
    const events: string[] = [];
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: `${priorImeId}\n`, stderr: "" },
      { stdout: `${commitImeId}\n`, stderr: "" },
    ]);
    const executeCommand = adb.executeCommand.bind(adb);
    adb.executeCommand = async (command, ...options) => {
      events.push(`adb:${command}`);
      return executeCommand(command, ...options);
    };
    const textClient = createTextClient({
      commitViaIme: async (text, prior) => {
        events.push(`commit:${text}:${prior ?? "none"}`);
        return { success: true };
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "*bold*", mode: "ime" });

    expect(result).toMatchObject({
      success: true,
      resolvedMode: "ime",
      backend: "autoMobileIme",
      capability: "semanticText",
      keyboard: { component: commitImeId, package: "dev.jasonpearson.automobile.ctrlproxy" },
    });
    expect(textClient.getSupportsImeCommitCalls()).toBe(1);
    expect(textClient.commitViaImeCalls).toEqual([{ text: "*bold*", priorImeId }]);
    expect(events).toContain(`commit:*bold*:${priorImeId}`);
    expect(events.indexOf(`adb:shell ime set ${priorImeId}`)).toBeLessThan(
      events.indexOf("adb:shell settings delete secure selected_input_method_subtype"),
    );
    expect(
      events.indexOf("adb:shell settings delete secure selected_input_method_subtype"),
    ).toBeLessThan(events.indexOf(`adb:shell ime disable ${commitImeId}`));
  });

  test("ime mode preserves a companion keyboard that was already enabled", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell ime list -s", {
      stdout: `${priorImeId}\n${commitImeId}\n`,
      stderr: "",
    });
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: createTextClient().client },
    );

    expect((await executor.type({ action: "type", text: "value", mode: "ime" })).success).toBe(
      true,
    );
    expect(adb.getExecutedCommands()).not.toContain(`shell ime enable ${commitImeId}`);
    expect(adb.getExecutedCommands()).not.toContain(`shell ime disable ${commitImeId}`);
    expect(adb.getExecutedCommands()).toContain(`shell ime set ${priorImeId}`);
  });

  test("ime disable failures surface restoration failure after a successful commit", async () => {
    for (const failure of ["stderr", "throw"] as const) {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: `${priorImeId}\n`, stderr: "" },
        { stdout: `${commitImeId}\n`, stderr: "" },
      ]);
      if (failure === "stderr") {
        adb.setCommandResponse("shell ime disable", { stdout: "", stderr: "disable failed" });
      } else {
        adb.setCommandError("shell ime disable", new Error("disable failed"));
      }
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(),
        { textClient: createTextClient().client },
      );

      const result = await executor.type({ action: "type", text: "value", mode: "ime" });

      expect(result).toMatchObject({
        success: false,
        resolvedMode: "ime",
        error: expect.stringContaining(
          `Text commit succeeded, but Could not restore the original keyboard ${priorImeId}`,
        ),
      });
      expect(adb.getExecutedCommands()).toContain(`shell ime disable ${commitImeId}`);
      clearAndroidImeQuarantine(androidDevice.deviceId);
    }
  });

  test("ime mode disables a temporarily enabled IME when there was no prior default", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: "null\n", stderr: "" },
      { stdout: `${commitImeId}\n`, stderr: "" },
    ]);
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({ action: "type", text: "value", mode: "ime" });

    expect(result).toMatchObject({ success: true, resolvedMode: "ime" });
    expect(adb.getExecutedCommands()).not.toContain("shell ime set null");
    expect(adb.getExecutedCommands()).not.toContain(`shell ime set ${priorImeId}`);
    expect(adb.getExecutedCommands()).toContain(`shell ime disable ${commitImeId}`);
  });

  test("ime mode fails closed before switching when the command is not advertised", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient({ supportsImeCommit: false });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "value", mode: "ime" });

    expect(result).toMatchObject({
      success: false,
      resolvedMode: "ime",
      error: expect.stringContaining("IME commit is not available"),
    });
    expect(textClient.getSupportsImeCommitCalls()).toBe(1);
    expect(textClient.commitViaImeCalls).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("per-call profile is set before commit and restored afterward", async () => {
    const events: string[] = [];
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      setKeyboardProfile: async (id) => {
        events.push(`profile:${id}`);
        return { success: true, previousProfileId: "direct" };
      },
      commitViaIme: async () => {
        events.push("commit");
        return { success: true };
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    const result = await executor.type({
      action: "type",
      text: "value",
      keyboardProfile: "gboard",
    });
    expect(result).toMatchObject({ success: true, resolvedMode: "ime" });
    expect(events).toEqual(["profile:gboard", "commit", "profile:direct"]);
  });

  test("abort during enabled-IME read stops before profile switch or commit", async () => {
    const controller = new AbortController();
    const adb = new FakeAdbExecutor();
    adb.abortAfterCommand("shell ime list -s", controller);
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    await expect(
      executor.type(
        { action: "type", text: "secret", mode: "ime", keyboardProfile: "gboard" },
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(textClient.calls).not.toContain("setKeyboardProfile:gboard");
    expect(textClient.commitViaImeCalls).toEqual([]);
    expect(adb.getExecutedCommands()).not.toContain(`shell ime set ${commitImeId}`);
  });

  test("abort during profile switch restores profile without activating IME", async () => {
    const controller = new AbortController();
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient({
      setKeyboardProfile: async (id) => {
        if (id === "gboard") {
          controller.abort();
        }
        return { success: true, previousProfileId: "direct" };
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    await expect(
      executor.type(
        { action: "type", text: "secret", mode: "ime", keyboardProfile: "gboard" },
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(textClient.calls).toContain("setKeyboardProfile:direct");
    expect(textClient.commitViaImeCalls).toEqual([]);
    expect(adb.getExecutedCommands()).not.toContain(`shell ime set ${commitImeId}`);
  });

  test("per-call profile skips restoration when already active", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      setKeyboardProfile: async () => ({ success: true, previousProfileId: "gboard" }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    expect(
      (await executor.type({ action: "type", text: "value", keyboardProfile: "gboard" })).success,
    ).toBe(true);
    expect(textClient.calls.filter((call) => call.startsWith("setKeyboardProfile"))).toEqual([
      "setKeyboardProfile:gboard",
    ]);
  });

  test("profile restoration failure does not mask a successful commit", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      setKeyboardProfile: async (id) => {
        if (id === "direct") {
          throw new Error("restore failed");
        }
        return { success: true, previousProfileId: "direct" };
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    expect(
      (await executor.type({ action: "type", text: "value", keyboardProfile: "gboard" })).success,
    ).toBe(true);
    expect(adb.getExecutedCommands()).toContain(`shell ime set ${priorImeId}`);
  });

  test("unsupported profile command fails before adb mutation", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient({ supportsKeyboardProfiles: false });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    const result = await executor.type({
      action: "type",
      text: "value",
      keyboardProfile: "gboard",
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("does not support keyboard profiles"),
    });
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(textClient.commitViaImeCalls).toEqual([]);
  });

  test("profile with explicit non-IME mode returns validation error", async () => {
    const adb = new FakeAdbExecutor();
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    const result = await executor.type({
      action: "type",
      text: "value",
      mode: "a11y",
      keyboardProfile: "gboard",
    });
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("requires mode: ime"),
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("ime mode restores the prior IME when commit rejects", async () => {
    const events: string[] = [];
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const executeCommand = adb.executeCommand.bind(adb);
    adb.executeCommand = async (command, ...options) => {
      events.push(`adb:${command}`);
      return executeCommand(command, ...options);
    };
    const textClient = createTextClient({
      commitViaIme: async () => {
        events.push("commit:rejected");
        throw new Error("commit rejected");
      },
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    const result = await executor.type({ action: "type", text: "value", mode: "ime" });

    expect(result).toMatchObject({ success: false, resolvedMode: "ime", error: "commit rejected" });
    expect(textClient.commitViaImeCalls).toEqual([{ text: "value", priorImeId }]);
    expect(events.indexOf("commit:rejected")).toBeLessThan(
      events.indexOf(`adb:shell ime set ${priorImeId}`),
    );
    expect(events.indexOf(`adb:shell ime set ${priorImeId}`)).toBeLessThan(
      events.indexOf(`adb:shell ime disable ${commitImeId}`),
    );
  });

  test("ime mode restores the selected subtype after the original component", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    adb.setCommandResponse("shell settings get secure selected_input_method_subtype", {
      stdout: "42",
      stderr: "",
    });
    adb.setCommandResponse("shell dumpsys input_method", {
      stdout: `mId=${priorImeId}\n  mSubtypeId=42 mSubtypeLocale=en_US`,
      stderr: "",
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      {
        textClient: createTextClient().client,
      },
    );
    expect(await executor.type({ action: "type", text: "value", mode: "ime" })).toMatchObject({
      success: true,
    });
    const commands = adb.getExecutedCommands();
    expect(commands.indexOf(`shell ime set ${priorImeId}`)).toBeLessThan(
      commands.indexOf("shell settings put secure selected_input_method_subtype 42"),
    );
  });

  test("a no-longer-advertised subtype reports both commit and restore failures", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    adb.setCommandResponse("shell settings get secure selected_input_method_subtype", {
      stdout: "42",
      stderr: "",
    });
    adb.setCommandResponseSequence("shell dumpsys input_method", [
      { stdout: `mId=${priorImeId}\n  mSubtypeId=42 mSubtypeLocale=en_US`, stderr: "" },
      { stdout: `mId=${priorImeId}\n  mSubtypeId=99 mSubtypeLocale=en_US`, stderr: "" },
    ]);
    const textClient = createTextClient({
      commitViaIme: async () => ({ success: false, error: "commit rejected" }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      {
        textClient: textClient.client,
      },
    );
    const result = await executor.type({ action: "type", text: "value", mode: "ime" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("commit rejected");
    expect(result.error).toContain(`Could not restore the original keyboard ${priorImeId}`);
    expect(adb.getExecutedCommands()).not.toContain(
      "shell settings put secure selected_input_method_subtype 42",
    );
    clearAndroidImeQuarantine(androidDevice.deviceId);
  });

  test("activation and subtype restore failures both reach the caller", async () => {
    const device = { ...androidDevice, deviceId: "ime-activation-restore-failure" };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell settings get secure default_input_method", {
      stdout: priorImeId,
      stderr: "",
    });
    adb.setCommandResponse(`shell ime set ${commitImeId}`, {
      stdout: "",
      stderr: "activation rejected",
    });
    adb.setCommandResponse("shell settings get secure selected_input_method_subtype", {
      stdout: "42",
      stderr: "",
    });
    adb.setCommandResponseSequence("shell dumpsys input_method", [
      { stdout: `mId=${priorImeId}\n  mSubtypeId=42 mSubtypeLocale=en_US`, stderr: "" },
      { stdout: `mId=${priorImeId}\n  mSubtypeId=99 mSubtypeLocale=en_US`, stderr: "" },
    ]);
    const executor = new DefaultSendKeysCommandExecutor(
      device,
      createAdbFactory(adb),
      createObserver(),
      {
        textClient: createTextClient().client,
      },
    );
    const result = await executor.type({ action: "type", text: "value", mode: "ime" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to activate the IME for text commit.");
    expect(result.error).toContain(`Could not restore the original keyboard ${priorImeId}`);
    clearAndroidImeQuarantine(device.deviceId);
  });

  test("auto mode does not fall back after activation plus restoration failure", async () => {
    const device = { ...androidDevice, deviceId: "ime-auto-restore-failure" };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("shell settings get secure default_input_method", {
      stdout: priorImeId,
      stderr: "",
    });
    adb.setCommandResponse(`shell ime set ${commitImeId}`, {
      stdout: "",
      stderr: "activation rejected",
    });
    adb.setCommandResponse("shell settings get secure selected_input_method_subtype", {
      stdout: "42",
      stderr: "",
    });
    adb.setCommandResponseSequence("shell dumpsys input_method", [
      { stdout: `mId=${priorImeId}\n  mSubtypeId=42 mSubtypeLocale=en_US`, stderr: "" },
      { stdout: `mId=${priorImeId}\n  mSubtypeId=99 mSubtypeLocale=en_US`, stderr: "" },
    ]);
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      device,
      createAdbFactory(adb),
      createObserver(),
      {
        textClient: textClient.client,
      },
    );
    const result = await executor.type({ action: "type", text: "value", mode: "auto" });
    expect(result.success).toBe(false);
    expect(result.error).toContain(`Could not restore the original keyboard ${priorImeId}`);
    expect(textClient.calls.some((call) => call.startsWith("insert:"))).toBe(false);
    clearAndroidImeQuarantine(device.deviceId);
  });

  test("unacknowledged cancellation retains the IME and blocks later switches", async () => {
    const device = { ...androidDevice, deviceId: "ime-unsafe-test" };
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      commitViaIme: async () => ({ success: false, partialApplication: true, sessionUnsafe: true }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      device,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );
    try {
      expect(await executor.type({ action: "type", text: "value", mode: "ime" })).toMatchObject({
        success: false,
        partialApplication: true,
      });
      expect(adb.getExecutedCommands()).not.toContain(`shell ime set ${priorImeId}`);
      expect(adb.getExecutedCommands()).not.toContain(`shell ime disable ${commitImeId}`);
      await expect(withAndroidImeLock(device.deviceId, async () => {})).rejects.toThrow("unknown");
    } finally {
      clearAndroidImeQuarantine(device.deviceId);
    }
  });

  test("failed IME replacement reports partial application after clearing", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const textClient = createTextClient({
      commitViaIme: async () => ({ success: false, error: "deadline exceeded" }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(),
      { textClient: textClient.client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
      mode: "ime",
    });

    expect(result).toMatchObject({ success: false, partialApplication: true });
    expect(textClient.calls).toContain("clear");
    expect(adb.getExecutedCommands()).toContain(`shell ime set ${priorImeId}`);
  });

  test("serializes overlapping ime-mode calls on one device so capture/restore never interleave (#7464)", async () => {
    const device: BootedDevice = { ...androidDevice, deviceId: "emulator-overlap-7464" };
    const events: string[] = [];
    const adb = new FakeAdbExecutor();
    // Two full commits: each reads default_input_method twice (capture + verify).
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const executeCommand = adb.executeCommand.bind(adb);
    adb.executeCommand = async (command, ...options) => {
      events.push(`adb:${command}`);
      return executeCommand(command, ...options);
    };
    let releaseFirst!: () => void;
    const firstCommitGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const textClient = createTextClient({
      commitViaIme: async (text) => {
        events.push(`commit:${text}`);
        if (text === "first") {
          await firstCommitGate;
        }
        events.push(`commit-done:${text}`);
        return { success: true };
      },
    });
    const makeExecutor = () =>
      new DefaultSendKeysCommandExecutor(device, createAdbFactory(adb), createObserver(), {
        textClient: textClient.client,
      });
    const waitFor = async (predicate: () => boolean) => {
      for (let i = 0; i < 200; i++) {
        if (predicate()) {
          return;
        }
        await defaultTimer.sleep(5);
      }
      throw new Error("condition not met in time");
    };

    const first = makeExecutor().type({ action: "type", text: "first", mode: "ime" });
    // Call 1 holds the per-device lock and parks at its commit.
    await waitFor(() => events.includes("commit:first"));
    const snapshotAtBlock = [...events];

    const second = makeExecutor().type({ action: "type", text: "second", mode: "ime" });
    // Give call 2 every chance to progress; the lock must keep it from doing anything.
    for (let i = 0; i < 5; i++) {
      await defaultTimer.sleep(5);
    }
    expect(events).toEqual(snapshotAtBlock);

    releaseFirst();
    expect(await first).toMatchObject({ success: true });
    expect(await second).toMatchObject({ success: true });

    // No interleave: call 2 does nothing until call 1 has fully restored.
    const firstRestoreIdx = events.indexOf(`adb:shell ime set ${priorImeId}`);
    const secondCaptureIdx = events.indexOf(
      "adb:shell settings get secure default_input_method",
      firstRestoreIdx,
    );
    expect(firstRestoreIdx).toBeGreaterThan(0);
    expect(secondCaptureIdx).toBeGreaterThan(firstRestoreIdx);
    expect(events.indexOf("commit:second")).toBeGreaterThan(events.indexOf("commit-done:first"));
  });

  test("eventOnly replacement rejects unavailable text before mutation but accepts empty text", async () => {
    for (const text of [undefined, ""]) {
      const adb = new FakeAdbExecutor();
      const { client, calls } = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(
          focusedAndroidObservation("", { text, class: "custom.Editor", editable: true }),
        ),
        { textClient: client },
      );
      const result = await executor.type({
        action: "type",
        text: "a",
        operation: "replace",
        mode: "eventOnly",
      });
      expect(result.success).toBe(text === "");
      expect(calls).toEqual([]);
      if (text === undefined) {
        expect(result.error).toContain("text length");
        expect(adb.getExecutedCommands()).toEqual([]);
      } else {
        expect(adb.getExecutedCommands()).toContain("shell input keyevent KEYCODE_A");
        expect(adb.getExecutedCommands()).not.toContain("shell input keyevent KEYCODE_DEL");
      }
    }
  });

  test("iOS delivery exceptions report the XCUITest mechanism", async () => {
    const { client } = createTextClient();
    client.insert = async () => {
      throw new Error("runner unavailable");
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );
    const result = await executor.type({ action: "type", text: "value", mode: "eventLast" });
    expect(result).toMatchObject({
      success: false,
      requestedMode: "eventLast",
      resolvedMode: "xcuiTypeText",
      error: "runner unavailable",
    });
  });

  test("preserves partial-application metadata from accessibility insertion", async () => {
    const { client } = createTextClient();
    client.insert = async () => ({
      success: false,
      error: "Text was inserted, but caret restoration failed; do not retry",
      partialApplication: true,
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.type({ action: "type", text: "value", mode: "a11y" });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "Text was inserted, but caret restoration failed; do not retry",
    });
  });

  test("explicit eventAll uses key events and accessibility-inserts unsupported runs", async () => {
    const adb = new FakeAdbExecutor();
    const observer = createObserver(focusedAndroidObservation());
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      observer,
      { textClient: client },
    );

    const result = await executor.type({ action: "type", text: "a🙂", mode: "eventAll" });

    expect(result).toMatchObject({
      success: true,
      operation: "insert",
      requestedMode: "eventAll",
      resolvedMode: "eventAll",
      textLength: 2,
    });
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
    expect(calls).toEqual(["insert:🙂"]);
  });

  test("marks a late eventAll insertion failure as partially applied", async () => {
    const adb = new FakeAdbExecutor();
    const { client } = createTextClient();
    client.insert = async () => ({ success: false, error: "insert rejected" });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: client },
    );

    const result = await executor.type({ action: "type", text: "a🙂", mode: "eventAll" });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "insert rejected",
    });
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
  });

  test("marks a late eventAll key dispatch exception as partially applied", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("KEYCODE_B", new Error("dispatch rejected"));
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation()),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({ action: "type", text: "ab", mode: "eventAll" });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "dispatch rejected",
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_A",
      "shell input keyevent KEYCODE_B",
    ]);
  });

  test("marks an eventOnly dispatch exception after replacement clearing as partial", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("KEYCODE_B", new Error("dispatch rejected"));
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("old")),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({
      action: "type",
      text: "ab",
      operation: "replace",
      mode: "eventOnly",
    });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "dispatch rejected",
    });
    expect(adb.getExecutedCommands()).toContain("shell input keyevent KEYCODE_A");
    expect(adb.getExecutedCommands()).toContain("shell input keyevent KEYCODE_B");
  });

  test("marks a replacement clear failure after a delete as partially applied", async () => {
    const adb = new FakeAdbExecutor();
    const executeCommand = adb.executeCommand.bind(adb);
    let deleteCount = 0;
    adb.executeCommand = async (command, ...options) => {
      if (command === "shell input keyevent KEYCODE_DEL" && ++deleteCount === 2) {
        throw new Error("delete rejected");
      }
      return executeCommand(command, ...options);
    };
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("old")),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
      mode: "eventOnly",
    });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "delete rejected",
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL",
    ]);
  });

  test("does not mark a replacement clear failure before its first delete as partial", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("KEYCODE_DEL", new Error("delete rejected"));
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("old")),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
      mode: "eventOnly",
    });

    expect(result).toMatchObject({ success: false, error: "delete rejected" });
    expect(result).not.toHaveProperty("partialApplication");
  });

  test("accepts focused custom editable controls that expose text actions", async () => {
    const adb = new FakeAdbExecutor();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(
        focusedAndroidObservation("", {
          class: "com.example.CustomEditable",
          actions: ["set_text", "set_selection"],
        }),
      ),
      { textClient: createTextClient().client },
    );

    const result = await executor.type({ action: "type", text: "a", mode: "eventAll" });

    expect(result.success).toBe(true);
    expect(adb.getExecutedCommands()).toEqual(["shell input keyevent KEYCODE_A"]);
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

  test("Android event modes reject an unfocused field before mutation", async () => {
    for (const mode of ["eventLast", "eventAll", "eventOnly"] as const) {
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
        text: "a",
        mode,
      });

      expect(result).toMatchObject({
        success: false,
        error: "Android event delivery requires a focused editable field",
      });
      expect(calls).toEqual([]);
      expect(adb.getExecutedCommands()).toEqual([]);
    }
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
      createObserver(focusedAndroidObservation()),
      { textClient: client, inputKey },
    );

    await executor.key({ action: "key", key: "next", modifiers: ["shift"] });
    await executor.key({ action: "key", key: "tab", modifiers: ["shift"] });

    expect(calls).toEqual(["ime:next"]);
    expect(press).toHaveBeenCalledTimes(1);
    expect(press).toHaveBeenCalledWith("tab", undefined, undefined, ["shift"]);
  });

  test("rejects Android semantic keys without a focused editable field", async () => {
    const { client, calls } = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.key({ action: "key", key: "done" });

    expect(result).toMatchObject({
      success: false,
      error: "Android event delivery requires a focused editable field",
    });
    expect(calls).toEqual([]);
  });

  test("iOS accepts every mode and reports its XCUITest mechanism", async () => {
    for (const mode of ["a11y", "eventLast", "eventAll", "eventOnly", "ime"] as const) {
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

      expect(result).toMatchObject({
        success: true,
        requestedMode: mode,
        resolvedMode: "xcuiTypeText",
      });
      expect(calls).toEqual(["clear", "insert:value"]);
    }
  });

  test("marks a failed iOS replacement insert as partially applied after clearing", async () => {
    const { client, calls } = createTextClient();
    client.insert = async (text) => {
      calls.push(`insert:${text}`);
      return { success: false, error: "insert rejected" };
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );

    const result = await executor.type({
      action: "type",
      text: "replacement",
      operation: "replace",
    });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: "insert rejected",
      resolvedMode: "xcuiTypeText",
    });
    expect(calls).toEqual(["clear", "insert:replacement"]);
  });

  test("does not insert an iOS replacement after cancellation during clear", async () => {
    const controller = new AbortController();
    const { client, calls } = createTextClient();
    client.clear = async () => {
      calls.push("clear");
      controller.abort();
      return { success: true };
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );

    await expect(
      executor.type(
        { action: "type", text: "replacement", operation: "replace" },
        controller.signal,
      ),
    ).rejects.toThrow();

    expect(calls).toEqual(["clear"]);
  });
});

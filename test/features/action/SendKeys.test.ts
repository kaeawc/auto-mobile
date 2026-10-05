import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { imeOcclusionHierarchy } from "../../fixtures/observe/imeOcclusion";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { android, createSendKeysHarness, observer as harnessObserver } from "./SendKeysTestHarness";
import { ActionableError } from "../../../src/models/ActionableError";
import { logger } from "../../../src/utils/logger";
import { loggerCallsWithPrefix } from "../../helpers/loggerCallsWithPrefix";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import {
  SEND_KEYS_MAX_COMMANDS,
  SEND_KEYS_MAX_MODIFIERS,
  DefaultSendKeysCommandExecutor,
  SendKeys,
  type SendKeysCommandExecutor,
  type SendKeysInputKey,
  type SendKeysObserver,
  type SendKeysTextClient,
} from "../../../src/features/action/SendKeys";
import type { AdbClientFactory } from "../../../src/utils/android-cmdline-tools/AdbClientFactory";
import { DELETE_KEYEVENT_CHUNK_SIZE } from "../../../src/features/action/ClearText";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeWindow } from "../../fakes/FakeWindow";
import { BaseVisualChange } from "../../../src/features/action/BaseVisualChange";
import {
  hasPendingTerminalScreenshot,
  runWithPostActionCaptureScope,
} from "../../../src/utils/PostActionCaptureContext";
import { FakeWebSocket } from "../../fakes/FakeWebSocket";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios/IOSCtrlProxyClient";
import { CtrlProxyText } from "../../../src/features/observe/ios/CtrlProxyText";
import { createIosDelegateHarness } from "../../helpers/iosDelegateHarness";
import {
  clearAndroidImeQuarantine,
  withAndroidImeLock,
} from "../../../src/features/action/androidImeLock";

describe("SendKeys iOS text transport", () => {
  test.each([5, 1000])("passes a scaled timeout for %s characters", async (length) => {
    const { client } = createTextClient();
    const insert = spyOn(client, "insert");
    const controller = new AbortController();
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client },
    );
    const result = await executor.type(
      { action: "type", text: "a".repeat(length) },
      controller.signal,
    );
    expect(result.success).toBe(true);
    expect(insert.mock.calls[0][1]).toMatchObject({
      timeoutMs: length === 5 ? 5000 : 102000,
      abortSignal: controller.signal,
    });
    insert.mockRestore();
  });

  test("iOS executor forwards the remaining request deadline", async () => {
    const { client } = createTextClient();
    const insert = spyOn(client, "insert");
    const timer = new FakeTimer();
    const deadline = timer.now() + 4000;
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      createObserver(),
      { textClient: client, timer },
    );
    try {
      await runWithTextRequestContext({ getDeadlineMs: () => deadline }, () =>
        executor.type({ action: "type", text: "a".repeat(1000) }),
      );
      expect(insert.mock.calls[0][1]).toMatchObject({
        timeoutMs: 3000,
        deadlineMs: deadline - 1000,
      });
    } finally {
      insert.mockRestore();
    }
  });

  test.each(["timeout", "disconnect", "requestExpiry"])(
    "preserves indeterminate %s through the real iOS adapter",
    async (failure) => {
      const h = createIosDelegateHarness();
      const text = new CtrlProxyText(h.context);
      const getInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
        text as unknown as IOSCtrlProxyClient,
      );
      try {
        const observer = createObserver();
        const executor = new DefaultSendKeysCommandExecutor(
          iosDevice,
          createAdbFactory(new FakeAdbExecutor()),
          observer,
        );
        const sendKeys = new SendKeys(iosDevice, undefined, {
          executor,
          observer,
          timer: h.timer,
          timestampProvider: { now: async () => 0 },
        });
        const controller = new AbortController();
        const pending = sendKeys.execute(
          [
            { action: "type", text: "hello" },
            { action: "type", text: "again" },
          ],
          undefined,
          undefined,
          controller.signal,
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (failure === "timeout") {
          h.advanceTime(5000);
        } else if (failure === "requestExpiry") {
          controller.abort(new Error("Request timed out after 30000ms"));
        } else {
          h.requestManager.cancelAll(new Error("runner disconnected"));
        }
        const result = await pending;
        expect(result).toMatchObject({
          success: false,
          retryable: false,
          commands: [{ retryable: false }],
        });
        expect(result.error).toContain("outcome is indeterminate");
        expect(result.error).toContain("Do not retry automatically");
        expect(h.sentMessages).toHaveLength(1);
      } finally {
        getInstance.mockRestore();
      }
    },
  );
});

describe("SendKeys IME failure after typing", () => {
  const reason = "No element has keyboard focus -- ensure a text field is focused";
  const guidance = `IME action 'done' failed after the text was entered: ${reason}. Do not retype the text.`;

  test.each([false, true])(
    "adds guidance on the real iOS command path (throws=%s)",
    async (throws) => {
      const { client, calls } = createTextClient();
      client.ime = async () => {
        if (throws) {
          throw new Error(reason);
        }
        return { success: false, error: reason };
      };
      const observer = createObserver();
      const executor = new DefaultSendKeysCommandExecutor(
        iosDevice,
        createAdbFactory(new FakeAdbExecutor()),
        observer,
        { textClient: client },
      );
      const sendKeys = new SendKeys(iosDevice, undefined, {
        executor,
        observer,
        timer: new FakeTimer(),
        timestampProvider: { now: async () => 0 },
      });

      const result = await sendKeys.execute([
        { action: "type", text: "1\n" },
        { action: "key", key: "done" },
      ]);

      expect(calls).toEqual(["insert:1\n"]);
      expect(result).toMatchObject({
        success: false,
        completedCommands: 1,
        failedIndex: 1,
        error: guidance,
        commands: [
          { action: "type", success: true },
          { action: "key", success: false, error: guidance },
        ],
      });
    },
  );

  test.each([false, true])(
    "a failed Android done wire result is a tool failure (afterTyping=%s)",
    async (afterTyping) => {
      const timer = new FakeTimer();
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
      adb.setScreenState(true);
      const device = { ...androidDevice, deviceId: `ime-done-failure-${afterTyping}` };
      const reason = "No focused editable node found for IME action";
      const requests: Record<string, unknown>[] = [];
      const client = AndroidCtrlProxyClient.createForTesting(
        device,
        adb,
        (url) => {
          const socket = new FakeWebSocket(url, "none", 0, timer);
          socket.send = (data: unknown) => {
            const request = JSON.parse(String(data)) as Record<string, unknown>;
            if (request.type === "request_ime_action") {
              requests.push(request);
              socket.simulateMessage(
                JSON.stringify({
                  type: "ime_action_result",
                  requestId: request.requestId,
                  action: "done",
                  success: false,
                  error: reason,
                  totalTimeMs: 0,
                }),
              );
            }
          };
          return socket;
        },
        timer,
      );
      const { client: textClient, calls } = createTextClient();
      textClient.ime = (action) => client.requestImeAction(action);
      const observer = createObserver(focusedAndroidObservation("", {}, 1));
      const executor = new DefaultSendKeysCommandExecutor(device, createAdbFactory(adb), observer, {
        textClient,
        timer,
      });
      const sendKeys = new SendKeys(device, undefined, {
        executor,
        observer,
        timer,
        timestampProvider: { now: async () => 0 },
      });
      try {
        expect(await client.ensureConnected()).toBe(true);
        const result = await sendKeys.execute([
          ...(afterTyping
            ? [{ action: "type" as const, text: "note", mode: "a11y" as const }]
            : []),
          { action: "key", key: "done" },
        ]);
        const error = afterTyping
          ? `IME action 'done' failed after the text was entered: ${reason}. Do not retype the text.`
          : reason;
        expect(requests).toMatchObject([{ type: "request_ime_action", action: "done" }]);
        expect(calls).toEqual(afterTyping ? ["insert:note"] : []);
        expect(result).toMatchObject({
          success: false,
          completedCommands: afterTyping ? 1 : 0,
          failedIndex: afterTyping ? 1 : 0,
          error,
        });
        expect(result.commands.at(-1)).toMatchObject({ action: "key", success: false, error });
      } finally {
        await client.close();
      }
    },
  );

  test("does not claim typing succeeded when the type step fails", async () => {
    const { client } = createTextClient();
    client.insert = async () => ({ success: false, error: "typing failed" });
    const ime = mock(async () => ({ success: true }));
    client.ime = ime;
    const observer = createObserver();
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      observer,
      { textClient: client },
    );
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer,
      timer: new FakeTimer(),
      timestampProvider: { now: async () => 0 },
    });

    expect(
      await sendKeys.execute([
        { action: "type", text: "1\n" },
        { action: "key", key: "done" },
      ]),
    ).toMatchObject({
      success: false,
      completedCommands: 0,
      failedIndex: 0,
      error: "typing failed",
    });
    expect(ime).not.toHaveBeenCalled();
  });

  test("retains a raw IME failure when no type step completed", async () => {
    const { client } = createTextClient();
    client.ime = async () => ({ success: false, error: reason });
    const observer = createObserver();
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      observer,
      { textClient: client },
    );
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer,
      timer: new FakeTimer(),
      timestampProvider: { now: async () => 0 },
    });

    expect(
      await sendKeys.execute([
        { action: "key", key: "done" },
        { action: "key", key: "tab" },
      ]),
    ).toMatchObject({ success: false, completedCommands: 0, failedIndex: 0, error: reason });
  });
});

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
      committedUnits?: number;
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
const typeFocusedInputError =
  'Android event delivery requires a focused editable field. For printable ASCII, mode: "imeKeyEvents" types without requiring a focused editable node.';

describe("SendKeys", () => {
  test("sendKeys with a not-fresh current hierarchy still delivers keys", async () => {
    const observation = focusedAndroidObservation("123", {}, 0);
    observation.freshness = { isFresh: false, category: "window_identity" };
    const staleObserver = createObserver(observation);
    const h = createSendKeysHarness(android);
    const sendKeys = new SendKeys(android, createAdbFactory(h.adb), {
      executor: h.executor,
      observer: staleObserver,
      timestampProvider: { now: async () => 0 },
      timer: new FakeTimer(),
    });
    const result = await sendKeys.execute([{ action: "key", key: "enter" }]);
    expect(result.success).toBe(true);
    expect(result.completedCommands).toBe(1);
    expect(result.observation?.freshness?.isFresh).toBe(false);
  });

  function imeVerificationHarness(observer: SendKeysObserver) {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeIdForFake, stderr: "" },
      { stdout: commitImeIdForFake, stderr: "" },
    ]);
    const textClient = createTextClient({
      commitViaIme: async (text) => ({ success: true, committedUnits: text.length }),
    });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      observer,
      { textClient: textClient.client, timer },
    );
    return { executor, timer, textClient, adb };
  }

  test.each([
    ["default type", undefined],
    ["explicit insert/append", "insert"],
  ] as const)("rejects unfocused %s before text dispatch", async (_name, operation) => {
    const observer = createObserver(focusedAndroidObservation("", { focused: "false" }, 0));
    const { executor, timer, textClient, adb } = imeVerificationHarness(observer);
    textClient.client.clear = async () => ({
      success: false,
      error: "No focused editable node found",
    });
    const clearResult = await executor.clear();
    expect(clearResult).toEqual({
      success: false,
      error: "Android event delivery requires a focused editable field",
    });
    observer.calls = 0;
    const sendKeys = new SendKeys(androidDevice, createAdbFactory(adb), {
      executor,
      observer,
      timer,
      timestampProvider: { now: async () => 0 },
    });
    const result = await sendKeys.execute([{ action: "type", text: "qq1", operation }]);
    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      failedIndex: 0,
      error: typeFocusedInputError,
      commands: [{ index: 0, action: "type", success: false, error: typeFocusedInputError }],
    });
    expect(textClient.calls).toEqual([]);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(observer.calls).toBe(2); // Existing auto pre-read and final SendKeys observation.
  });

  test.each([true, false])(
    "focused auto insert keeps read and dispatch counts (IME supported=%s)",
    async (supportsIme) => {
      const observer = createObserver(focusedAndroidObservation("a", {}, 0));
      const { executor, textClient, adb } = imeVerificationHarness(observer);
      textClient.client.supportsImeCommit = async () => supportsIme;
      const readState = mock(async () => undefined);
      textClient.client.readInsertTextState = readState;
      expect(await executor.type({ action: "type", text: "a" })).toMatchObject({
        success: true,
        resolvedMode: supportsIme ? "ime" : "eventAll",
      });
      expect(observer.calls).toBe(2);
      expect(readState).toHaveBeenCalledTimes(0);
      expect(textClient.commitViaImeCalls).toHaveLength(supportsIme ? 1 : 0);
      expect(textClient.calls.filter((call) => call.startsWith("insert:"))).toHaveLength(0);
      expect(
        adb.getExecutedCommands().filter((command) => command === "shell input keyevent KEYCODE_A"),
      ).toHaveLength(supportsIme ? 0 : 1);
    },
  );

  test.each(["insert", "replace"] as const)(
    "explicit IME %s rejects absent editable focus on its existing read-back",
    async (operation) => {
      const observer = createObserver(focusedAndroidObservation("", { focused: "false" }, 0));
      const { executor, textClient } = imeVerificationHarness(observer);
      expect(
        await executor.type({ action: "type", text: "a", mode: "ime", operation }),
      ).toMatchObject({
        success: false,
        partialApplication: true,
        error: expect.stringContaining("Android event delivery requires a focused editable field"),
      });
      expect(observer.calls).toBe(1);
      expect(textClient.commitViaImeCalls).toHaveLength(1);
    },
  );

  test.each([
    ["insert", false],
    ["replace", false],
    ["insert", true],
    ["replace", true],
  ] as const)(
    "auto %s accepts post-commit focus loss as unverifiable (settle=%s)",
    async (operation, settle) => {
      let reads = 0;
      const { executor, textClient, timer } = imeVerificationHarness({
        execute: async () => {
          reads++;
          return focusedAndroidObservation(
            "",
            { focused: reads === 1 || (settle && reads === 2) ? "true" : "false" },
            0,
          );
        },
      });
      const result = await executor.type({ action: "type", text: "123456", operation });
      expect(result).toMatchObject({ success: true, resolvedMode: "ime", committedUnits: 6 });
      expect(result.error).toBeUndefined();
      expect(result.partialApplication).toBeUndefined();
      expect(result.verified).toBeUndefined(); // Same convention as an unreadable IME field.
      expect(textClient.commitViaImeCalls).toHaveLength(1);
      expect(textClient.calls.includes("clear")).toBe(operation === "replace");
      expect(reads).toBe(settle ? 3 : 2);
      expect(timer.getSleepHistory()).toEqual(settle ? [150] : []);
    },
  );

  test("auto replace keeps failing read-back when its pre-check never confirmed editable focus", async () => {
    const observer = createObserver(focusedAndroidObservation("", { focused: "false" }, 0));
    const { executor, textClient } = imeVerificationHarness(observer);
    expect(
      await executor.type({ action: "type", text: "123456", operation: "replace" }),
    ).toMatchObject({
      success: false,
      partialApplication: true,
      error: expect.stringContaining("Android event delivery requires a focused editable field"),
    });
    expect(observer.calls).toBe(2);
    expect(textClient.commitViaImeCalls).toHaveLength(1);
  });

  test.each([undefined, "ime", "eventLast", "eventAll", "eventOnly"] as const)(
    "type refusal offers mode imeKeyEvents (requested=%s)",
    async (mode) => {
      const observer = createObserver(focusedAndroidObservation("", { focused: "false" }, 0));
      const { executor } = imeVerificationHarness(observer);
      const result = await executor.type({ action: "type", text: "a", mode });
      expect(result.success).toBe(false);
      expect(result.error).toContain('mode: "imeKeyEvents"');
      expect(result.error).toContain("types without requiring a focused editable node");
    },
  );

  test("clear keeps the same failure and read/dispatch counts without editable focus", async () => {
    const observer = createObserver(focusedAndroidObservation("", { focused: "false" }, 0));
    const { executor, textClient, adb } = imeVerificationHarness(observer);
    const clear = mock(async () => ({ success: false, error: "No focused editable node found" }));
    textClient.client.clear = clear;
    expect(await executor.clear()).toEqual({
      success: false,
      error: "Android event delivery requires a focused editable field",
    });
    expect(clear).toHaveBeenCalledTimes(1);
    expect(observer.calls).toBe(1);
    expect(adb.getExecutedCommands()).toEqual([]);
  });

  test("back and home do not require editable focus", async () => {
    const observer = createObserver(focusedAndroidObservation("", { focused: "false" }, 0));
    const { textClient, adb, timer } = imeVerificationHarness(observer);
    const press = mock(async (_key: Parameters<SendKeysInputKey["press"]>[0]) => ({
      success: true,
    }));
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      observer,
      { textClient: textClient.client, inputKey: { press }, timer },
    );
    for (const key of ["back", "home"] as const) {
      expect(await executor.key({ action: "key", key })).toMatchObject({ success: true });
    }
    expect(press.mock.calls.map((call) => call[0])).toEqual(["back", "home"]);
    expect(observer.calls).toBe(0);
    expect(textClient.calls).toEqual([]);
  });

  test("eventOnly retains its existing editable-focus guard", async () => {
    const observer = createObserver(focusedAndroidObservation("", { focused: "false" }, 0));
    const { executor, adb, textClient } = imeVerificationHarness(observer);
    expect(await executor.type({ action: "type", text: "a", mode: "eventOnly" })).toMatchObject({
      success: false,
      error: typeFocusedInputError,
    });
    expect(observer.calls).toBe(1);
    expect(adb.getExecutedCommands()).toEqual([]);
    expect(textClient.calls).toEqual([]);
  });

  test("explicit IME key events retain raw delivery without editable hierarchy focus", async () => {
    const observer = createObserver(focusedAndroidObservation("", { focused: "false" }, 0));
    const { executor, textClient } = imeVerificationHarness(observer);
    expect(await executor.type({ action: "type", text: "a", mode: "imeKeyEvents" })).toMatchObject({
      success: true,
      resolvedMode: "imeKeyEvents",
    });
    expect(observer.calls).toBe(0);
    expect(textClient.commitDeliveries).toEqual(["keyEvents"]);
  });

  test("routes IME read-back and auto password pre-check to the requested display", async () => {
    const observer = createObserver(focusedAndroidObservation("123", {}, 0));
    const { executor } = imeVerificationHarness(observer);
    expect(
      await executor.type({ action: "type", text: "123" }, undefined, "external"),
    ).toMatchObject({ success: true });
    expect(observer.options).toEqual([
      { signal: undefined, freshness: "fresh", display: "external" },
      { signal: undefined, freshness: "fresh", display: "external" },
    ]);
  });

  test("threads the routed display from SendKeys into IME read-back", async () => {
    const observation = focusedAndroidObservation("123", {}, 0);
    observation.display = { key: "external", role: "external", generation: 1, posture: "unknown" };
    observation.displayRevision = 0;
    const observer = createObserver(observation);
    const { executor, timer, adb } = imeVerificationHarness(observer);
    adb.setCommandResponse("shell cmd display get-displays", {
      stdout:
        'Display id 2: DisplayInfo{"Panel", displayId 2, uniqueId "local:external", 200 x 200}',
      stderr: "",
    });
    const device: BootedDevice = {
      ...androidDevice,
      displays: {
        panels: [{ key: "external", role: "external", sizePx: { width: 200, height: 200 } }],
        postures: [],
      },
    };
    const sendKeys = new SendKeys(device, createAdbFactory(adb), {
      executor,
      observer,
      timer,
      lastRenderedObservation: () => observation,
      displayTransitions: { revision: () => 0 },
      timestampProvider: { now: async () => 0 },
      focuser: { focus: async () => ({ success: true }) },
    });
    expect(
      await sendKeys.execute(
        [{ action: "type", text: "123", mode: "ime" }],
        { text: "Phone" },
        undefined,
        undefined,
        "external",
      ),
    ).toMatchObject({ success: true });
    expect(
      observer.options.filter(
        (options) => options?.freshness === "fresh" && options.minTimestamp === undefined,
      ),
    ).toEqual([{ signal: undefined, freshness: "fresh", display: "external" }]);
  });

  test.each(["123", "one *bold* two `code` tail"])(
    "preserves a successful IME commit when read-back throws: %s",
    async (text) => {
      const error = new Error("hierarchy timed out");
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        const { executor, textClient } = imeVerificationHarness({
          execute: async () => {
            throw error;
          },
        });
        const result = await executor.type({ action: "type", text, mode: "ime" });
        expect(result).toMatchObject({ success: true, committedUnits: text.length });
        expect(result.partialApplication).toBeUndefined();
        expect(textClient.commitViaImeCalls).toHaveLength(1);
        expect(warning).toHaveBeenCalledWith(
          "[SendKeys] IME read-back unavailable: hierarchy timed out",
          error,
        );
      } finally {
        warning.mockRestore();
      }
    },
  );

  test.each([false, true])(
    "propagates IME read-back aborts with aborted signal=%s",
    async (abortSignal) => {
      const controller = new AbortController();
      const error = new DOMException("read-back aborted", "AbortError");
      const { executor, adb } = imeVerificationHarness({
        execute: async () => {
          if (abortSignal) {
            controller.abort(error);
          }
          throw error;
        },
      });
      await expect(
        executor.type({ action: "type", text: "123", mode: "ime" }, controller.signal),
      ).rejects.toBe(error);
      expect(adb.getExecutedCommands()).toContain(`shell ime set ${priorImeIdForFake}`);
    },
  );

  test.each(["123", "one *bold* two `code` tail"])(
    "settles a mismatching IME read-back after exactly one wait: %s",
    async (text) => {
      let reads = 0;
      const { executor, timer } = imeVerificationHarness({
        execute: async () => focusedAndroidObservation(++reads === 1 ? "partial" : text, {}, 0),
      });
      expect(await executor.type({ action: "type", text, mode: "ime" })).toMatchObject({
        success: true,
      });
      expect(reads).toBe(2);
      expect(timer.getSleepHistory()).toEqual([150]);
    },
  );

  test.each(["123", "one *bold* two `code` tail"])(
    "reports the last of three mismatching IME read-backs: %s",
    async (text) => {
      const fields = ["first", "second", "last"];
      let reads = 0;
      const { executor, timer } = imeVerificationHarness({
        execute: async () => focusedAndroidObservation(fields[reads++]!, {}, 0),
      });
      const result = await executor.type({ action: "type", text, mode: "ime" });
      expect(result).toMatchObject({
        success: false,
        partialApplication: true,
        committedUnits: text.length,
      });
      expect(result.error).toContain('the focused field holds "last"');
      expect(reads).toBe(3);
      expect(timer.getSleepHistory()).toEqual([150, 150]);
    },
  );

  test.each(["123", "one *bold* two `code` tail"])(
    "adds zero waits when IME read-back matches immediately: %s",
    async (text) => {
      const observer = createObserver(focusedAndroidObservation(text, {}, 0));
      const { executor, timer } = imeVerificationHarness(observer);
      expect(await executor.type({ action: "type", text, mode: "ime" })).toMatchObject({
        success: true,
      });
      expect(observer.calls).toBe(1);
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );

  test.each(["123", "one *bold* two `code` tail"])(
    "accepts an unverifiable IME re-read: %s",
    async (text) => {
      let reads = 0;
      const { executor, timer } = imeVerificationHarness({
        execute: async () =>
          ++reads === 1
            ? focusedAndroidObservation("partial", {}, 0)
            : ({ timestamp: 0 } as ObserveResult),
      });
      expect(await executor.type({ action: "type", text, mode: "ime" })).toMatchObject({
        success: true,
      });
      expect(reads).toBe(2);
      expect(timer.getSleepHistory()).toEqual([150]);
    },
  );

  test("preserves a successful IME commit when a settle re-read throws", async () => {
    let reads = 0;
    const { executor, timer } = imeVerificationHarness({
      execute: async () => {
        if (++reads === 1) {
          return focusedAndroidObservation("partial", {}, 0);
        }
        throw new Error("settle read failed");
      },
    });
    expect(await executor.type({ action: "type", text: "123", mode: "ime" })).toMatchObject({
      success: true,
    });
    expect(reads).toBe(2);
    expect(timer.getSleepHistory()).toEqual([150]);
  });

  test("prefers focused editable hierarchy text over a later focused label", async () => {
    const observation = focusedAndroidObservation("123", {}, 0);
    observation.viewHierarchy = {
      hierarchy: {
        node: {
          node: [
            { $: { focused: "true", text: "123", class: "custom.Editor", editable: "true" } },
            { $: { focused: "true", text: "label", class: "android.widget.TextView" } },
          ],
        },
      },
    } as ObserveResult["viewHierarchy"];
    const { executor, timer } = imeVerificationHarness(createObserver(observation));
    expect(await executor.type({ action: "type", text: "123", mode: "ime" })).toMatchObject({
      success: true,
    });
    expect(timer.getSleepHistory()).toEqual([]);
  });

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
      { signal: undefined, freshness: "fresh", minTimestamp: 1234 },
    ]);
  });

  test("stops iOS sendKeys at a failed arrow and reports the runner message", async () => {
    const observer = createObserver();
    const { client, calls } = createTextClient();
    const inputKey: SendKeysInputKey = {
      press: async () => ({
        success: false,
        key: "arrow_left",
        keyCode: "arrow_left",
        error:
          "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead",
      }),
    };
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      observer,
      { textClient: client, inputKey },
    );
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer,
      timestampProvider: { now: async () => 0 },
    });

    const result = await sendKeys.execute([
      { action: "key", key: "arrow_left" },
      { action: "type", text: "Z" },
    ]);

    expect(result).toMatchObject({
      success: false,
      completedCommands: 0,
      failedIndex: 0,
      error:
        "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead",
      commands: [
        {
          success: false,
          error:
            "arrow keys have no effect on this iOS runtime; use Cmd+arrow (line start/end) or sendKeys text editing instead",
        },
      ],
    });
    expect(calls).toEqual([]);
  });

  test("marks an uncheckable iOS arrow step as unverified", async () => {
    const observer = createObserver();
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      observer,
      { inputKey: { press: async () => ({ success: true, verified: false }) } },
    );
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer,
      timestampProvider: { now: async () => 0 },
    });

    expect(await sendKeys.execute([{ action: "key", key: "arrow_right" }])).toMatchObject({
      success: true,
      commands: [{ success: true, verified: false }],
    });
  });

  test("surfaces successful iOS key warnings on commands and joins them on the result", async () => {
    const observer = createObserver();
    const warning = "Key 'backspace' value did not change; delivery could not be confirmed";
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      observer,
      { inputKey: { press: async () => ({ success: true, warning }) } },
    );
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer,
      timestampProvider: { now: async () => 0 },
    });
    const result = await sendKeys.execute([
      { action: "key", key: "backspace" },
      { action: "key", key: "backspace" },
    ]);
    expect(result).toMatchObject({
      success: true,
      warning: `${warning} ${warning}`,
      commands: [
        { success: true, warning },
        { success: true, warning },
      ],
    });
  });

  test("keeps a reliable-field runner error as a failed iOS key command", async () => {
    const observer = createObserver();
    const error = "Key 'backspace' did not decrease text length: before 4, observed 4";
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      observer,
      { inputKey: { press: async () => ({ success: false, error }) } },
    );
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer,
      timestampProvider: { now: async () => 0 },
    });
    expect(await sendKeys.execute([{ action: "key", key: "backspace" }])).toMatchObject({
      success: false,
      error,
      commands: [{ success: false, error }],
    });
  });

  test("retains an earlier successful key warning when a later key fails", async () => {
    const observer = createObserver();
    const warning = "Earlier value did not change; delivery could not be confirmed";
    const error = "Key 'backspace' did not decrease text length: before 4, observed 4";
    let calls = 0;
    const executor = new DefaultSendKeysCommandExecutor(
      iosDevice,
      createAdbFactory(new FakeAdbExecutor()),
      observer,
      {
        inputKey: {
          press: async () =>
            ++calls === 1 ? { success: true, warning } : { success: false, error },
        },
      },
    );
    const sendKeys = new SendKeys(iosDevice, undefined, {
      executor,
      observer,
      timestampProvider: { now: async () => 0 },
    });
    expect(
      await sendKeys.execute([
        { action: "key", key: "backspace" },
        { action: "key", key: "backspace" },
      ]),
    ).toMatchObject({
      success: false,
      warning,
      error,
      commands: [
        { success: true, warning },
        { success: false, error },
      ],
    });
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
      { signal: undefined, freshness: "fresh", minTimestamp: undefined },
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
          createObserver(focusedAndroidObservation(text)),
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
    "%s handles ASCII-base graphemes according to its delivery strategy",
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
        expect(await executor.type({ action: "type", text, mode })).toMatchObject({
          success: true,
        });
        expect(textClient.calls).toEqual([`insert:${mode === "eventAll" ? text : remainder}`]);
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

  test.each(["abc", "Type here", ""])(
    "eventOnly replace types after clearing to a hint (before=%j)",
    async (before) => {
      const adb = new FakeAdbExecutor();
      adb.setAndroidApiLevel(34);
      const { client, calls } = createTextClient();
      const hint = "Type here";
      const beforeObservation = focusedAndroidObservation(before, { "hint-text": hint }, 0);
      const afterObservation = focusedAndroidObservation(hint, { "hint-text": hint }, 0);
      const observer: SendKeysObserver = {
        execute: async (options) =>
          options?.minTimestamp === 0 ? afterObservation : beforeObservation,
      };
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        observer,
        { textClient: client, timer: new FakeTimer() },
      );
      const sendKeys = new SendKeys(androidDevice, undefined, {
        executor,
        observer,
        timer: new FakeTimer(),
        timestampProvider: { now: async () => 0 },
      });

      expect(
        await sendKeys.execute([
          { action: "type", text: "zz", operation: "replace", mode: "eventOnly" },
        ]),
      ).toMatchObject({ success: true });
      expect(adb.getExecutedCommands()).toEqual([
        "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A",
        "shell input keyevent KEYCODE_DEL",
        "shell input keyevent KEYCODE_Z",
        "shell input keyevent KEYCODE_Z",
      ]);
      expect(calls).toEqual([]);
    },
  );

  test.each(["first\nlater\nlines", "abc", undefined])(
    "eventOnly replace types after clearing to an absent Compose-style value (before=%j)",
    async (before) => {
      const adb = new FakeAdbExecutor();
      adb.setAndroidApiLevel(34);
      const { client, calls } = createTextClient();
      const observer: SendKeysObserver = {
        execute: async (options) =>
          focusedAndroidObservation(
            "",
            { text: options?.minTimestamp === 0 ? undefined : before },
            0,
          ),
      };
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        observer,
        { textClient: client, timer: new FakeTimer() },
      );
      const sendKeys = new SendKeys(androidDevice, undefined, {
        executor,
        observer,
        timer: new FakeTimer(),
        timestampProvider: { now: async () => 0 },
      });

      expect(
        await sendKeys.execute([
          { action: "type", text: "zz", operation: "replace", mode: "eventOnly" },
        ]),
      ).toMatchObject({ success: true });
      expect(adb.getExecutedCommands()).toEqual([
        "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A",
        "shell input keyevent KEYCODE_DEL",
        "shell input keyevent KEYCODE_Z",
        "shell input keyevent KEYCODE_Z",
      ]);
      expect(calls).toEqual([]);
    },
  );

  test.each([false, true])(
    "eventOnly replace refuses an absent password value (absentBefore=%s)",
    async (absentBefore) => {
      const adb = new FakeAdbExecutor();
      adb.setAndroidApiLevel(34);
      const { client, calls } = createTextClient();
      const observer: SendKeysObserver = {
        execute: async (options) =>
          focusedAndroidObservation(
            "",
            {
              text: absentBefore || options?.minTimestamp === 0 ? undefined : "•••",
              password: "true",
            },
            0,
          ),
      };
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        observer,
        { textClient: client, timer: new FakeTimer() },
      );

      expect(
        await executor.type({
          action: "type",
          text: "zz",
          operation: "replace",
          mode: "eventOnly",
        }),
      ).toMatchObject({
        success: false,
        error: absentBefore
          ? "eventOnly replacement requires a known focused text length; use a11y replacement instead"
          : "Cannot verify key-event clear: focused field text length is unreadable",
      });
      expect(adb.getExecutedCommands()).toEqual(
        absentBefore
          ? []
          : [
              "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A",
              "shell input keyevent KEYCODE_DEL",
            ],
      );
      expect(calls).toEqual([]);
    },
  );

  test.each(["replace", "clear"] as const)(
    "verifies Android key-event %s before reporting success or typing",
    async (operation) => {
      for (const after of ["later\nlines", "", undefined]) {
        const adb = new FakeAdbExecutor();
        adb.setAndroidApiLevel(34);
        const { client, calls } = createTextClient();
        client.clear = async () => ({ success: false, error: "accessibility unavailable" });
        let reads = 0;
        const options: Array<Parameters<SendKeysObserver["execute"]>[0]> = [];
        const observer: SendKeysObserver = {
          execute: async (request) => {
            options.push(request);
            if (++reads === 1) {
              return focusedAndroidObservation("first\nlater\nlines", {}, 0);
            }
            return after === undefined ? { timestamp: 0 } : focusedAndroidObservation(after, {}, 0);
          },
        };
        const executor = new DefaultSendKeysCommandExecutor(
          androidDevice,
          createAdbFactory(adb),
          observer,
          { textClient: client, timer: new FakeTimer() },
        );
        const result =
          operation === "clear"
            ? await executor.clear()
            : await executor.type({
                action: "type",
                text: "a",
                operation: "replace",
                mode: "eventOnly",
              });
        expect(result.success).toBe(after === "");
        if (after === "later\nlines") {
          expect(result).toMatchObject({ success: false, partialApplication: true });
          expect(result.error).toContain("not fully cleared");
          expect(result.error).toContain("11 UTF-16 units remain");
        }
        if (after === undefined) {
          expect(result).toMatchObject({ success: false, partialApplication: true });
          expect(result.error).toContain("Cannot verify");
        }
        expect(options).toHaveLength(2);
        expect(options[1]).toMatchObject({ freshness: "fresh" });
        expect(adb.getExecutedCommands().includes("shell input keyevent KEYCODE_A")).toBe(
          operation === "replace" && after === "",
        );
        expect(adb.getExecutedCommands()).toEqual([
          "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A",
          "shell input keyevent KEYCODE_DEL",
          ...(operation === "replace" && after === "" ? ["shell input keyevent KEYCODE_A"] : []),
        ]);
        expect(calls).toEqual([]);
      }
    },
  );

  test.each([31, 34, 30, null])(
    "eventOnly replace resolves API %s once across repeated clears",
    async (apiLevel) => {
      const adb = new FakeAdbExecutor();
      adb.setAndroidApiLevel(apiLevel);
      let reads = 0;
      const observer: SendKeysObserver = {
        execute: async () => focusedAndroidObservation(++reads % 2 === 1 ? "old\ntext" : "", {}, 0),
      };
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        observer,
        { textClient: createTextClient().client, timer: new FakeTimer() },
      );
      const controller = new AbortController();
      for (let clear = 0; clear < 2; clear++) {
        expect(
          await executor.type(
            { action: "type", text: "a", operation: "replace", mode: "eventOnly" },
            controller.signal,
          ),
        ).toMatchObject({ success: true });
      }
      const clearSequence =
        apiLevel !== null && apiLevel >= 31
          ? [
              "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A",
              "shell input keyevent KEYCODE_DEL",
            ]
          : [
              "shell input keyevent KEYCODE_MOVE_END",
              `shell input keyevent ${Array<string>(8).fill("KEYCODE_DEL").join(" ")}`,
            ];
      const sequence = [...clearSequence, "shell input keyevent KEYCODE_A"];
      expect(adb.getExecutedCommands()).toEqual([
        ...(apiLevel === null ? ["shell getprop ro.build.version.sdk"] : []),
        ...sequence,
        ...sequence,
      ]);
      expect(adb.getApiLevelCalls()).toEqual([{ timeoutMs: 1000, signal: undefined }]);
    },
  );

  test("first caller abort does not cancel a concurrent clear's shared capability probe", async () => {
    const adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(34);
    let releaseProbe!: () => void;
    const probePending = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const readApiLevel = adb.getAndroidApiLevel.bind(adb);
    adb.getAndroidApiLevel = async (...options) => {
      const level = await readApiLevel(...options);
      probeStarted();
      await probePending;
      return level;
    };
    const textClient = createTextClient().client;
    textClient.clear = async () => ({ success: false, error: "accessibility unavailable" });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      {
        execute: async () =>
          focusedAndroidObservation(
            adb.getExecutedCommands().some((command) => command.includes("KEYCODE_DEL"))
              ? ""
              : "old",
            {},
            0,
          ),
      },
      { textClient, timer: new FakeTimer() },
    );
    const controller = new AbortController();
    const first = executor.clear(controller.signal);
    const second = Promise.allSettled([executor.clear(new AbortController().signal)]);
    await started;
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(adb.getExecutedCommands()).toEqual([]);
    releaseProbe();
    expect(await second).toMatchObject([{ status: "fulfilled", value: { success: true } }]);
    expect(adb.getApiLevelCalls()).toEqual([{ timeoutMs: 1000, signal: undefined }]);
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A",
      "shell input keyevent KEYCODE_DEL",
    ]);
  });

  test("standalone Android clear falls back to ADB deletes after accessibility failure", async () => {
    const adb = new FakeAdbExecutor();
    adb.setAndroidApiLevel(30);
    const textClient = createTextClient().client;
    textClient.clear = async () => ({ success: false, error: "accessibility unavailable" });
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      {
        execute: async () =>
          focusedAndroidObservation(
            adb.getExecutedCommands().some((command) => command.includes("KEYCODE_DEL"))
              ? ""
              : "old",
            {},
            0,
          ),
      },
      { textClient },
    );

    expect(await executor.clear()).toMatchObject({ success: true });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keyevent KEYCODE_MOVE_END",
      "shell input keyevent KEYCODE_DEL KEYCODE_DEL KEYCODE_DEL",
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
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
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
        { textClient: textClient.client, timer },
      );

      const result = await executor.type({ action: "type", text, operation });

      expect(result.resolvedMode).toBe("ime");
      expect(textClient.commitViaImeCalls).toEqual([{ text, priorImeId }]);
      expect(
        adb.getExecutedCommands().every((command) => !command.startsWith("shell input keyevent")),
      ).toBe(true);
    }
  });

  test("auto IME falls back when an old APK advertises commit but no cancellation", async () => {
    for (const [operation, mode] of [
      ["insert", "eventAll"],
      ["replace", "a11y"],
    ] as const) {
      const adb = new FakeAdbExecutor();
      const timer = new FakeTimer();
      const device = { ...androidDevice, deviceId: `old-apk-no-cancel-${operation}` };
      const client = AndroidCtrlProxyClient.createForTesting(
        device,
        adb,
        (url) => new FakeWebSocket(url, "none", 0, timer),
        timer,
      );
      const capabilities: string[] = [];
      const calls: string[] = [];
      client.supportsCommand = async (command) => {
        capabilities.push(command);
        return command === "request_commit_text";
      };
      client.requestSetText = async (text) => {
        calls.push(`replace:${text}`);
        return { success: true };
      };
      client.requestInsertText = async (text) => {
        calls.push(`insert:${text}`);
        return { success: true };
      };
      client.requestInsertTextState = async () => ({ success: false });
      client.commitViaIme = async () => {
        calls.push("commit");
        return { success: true };
      };
      AndroidCtrlProxyClient.registerForTesting(client, device.deviceId);
      const executor = new DefaultSendKeysCommandExecutor(
        device,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation()),
        { timer },
      );
      try {
        const result = await executor.type({ action: "type", text: "note `x`", operation });
        expect(capabilities).toContain("request_commit_text");
        expect(capabilities).toContain("request_cancel_ime_commit");

        expect(result).toMatchObject({ success: true, resolvedMode: mode });
        expect(result.backend).toBeUndefined();
        expect(calls).not.toContain("commit");
        if (mode === "eventAll") {
          expect(adb.getExecutedCommands().length).toBeGreaterThan(0);
        } else {
          expect(calls).toContain("replace:note `x`");
        }
      } finally {
        await client.close();
        AndroidCtrlProxyClient.removeInstanceIfCurrent(device.deviceId, client);
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
      createObserver(focusedAndroidObservation("a😀")),
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

  test.each([
    ["5551234567", "(555) 123-4567", true, false, "ime", "insert"],
    ["5551234567", "(555) 123-45", false, false, "ime", "insert"],
    ["5551234567", "5551234567", true, false, "ime", "insert"],
    ["5551234567", "", false, false, "ime", "insert"],
    ["5551234567", "••••••••••", true, true, "ime", "insert"],
    ["5551234567", null, true, false, "ime", "insert"],
    ["5551234567", "(555) 123-4567", true, false, "auto", "insert"],
    ["5551234567", "(555) 123-45", false, false, "auto", "insert"],
    ["5551234567", "(555) 123-4567", true, false, "ime", "replace"],
    ["5551234567", "(555) 123-45", false, false, "ime", "replace"],
    ["5551234567", "(555) 123-4567", true, false, "auto", "replace"],
    ["5551234567", "(555) 123-45", false, false, "auto", "replace"],
    ["abc", "ABC", true, false, "ime", "insert"],
    ["555-0142", "5550142", true, false, "ime", "insert"],
    ["5550142", "555-0", false, false, "ime", "insert"],
    ["hello", "helo", false, false, "ime", "insert"],
    ["HeLLo", "HELO", false, false, "ime", "insert"],
  ] as const)(
    "checks plain IME read-back: sent=%s field=%s success=%s secure=%s mode=%s operation=%s",
    async (text, fieldText, success, secure, mode, operation) => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: priorImeId, stderr: "" },
        { stdout: commitImeId, stderr: "" },
      ]);
      const observer = createObserver(
        fieldText === null
          ? ({ timestamp: timer.now() } as ObserveResult)
          : focusedAndroidObservation(fieldText, secure ? { password: "true" } : {}, timer.now()),
      );
      const textClient = createTextClient({
        commitViaIme: async () => ({ success: true, committedUnits: Array.from(text).length }),
      });
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        observer,
        { textClient: textClient.client, timer },
      );

      const result = await executor.type({ action: "type", text, mode, operation });

      expect(result).toMatchObject({
        success,
        resolvedMode: "ime",
        textLength: Array.from(text).length,
        committedUnits: Array.from(text).length,
      });
      expect(result.partialApplication).toBe(success ? undefined : true);
      if (!success) {
        expect(result.error).toContain(`IME partial commit: sent "${text}"`);
        expect(result.error).toContain(`the focused field holds "${fieldText}"`);
      }
      // Auto also observes once before typing to choose password-safe delivery.
      expect(observer.calls).toBe((mode === "auto" ? 1 : 0) + (success ? 1 : 3));
      expect(observer.options.at(-1)).toEqual({ signal: undefined, freshness: "fresh" });
      expect(textClient.commitViaImeCalls).toEqual([{ text, priorImeId }]);
      expect(textClient.calls.includes("clear")).toBe(operation === "replace");
      expect(
        adb.getExecutedCommands().some((command) => command.startsWith("shell input keyevent")),
      ).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("skips plain IME read-back for empty text", async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const observer = createObserver(focusedAndroidObservation("existing", {}, timer.now()));
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      observer,
      { textClient: textClient.client },
    );

    expect(await executor.type({ action: "type", text: "", mode: "ime" })).toMatchObject({
      success: true,
    });
    expect(observer.calls).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each([
    ["prefix one *bold* two `code` tail", true, false],
    ["prefix one bold two code tail", true, false],
    ["prefix one bold two `code` tail", true, false],
    ["prefix one *bold* two `code` tai", false, false],
    ["prefix one bold two `code` tai", false, false],
    ["prefix one bold two code tai", false, false],
    ["", true, true],
    [null, true, false],
  ])("checks multi-span IME suffix when readable: %s", async (fieldText, success, secure) => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const text = "one *bold* two `code` tail";
    const adb = new FakeAdbExecutor();
    adb.setCommandResponseSequence("shell settings get secure default_input_method", [
      { stdout: priorImeId, stderr: "" },
      { stdout: commitImeId, stderr: "" },
    ]);
    const observer = createObserver(
      fieldText === null
        ? ({ timestamp: timer.now() } as ObserveResult)
        : focusedAndroidObservation(fieldText, secure ? { password: "true" } : {}, timer.now()),
    );
    const textClient = createTextClient();
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      observer,
      { textClient: textClient.client, timer },
    );

    const result = await executor.type({ action: "type", text, mode: "ime" });
    expect(result.success).toBe(success);
    expect(result.partialApplication).toBe(success ? undefined : true);
    if (!success) {
      expect(result.error).toContain("IME partial commit");
    }
    expect(observer.options).toContainEqual({ signal: undefined, freshness: "fresh" });
    expect(textClient.commitViaImeCalls).toEqual([{ text, priorImeId }]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["```", "``````"])(
    "skips IME suffix verification for marker-only text: %s",
    async (text) => {
      const timer = new FakeTimer();
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: priorImeId, stderr: "" },
        { stdout: commitImeId, stderr: "" },
      ]);
      const textClient = createTextClient();
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(focusedAndroidObservation("prefix", {}, timer.now())),
        { textClient: textClient.client },
      );

      const result = await executor.type({ action: "type", text, mode: "ime" });
      expect(result.success).toBe(true);
      expect(result.partialApplication).toBeUndefined();
      expect(textClient.commitViaImeCalls).toEqual([{ text, priorImeId }]);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

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
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
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
      expect(
        loggerCallsWithPrefix(warning.mock.calls, "[SendKeys] IME restoration failed:"),
      ).toEqual([
        [expect.stringContaining("Could not restore the original keyboard"), expect.any(Error)],
        [expect.stringContaining("Could not restore the original keyboard"), expect.any(Error)],
      ]);
    } finally {
      warning.mockRestore();
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
      createObserver(focusedAndroidObservation("value", {}, 0)),
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
      createObserver(focusedAndroidObservation("value", {}, 0)),
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
      createObserver(focusedAndroidObservation("value", {}, 0)),
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
      createObserver(focusedAndroidObservation("value", {}, 0)),
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

  test.each([undefined, 0, 2])(
    "IME failure reports only device-provided nonzero units: %s",
    async (committedUnits) => {
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: priorImeId, stderr: "" },
        { stdout: commitImeId, stderr: "" },
      ]);
      const textClient = createTextClient({
        commitViaIme: async () => ({
          success: false,
          partialApplication: true,
          error: "commit stopped",
          committedUnits,
        }),
      });
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(),
        { textClient: textClient.client },
      );
      const result = await executor.type({ action: "type", text: "👨‍👩‍👧value", mode: "ime" });
      expect(result.error).toBe(
        committedUnits
          ? "commit stopped; up to 2 editing units were dispatched before the commit stopped"
          : "commit stopped",
      );
      expect(result.committedUnits).toBe(committedUnits || undefined);
    },
  );

  test.each(["timeout", "abort"])(
    "IME restore waits until outstanding %s commit settles",
    async (outcome) => {
      const timer = new FakeTimer();
      const adb = new FakeAdbExecutor();
      adb.setCommandResponseSequence("shell settings get secure default_input_method", [
        { stdout: priorImeId, stderr: "" },
        { stdout: commitImeId, stderr: "" },
      ]);
      const controller = new AbortController();
      let started!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        started = resolve;
      });
      let outstanding = true;
      let restoredWhileOutstanding = false;
      const execute = adb.executeCommand.bind(adb);
      adb.executeCommand = async (command, ...options) => {
        if (command === `shell ime set ${priorImeId}`) {
          restoredWhileOutstanding ||= outstanding;
        }
        return execute(command, ...options);
      };
      const textClient = createTextClient({
        commitViaIme: async () => {
          started();
          await timer.sleep(2_000);
          outstanding = false;
          return { success: false, partialApplication: true, error: outcome };
        },
      });
      const executor = new DefaultSendKeysCommandExecutor(
        androidDevice,
        createAdbFactory(adb),
        createObserver(),
        { textClient: textClient.client, timer },
      );
      const pending = executor.type(
        { action: "type", text: "value", mode: "ime" },
        controller.signal,
      );
      await dispatched;
      if (outcome === "abort") {
        controller.abort();
      }
      timer.advanceTime(1_999);
      await Promise.resolve();
      expect(adb.getExecutedCommands()).not.toContain(`shell ime set ${priorImeId}`);
      timer.advanceTime(1);
      expect(await pending).toMatchObject({ success: false, partialApplication: true });
      expect(adb.getExecutedCommands()).toContain(`shell ime set ${priorImeId}`);
      expect(restoredWhileOutstanding).toBe(false);
    },
  );

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
      createObserver(focusedAndroidObservation("value", {}, 0)),
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
        await Promise.resolve();
      }
      throw new Error("First IME commit was not reached within 200 microtask turns");
    };

    const first = makeExecutor().type({ action: "type", text: "first", mode: "ime" });
    // Call 1 holds the per-device lock and parks at its commit.
    await waitFor(() => events.includes("commit:first"));
    const snapshotAtBlock = [...events];

    const second = makeExecutor().type({ action: "type", text: "second", mode: "ime" });
    // Both executors use promise-only fakes. Drain the same budget that reached
    // call 1: without the lock, call 2 must reach capture/commit within it.
    for (let i = 0; i < 200; i++) {
      await Promise.resolve();
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
      committedGraphemes: 1,
      error: expect.stringContaining("U+1F642"),
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
      committedGraphemes: 1,
      error: expect.stringContaining("U+0062"),
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
      {
        execute: async () =>
          focusedAndroidObservation(
            adb.getExecutedCommands().some((command) => command.includes("KEYCODE_DEL"))
              ? ""
              : "old",
          ),
      },
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
    adb.setAndroidApiLevel(30);
    const executeCommand = adb.executeCommand.bind(adb);
    let deleteChunkCount = 0;
    adb.executeCommand = async (command, ...options) => {
      if (command.includes("KEYCODE_DEL") && ++deleteChunkCount === 2) {
        throw new Error("delete rejected");
      }
      return executeCommand(command, ...options);
    };
    const executor = new DefaultSendKeysCommandExecutor(
      androidDevice,
      createAdbFactory(adb),
      createObserver(focusedAndroidObservation("x".repeat(DELETE_KEYEVENT_CHUNK_SIZE + 1))),
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
      `shell input keyevent ${Array<string>(DELETE_KEYEVENT_CHUNK_SIZE).fill("KEYCODE_DEL").join(" ")}`,
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
        error: typeFocusedInputError,
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

test("type copies a11y insert warnings into command results and sendKeys joins them", async () => {
  const h = createSendKeysHarness(android);
  h.client.insert = async () => ({ success: true, warning: "caret warning" });
  const sendKeys = new SendKeys(android, undefined, {
    executor: h.executor,
    observer: harnessObserver,
    timestampProvider: { now: async () => 0 },
  });
  const result = await sendKeys.execute([
    { action: "type", text: "👍🏽", mode: "a11y" },
    { action: "type", text: "é", mode: "a11y" },
  ]);
  expect(result).toMatchObject({
    success: true,
    warning: "caret warning caret warning",
    commands: [
      { success: true, warning: "caret warning" },
      { success: true, warning: "caret warning" },
    ],
  });
});

test("sendKeys retains warnings from the failed command and preceding successful commands", async () => {
  const h = createSendKeysHarness(android);
  let calls = 0;
  h.client.insert = async () =>
    ++calls === 1
      ? { success: true, warning: "earlier warning" }
      : { success: false, warning: "failed command warning", error: "write failed" };
  const sendKeys = new SendKeys(android, undefined, {
    executor: h.executor,
    observer: harnessObserver,
    timestampProvider: { now: async () => 0 },
  });
  expect(
    await sendKeys.execute([
      { action: "type", text: "é", mode: "a11y" },
      { action: "type", text: "👍🏽", mode: "a11y" },
    ]),
  ).toMatchObject({
    success: false,
    warning: "earlier warning failed command warning",
    error: "write failed",
    commands: [
      { warning: "earlier warning" },
      { success: false, warning: "failed command warning" },
    ],
  });
});

test("sendKeys preflights every raw modifier array and the command count before keys", async () => {
  const h = createSendKeysHarness(android);
  const press = mock(async () => ({ success: true }));
  const executor = new DefaultSendKeysCommandExecutor(
    android,
    createAdbFactory(h.adb),
    harnessObserver,
    { textClient: h.client, inputKey: { press } },
  );
  const action = new SendKeys(android, undefined, {
    executor,
    observer: harnessObserver,
    timestampProvider: { now: async () => 0 },
    timer: new FakeTimer(),
  });
  const key = { action: "key", key: "tab" } as const;
  await expect(
    action.execute(Array.from({ length: SEND_KEYS_MAX_COMMANDS + 1 }, () => key)),
  ).rejects.toThrow(ActionableError);
  expect(press).toHaveBeenCalledTimes(0);
  for (const semanticKey of ["tab", "done"] as const) {
    await expect(
      action.execute([
        key,
        { action: "key", key: semanticKey, modifiers: ["shift", "ctrl", "alt", "meta", "shift"] },
      ]),
    ).rejects.toThrow(`${SEND_KEYS_MAX_MODIFIERS}`);
    expect(press).toHaveBeenCalledTimes(0);
  }
  await expect(
    action.execute([
      key,
      {
        action: "key",
        key: "tab",
        modifiers: [
          "shift",
          "ctrl",
          "alt",
          "meta",
          // @ts-expect-error Exercise a direct runtime caller with five distinct modifiers.
          "super",
        ],
      },
    ]),
  ).rejects.toThrow(ActionableError);
  expect(press).toHaveBeenCalledTimes(0);
  const result = await action.execute(
    Array.from({ length: SEND_KEYS_MAX_COMMANDS }, () => ({
      ...key,
      modifiers: ["shift", "ctrl", "alt", "meta"],
    })),
  );
  expect(result.success).toBe(true);
  expect(press).toHaveBeenCalledTimes(SEND_KEYS_MAX_COMMANDS);
});

describe("SendKeys IME focus regression", () => {
  test("IME-occluded Android selector focus keeps the SendKeys failure shape", async () => {
    const device = androidDevice;
    const hierarchy = imeOcclusionHierarchy();
    const element = new DefaultElementParser()
      .flattenViewHierarchy(hierarchy, { includeWindows: true })
      .find(({ element }) => element.text === "Continue as Guest")!.element;
    element.class = "android.widget.EditText";
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    const tap = new TapOnElement(device, adb, {
      timer,
      elementSelector: new FakeElementSelector(element),
      tapStrategy: new FakeTapStrategy(),
      selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
    });
    const observation: ObserveResult = {
      observationId: "occluded-focus",
      updatedAt: 1,
      screenSize: { width: 400, height: 240 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy: hierarchy,
    };
    tap.observedInteraction = async (action) => ({ ...(await action(observation)), observation });
    const error =
      'Failed to perform tap on element: Target "Continue as Guest" is covered by the soft keyboard; dismiss the keyboard first.';
    const executor = createSendKeysHarness(device).executor;
    const sendKeys = new SendKeys(
      device,
      { create: () => adb },
      {
        timer,
        executor,
        observer: { execute: async () => observation },
        timestampProvider: { now: async () => 1 },
        focuser: {
          focus: async (selector, signal, display, options) => {
            const result = await tap.execute(
              { ...selector, ...options, action: "focus", display },
              undefined,
              signal,
            );
            return { success: result.success, error: result.error };
          },
        },
      },
    );
    expect(
      await sendKeys.execute([{ action: "key", key: "ENTER" }], { text: "Continue as Guest" }),
    ).toEqual({
      success: false,
      completedCommands: 0,
      failedIndex: 0,
      commands: [],
      observation,
      error,
    });
    expect(adb.getExecutedCommands()).toEqual([]);
  });
});

describe("SendKeys post-action capture boundary", () => {
  class CapturingFocus extends BaseVisualChange {
    protected override shouldCapturePostActionScreenshot(): boolean {
      return true;
    }
  }

  function captureHarness(device: BootedDevice) {
    const h = createSendKeysHarness(device);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const events: string[] = [];
    const before: ObserveResult = {
      ...focusedAndroidObservation("", {}, 0),
      screenSize: { width: 100, height: 100 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      deviceId: device.deviceId,
      observationId: "focused-before-command",
    };
    const after: ObserveResult = { ...before, observationId: "after-command" };
    const observe = new FakeObserveScreen();
    observe.setObserveResult(before);
    const focus = new CapturingFocus(device, h.adb, timer);
    focus.observeScreen = observe;
    focus.window = new FakeWindow();
    const capture = spyOn(observe, "captureScreenshot").mockImplementation(
      async (_perf, _signal, chosen) => {
        events.push(`capture:start:${chosen?.observationId}`);
        await Promise.resolve();
        events.push(`capture:end:${chosen?.observationId}`);
      },
    );
    const insert = h.client.insert;
    h.client.insert = async (...args) => {
      events.push("dispatch");
      return insert(...args);
    };
    const sendKeys = new SendKeys(
      device,
      { create: () => h.adb },
      {
        executor: new DefaultSendKeysCommandExecutor(
          device,
          { create: () => h.adb },
          harnessObserver,
          {
            textClient: h.client,
            inputKey: { press: async () => ({ success: true }) },
            timer,
          },
        ),
        timer,
        timestampProvider: { now: async () => timer.now() },
        focuser: {
          focus: async () => {
            const result = await focus.observedInteraction(
              async () => ({ success: true, focusVerified: true }),
              { previousObservation: before, changeExpected: false, skipUiStability: true },
            );
            expect(hasPendingTerminalScreenshot(result.observation)).toBe(true);
            expect(capture).not.toHaveBeenCalled();
            return { success: true, focusVerified: true };
          },
        },
        observer: {
          execute: async () => {
            // Model the final ObserveScreen read's own automatic screenshot.
            await observe.captureScreenshot(undefined, undefined, after);
            return after;
          },
        },
      },
    );
    return { sendKeys, events, capture, before, after };
  }

  test.each([androidDevice, iosDevice])(
    "$platform captures the earlier observed focus before command dispatch",
    async (device) => {
      const h = captureHarness(device);
      try {
        const result = await runWithPostActionCaptureScope(undefined, () =>
          h.sendKeys.execute([{ action: "type", text: "hello", mode: "a11y" }], { text: "Name" }),
        );
        expect(result.success).toBe(true);
        expect(result.observation).toBe(h.after);
        expect(h.events).toEqual([
          "capture:start:focused-before-command",
          "capture:end:focused-before-command",
          "dispatch",
          "capture:start:after-command",
          "capture:end:after-command",
        ]);
        expect(h.capture).toHaveBeenCalledTimes(2);
        expect(h.capture.mock.calls[0][2]).toBe(h.before);
      } finally {
        h.capture.mockRestore();
      }
    },
  );

  test("a single sendKeys action without earlier focus captures exactly once", async () => {
    const h = captureHarness(androidDevice);
    try {
      const result = await runWithPostActionCaptureScope(undefined, () =>
        h.sendKeys.execute([{ action: "type", text: "hello", mode: "a11y" }]),
      );
      expect(result.success).toBe(true);
      expect(result.observation).toBe(h.after);
      expect(h.events).toEqual([
        "dispatch",
        "capture:start:after-command",
        "capture:end:after-command",
      ]);
      expect(h.capture).toHaveBeenCalledTimes(1);
    } finally {
      h.capture.mockRestore();
    }
  });
});

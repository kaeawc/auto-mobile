import { afterEach, describe, expect, test } from "bun:test";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import {
  SendKeys,
  type SendKeysCommand,
  type SendKeysCommandExecutor,
  type SendKeysCommandResult,
  type SendKeysKeyboard,
} from "../../../src/features/action/SendKeys";
import { serverConfig } from "../../../src/utils/ServerConfig";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeDisplayTransitionReader } from "../../fakes/FakeDisplayTransitionReader";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, focused, ios } from "./SendKeysTestHarness";

/**
 * Issue #10221: `--dismiss-keyboard-after-input` / `automobile.daemon.dismiss.keyboard.after.input`
 * dismissed the soft keyboard after every `inputText` until the tool was folded into `sendKeys`
 * (#7457), which never consulted it. A successful text entry closes the keyboard again, best
 * effort and through the existing keyboard-close path.
 */
const typeCommand: SendKeysCommand = { action: "type", text: "hello", mode: "a11y" };

type CloseReply = { success: boolean; error?: string } | Error;

function setup(
  options: {
    enabled?: boolean;
    type?: () => Promise<SendKeysCommandResult>;
    close?: CloseReply;
    device?: BootedDevice;
    keyFails?: boolean;
    onClose?: () => void;
  } = {},
) {
  const events: string[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  const executor: SendKeysCommandExecutor = {
    type: async () => {
      events.push("type");
      return options.type
        ? options.type()
        : { index: -1, action: "type", success: true, textLength: 5 };
    },
    key: async (command) => {
      events.push(`key:${command.key}`);
      return {
        index: -1,
        action: "key",
        key: command.key,
        success: !options.keyFails,
        ...(options.keyFails ? { error: "blocked" } : {}),
      };
    },
    clear: async () => {
      events.push("clear");
      return { success: true };
    },
  };
  const keyboard: SendKeysKeyboard = {
    execute: async (_action, signal) => {
      events.push("close");
      signals.push(signal);
      options.onClose?.();
      const reply = options.close ?? { success: true };
      if (reply instanceof Error) {
        throw reply;
      }
      return reply;
    },
  };
  const device = options.device ?? android;
  const sendKeys = new SendKeys(device, undefined, {
    executor,
    keyboard,
    observer: {
      execute: async () => {
        events.push("observe");
        return focused;
      },
    },
    timer: new FakeTimer(),
    timestampProvider: { now: async () => 0 },
    dismissKeyboardAfterInput: () => options.enabled ?? true,
  });
  return { sendKeys, events, signals };
}

describe("sendKeys dismiss keyboard after input (#10221)", () => {
  test("closes the keyboard once after a successful entry, before the final observation", async () => {
    const h = setup();
    const result = await h.sendKeys.execute([typeCommand]);
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(h.events).toEqual(["type", "close", "observe"]);
  });

  test("closes once for a multi-command sequence, after its last command", async () => {
    const h = setup();
    const result = await h.sendKeys.execute([
      typeCommand,
      { action: "key", key: "tab" },
      typeCommand,
    ]);
    expect(result.success).toBe(true);
    expect(h.events).toEqual(["type", "key:tab", "type", "close", "observe"]);
  });

  test("does nothing when the option is off", async () => {
    const h = setup({ enabled: false });
    expect((await h.sendKeys.execute([typeCommand])).success).toBe(true);
    expect(h.events).toEqual(["type", "observe"]);
  });

  test("does nothing when no command entered text", async () => {
    const h = setup();
    const result = await h.sendKeys.execute([{ action: "key", key: "done" }, { action: "clear" }]);
    expect(result.success).toBe(true);
    expect(h.events).toEqual(["key:done", "clear", "observe"]);
  });

  test("does nothing when the entry failed", async () => {
    const h = setup({
      type: async () => ({ index: -1, action: "type", success: false, error: "typing failed" }),
    });
    const result = await h.sendKeys.execute([typeCommand]);
    expect(result.success).toBe(false);
    expect(h.events).toEqual(["type", "observe"]);
  });

  test("does nothing when a later command failed after a successful entry", async () => {
    const h = setup({ keyFails: true });
    const result = await h.sendKeys.execute([typeCommand, { action: "key", key: "done" }]);
    expect(result.success).toBe(false);
    expect(h.events).toEqual(["type", "key:done", "observe"]);
  });

  test("does nothing when the entry outcome is indeterminate", async () => {
    const h = setup({
      type: async () => ({
        index: -1,
        action: "type",
        success: false,
        retryable: false,
        error: "outcome is indeterminate",
      }),
    });
    const result = await h.sendKeys.execute([typeCommand]);
    expect(result).toMatchObject({ success: false, retryable: false });
    expect(h.events).toEqual(["type"]);
  });

  test("a refused close keeps the entry successful and adds a warning", async () => {
    const h = setup({ close: { success: false, error: "keyboard still open" } });
    const result = await h.sendKeys.execute([typeCommand]);
    expect(result.success).toBe(true);
    expect(result.completedCommands).toBe(1);
    expect(result.warning).toContain("keyboard dismissal failed: keyboard still open");
    expect(result.commands[0]?.warning).toContain("keyboard dismissal failed");
    expect(h.events).toEqual(["type", "close", "observe"]);
  });

  test("a throwing close keeps the entry successful and adds a warning", async () => {
    const h = setup({ close: new Error("hierarchy read failed") });
    const result = await h.sendKeys.execute([typeCommand]);
    expect(result.success).toBe(true);
    expect(result.warning).toContain("keyboard dismissal failed: hierarchy read failed");
  });

  test("an existing command warning is kept next to the dismissal warning", async () => {
    const h = setup({
      type: async () => ({ index: -1, action: "type", success: true, warning: "caret moved" }),
      close: { success: false, error: "no luck" },
    });
    const result = await h.sendKeys.execute([typeCommand]);
    expect(result.warning).toContain("caret moved");
    expect(result.warning).toContain("keyboard dismissal failed: no luck");
  });

  test("an abort during the close is not swallowed as a warning", async () => {
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const h = setup({
      close: reason,
      onClose: () => controller.abort(reason),
    });
    await expect(
      h.sendKeys.execute([typeCommand], undefined, undefined, controller.signal),
    ).rejects.toBe(reason);
  });

  test("passes the request signal to the keyboard close", async () => {
    const controller = new AbortController();
    const h = setup();
    await h.sendKeys.execute([typeCommand], undefined, undefined, controller.signal);
    expect(h.signals).toEqual([controller.signal]);
  });

  test("is Android-only: iOS never closes the keyboard", async () => {
    const h = setup({ device: ios });
    const result = await h.sendKeys.execute([typeCommand]);
    expect(result.success).toBe(true);
    expect(h.events).not.toContain("close");
  });
});

describe("sendKeys dismiss keyboard on an explicitly routed display (#10221)", () => {
  test("skips the ambient-display close and says so", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("cmd display get-displays", {
      stdout: 'Display id 0: DisplayInfo{uniqueId "local:inside" type INTERNAL, real 100 x 100}',
      stderr: "",
    });
    const transitions = new FakeDisplayTransitionReader();
    const observation: ObserveResult = {
      ...focused,
      display: {
        key: "0",
        role: "unknown",
        posture: "unknown",
        generation: transitions.generation,
      },
      displayRevision: transitions.fullRevision,
      viewHierarchy: { ...focused.viewHierarchy!, displayId: 0 },
    };
    const observer = new FakeObserveScreen();
    observer.setObserveResult(observation);
    const closes: string[] = [];
    const sendKeys = new SendKeys(android, new FakeAdbClientFactory(adb), {
      timer: new FakeTimer(),
      executor: {
        type: async () => ({ index: -1, action: "type", success: true }),
        key: async (command) => ({ index: -1, action: "key", key: command.key, success: true }),
        clear: async () => ({ success: true }),
      },
      keyboard: {
        execute: async () => {
          closes.push("close");
          return { success: true };
        },
      },
      observer,
      displayTransitions: transitions,
      lastRenderedObservation: () => observation,
      timestampProvider: { now: async () => 1 },
      dismissKeyboardAfterInput: () => true,
    });
    const result = await sendKeys.execute([typeCommand], undefined, undefined, undefined, "0");
    expect(result.success).toBe(true);
    expect(closes).toEqual([]);
    expect(result.warning).toContain("explicitly routed display");
  });
});

describe("sendKeys default dismiss-keyboard source (#10221)", () => {
  afterEach(() => serverConfig.setDismissKeyboardAfterInputEnabled(false));

  test.each([true, false])("reads the server option by default (enabled=%s)", async (enabled) => {
    serverConfig.setDismissKeyboardAfterInputEnabled(enabled);
    const events: string[] = [];
    const sendKeys = new SendKeys(android, undefined, {
      executor: {
        type: async () => ({ index: -1, action: "type", success: true }),
        key: async (command) => ({ index: -1, action: "key", key: command.key, success: true }),
        clear: async () => ({ success: true }),
      },
      keyboard: {
        execute: async () => {
          events.push("close");
          return { success: true };
        },
      },
      observer: { execute: async () => focused },
      timer: new FakeTimer(),
      timestampProvider: { now: async () => 0 },
    });
    expect((await sendKeys.execute([typeCommand])).success).toBe(true);
    expect(events).toEqual(enabled ? ["close"] : []);
  });
});

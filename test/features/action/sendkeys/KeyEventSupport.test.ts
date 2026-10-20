import { createExecResult } from "../../../../src/utils/execResult";
import { describe, expect, test } from "bun:test";
import {
  KeyEventSupport,
  type KeyEventSupportHost,
} from "../../../../src/features/action/sendkeys/KeyEventSupport";
import {
  INPUT_TEXT_HOST_WAIT_PER_CHAR_MS,
  INPUT_TEXT_SETTLEMENT_BASE_MS,
} from "../../../../src/utils/android-cmdline-tools/AndroidInputText";
import { TypingSession } from "../../../../src/features/action/sendkeys/TypingSession";
import { ANDROID_TYPE_FOCUSED_INPUT_ERROR } from "../../../../src/features/action/sendkeys/AndroidTypingConstants";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { observation } from "./EventTyperTestHarness";
import { android, createSendKeysHarness } from "../SendKeysTestHarness";

function harness() {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const calls: unknown[] = [];
  const host: KeyEventSupportHost = {
    adb,
    timer,
    session: new TypingSession(),
    observer: {
      execute: async (options) => {
        calls.push(options);
        return observation("");
      },
    },
    getTargetLayer: () => undefined,
    getKeyEventPlan: (char, signal) => support.getKeyEventPlan(char, signal),
    supportsAndroidKeyCombination: (signal) => support.supportsAndroidKeyCombination(signal),
    getAndroidApiLevel: (signal) => support.getAndroidApiLevel(signal),
    executeKeyEventPlan: (plan, signal) => support.executeKeyEventPlan(plan, signal),
    keyEventFailureMessage: (error) => support.keyEventFailureMessage(error),
    readFocusedText: (frame) => {
      const text = frame.viewHierarchy?.hierarchy.node?.$?.text;
      return typeof text === "string" ? text : undefined;
    },
    readFreshObservation: async (signal, display) => {
      calls.push({ signal, display });
      return observation("A");
    },
    withTextWarnings: (result, warnings) => ({
      ...result,
      warning: [...warnings, result.warning].filter(Boolean).join(" "),
    }),
    checkAbort: (signal, error) => {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
    },
    clearAndVerifyAndroid: async (signal, display) => {
      calls.push({ clear: true, signal, display });
      return { result: { success: true }, unchangedWarning: "unchanged" };
    },
    markPartialAfterMutation: (result) =>
      result.success ? result : { ...result, partialApplication: true },
  };
  const support = new KeyEventSupport(host);
  return { support, host, adb, timer, calls };
}

describe("KeyEventSupport", () => {
  test("does not probe unshifted keys and shares the API promise for concurrent shifted plans", async () => {
    const { support, adb } = harness();
    adb.setAndroidApiLevel(31);
    expect(await support.getKeyEventPlan("a")).toEqual({
      commands: ["shell input keyevent KEYCODE_A"],
    });
    expect(adb.getApiLevelCalls()).toEqual([]);
    const plans = await Promise.all([support.getKeyEventPlan("A"), support.getKeyEventPlan("!")]);
    expect(plans.every((plan) => plan !== null)).toBe(true);
    expect(adb.getApiLevelCalls()).toEqual([{ timeoutMs: 1000, signal: undefined }]);
    expect(await support.getEventAllKeyEventPlan("😀")).toBeNull();
    expect(await support.getEventAllKeyEventPlan("\n")).toBeNull();
  });

  test("retains a null capability and retries an unexpectedly rejected probe", async () => {
    const { support, adb, timer } = harness();
    const now = timer.now.bind(timer);
    timer.now = () => {
      throw new Error("clock unavailable");
    };
    await expect(support.getAndroidApiLevel()).rejects.toThrow(
      "Failed to read Android key-combination capability",
    );
    timer.now = now;
    expect(await support.getAndroidApiLevel()).toBeNull();
    adb.setAndroidApiLevel(35);
    expect(await support.getAndroidApiLevel()).toBeNull();
    expect(adb.getApiLevelCalls()).toHaveLength(1);
  });

  test("preserves the input-text settlement options, API dispatch and command order", async () => {
    const { support, adb } = harness();
    const signal = new AbortController().signal;
    adb.setAndroidApiLevel(31);
    await support.executeKeyEventPlan(
      { commands: ["shell input text 'ab'", "shell input keyevent KEYCODE_ENTER"], textLength: 2 },
      signal,
    );
    expect(adb.getExecutedArgv()).toEqual([["shell", "echo $$; exec cmd input text 'ab'"]]);
    expect(adb.getCommandCalls()).toEqual([
      {
        command: "shell echo $$; exec cmd input text 'ab'",
        // API 31+ (#12576): the host adb client gets the length-scaled hold as its timeout
        // and its own signal, never the request's, and no PID settlement is requested.
        timeoutMs: INPUT_TEXT_SETTLEMENT_BASE_MS + INPUT_TEXT_HOST_WAIT_PER_CHAR_MS * 2,
        maxBuffer: undefined,
        noRetry: true,
        signal: expect.any(AbortSignal),
        waitForProcessSettlementAfterAbort: undefined,
      },
      {
        command: "shell input keyevent KEYCODE_ENTER",
        timeoutMs: undefined,
        maxBuffer: undefined,
        noRetry: undefined,
        signal,
        waitForProcessSettlementAfterAbort: undefined,
      },
    ]);
    expect(adb.getCommandCalls()[0].signal).not.toBe(signal);
  });

  test("waits for a dispatched guest to settle before reporting failure", async () => {
    const { support, host, adb, timer } = harness();
    const failure = new Error("dispatch failed");
    const options: Array<Parameters<FakeAdbExecutor["execute"]>[1]> = [];
    const execute = adb.execute.bind(adb);
    adb.execute = (args, config) => {
      options.push(config);
      return execute(args, config);
    };
    adb.setCommandResponse("echo $$; exec", createExecResult("123\n", ""));
    adb.setCommandError("echo $$; exec", failure);
    adb.setCommandResponseSequence("/proc/123/cmdline", [
      createExecResult("alive", ""),
      createExecResult("", ""),
    ]);
    host.getAndroidApiLevel = async () => 30;
    await expect(
      support.executeKeyEventPlan({ commands: ["shell input text 'a'"], textLength: 9 }),
    ).rejects.toBe(failure);
    expect(timer.getSleepHistory()).toEqual([75]);
    expect(adb.getExecutedCommands()).toHaveLength(3);
    expect(adb.getExecutedCommands()[1]).toContain("kill 123");
    expect(adb.getExecutedCommands()[2]).not.toContain("kill 123");
    expect(options[0]).toMatchObject({ noRetry: true, waitForProcessSettlementAfterAbort: true });
  });

  test("treats unknown-API guests as binder clients: no PID settlement and no kill on host failure", async () => {
    const { support, host, adb, timer } = harness();
    const failure = new Error("dispatch failed");
    const labels: Array<string | undefined> = [];
    const execute = adb.execute.bind(adb);
    adb.execute = (args, options) => {
      labels.push(options?.logLabel);
      return execute(args, options);
    };
    host.getAndroidApiLevel = async () => null;
    host.session.typingPasswordField = true;
    adb.setCommandResponse("echo $$; exec", createExecResult("123\n", ""));
    adb.setCommandError("echo $$; exec", failure);
    adb.setCommandResponse("/proc/123/cmdline", createExecResult("alive", ""));
    await expect(
      support.executeKeyEventPlan({ commands: ["shell input text 'a'"], textLength: 9 }),
    ).rejects.toBe(failure);
    // The host already exited with the failure, so there is nothing to hold for (#12576).
    expect(timer.now()).toBe(0);
    expect(labels[0]).toBe("shell input <password key event>");
    expect(
      adb
        .getExecutedCommands()
        .slice(1)
        .every((command) => !command.includes("kill 123")),
    ).toBe(true);
  });

  test("redacts password command labels and errors while preserving partial application", async () => {
    const { support, host, adb } = harness();
    host.session.typingPasswordField = true;
    const execute = adb.execute.bind(adb);
    const labels: Array<string | undefined> = [];
    adb.execute = (args, options) => {
      labels.push(options?.logLabel);
      return execute(args, options);
    };
    await support.executeKeyEventPlan({ commands: ["shell input keyevent KEYCODE_A"] });
    expect(labels).toEqual(["shell input <password key event>"]);
    host.executeKeyEventPlan = async () => {
      throw new TypeError("secret command");
    };
    expect(await support.executeKeyEventPlanSafely({ commands: ["secret"] }, true)).toEqual({
      success: false,
      partialApplication: true,
      error: "Android key event dispatch failed for a password field (TypeError; details withheld)",
    });
  });

  test("reads case three times with two settle sleeps and skips all reads for passwords", async () => {
    const { support, host, timer, calls } = harness();
    const typed = { success: true };
    const result = await support.verifyKeyEventLetterCase("a", typed, "eventOnly");
    expect(result.success).toBe(true);
    expect(result.warning).toContain('eventOnly typed "a"');
    expect(calls).toHaveLength(3);
    expect(timer.getSleepHistory()).toEqual([150, 150]);
    host.session.typingPasswordField = true;
    expect(await support.verifyKeyEventLetterCase("secret", typed, "eventAll")).toBe(typed);
    expect(calls).toHaveLength(3);
  });

  test("routes replace clearing and focus checks with the prototype exception intact", async () => {
    const { support, host, calls } = harness();
    const signal = new AbortController().signal;
    expect(await support.clearForReplace("insert", signal, "2")).toEqual({
      result: { success: true },
    });
    expect(calls).toEqual([]);
    expect(await support.clearForReplace("replace", signal, "2")).toMatchObject({
      unchangedWarning: "unchanged",
    });
    host.observer.execute = async () => ({ ...observation(), viewHierarchy: undefined });
    expect(await support.requireFocusedAndroidInput(signal)).toMatchObject({ success: false });
    host.getTargetLayer = () => "prototype";
    expect(
      await support.requireFocusedAndroidInput(signal, ANDROID_TYPE_FOCUSED_INPUT_ERROR, "2"),
    ).toEqual({ success: true, hierarchy: { hierarchy: {} } });
    expect(calls).toEqual([{ clear: true, signal, display: "2" }]);
  });

  test("executor delegates return the support promise without an async wrapper", () => {
    const { executor } = createSendKeysHarness(android);
    const support: unknown = Reflect.get(executor, "keyEventSupport");
    if (!(support instanceof KeyEventSupport)) {
      throw new Error("Expected executor key-event support");
    }
    const plan = Promise.resolve({ commands: ["patched"] });
    support.getKeyEventPlan = () => plan;
    const delegate: KeyEventSupport["getKeyEventPlan"] = Reflect.get(executor, "getKeyEventPlan");
    expect(delegate.call(executor, "a")).toBe(plan);
    const outcome = Promise.resolve(undefined);
    support.executeKeyEventPlanSafely = () => outcome;
    const safeDelegate: KeyEventSupport["executeKeyEventPlanSafely"] = Reflect.get(
      executor,
      "executeKeyEventPlanSafely",
    );
    expect(safeDelegate.call(executor, { commands: [] }, false)).toBe(outcome);
  });

  test("executor dispatch uses methods patched after construction", async () => {
    const { executor } = createSendKeysHarness(android);
    const result = Promise.resolve({ success: false, error: "patched" });
    const seen: unknown[] = [];
    Reflect.set(executor, "executeKeyEventPlanSafely", (...args: unknown[]) => {
      seen.push(args);
      return result;
    });
    Reflect.set(executor, "getKeyEventPlan", () => Promise.resolve({ commands: ["patched"] }));
    expect(await executor.type({ action: "type", text: "a", mode: "eventOnly" })).toMatchObject({
      success: false,
      error: "patched",
    });
    expect(seen).toEqual([[{ commands: ["patched"] }, false, undefined]]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  EventOnlyTyper,
  type EventOnlyTyperHost,
} from "../../../../src/features/action/sendkeys/EventOnlyTyper";
import { buildAsciiKeyEventPlan } from "../../../../src/utils/android-cmdline-tools/asciiKeyEvents";
import type { ObserveResult } from "../../../../src/models";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

function observation(text: string): ObserveResult {
  return {
    timestamp: 1,
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            focused: "true",
            class: "android.widget.EditText",
            text,
          },
        },
      },
    },
  };
}
function harness() {
  const calls: unknown[] = [];
  const adb = new FakeAdbExecutor();
  const host: EventOnlyTyperHost = {
    adb,
    observer: {
      execute: async (options) => {
        calls.push(options);
        return observation("");
      },
    },
    getKeyEventPlan: async (char) => buildAsciiKeyEventPlan(char, true),
    requireFocusedAndroidInput: async () => ({
      success: true,
      hierarchy: observation("old").viewHierarchy!,
    }),
    executeKeyEventPlanSafely: async (plan, mutated, signal) => {
      calls.push({ plan, mutated, signal });
      return undefined;
    },
    verifyKeyEventLetterCase: async (text, typed, signal, display, before) => {
      calls.push({ text, signal, display, before });
      return typed;
    },
    supportsAndroidKeyCombination: async () => true,
    isCaretUnsafe: () => false,
    preExistingFieldText: (_hierarchy, operation) => (operation === "replace" ? "" : "old"),
    markPartialAfterMutation: (result) =>
      result.success ? result : { ...result, partialApplication: true },
  };
  return { typer: new EventOnlyTyper(host), host, adb, calls };
}

describe("EventOnlyTyper", () => {
  test("validates every character before focus or mutation", async () => {
    const { typer, calls } = harness();
    expect(await typer.type({ text: "a😀", operation: "replace" })).toEqual({
      success: false,
      error: "eventOnly cannot type the character at index 1 with Android key events",
    });
    expect(calls).toEqual([]);
  });

  test("reads caret safety after asynchronous planning", async () => {
    const { typer, host, calls } = harness();
    const timer = new FakeTimer();
    host.getKeyEventPlan = async (char) => {
      await timer.sleep(1);
      return buildAsciiKeyEventPlan(char, true);
    };
    const pending = typer.type({ text: "a", operation: "insert" });
    host.isCaretUnsafe = () => true;
    timer.advanceTime(1);
    expect(await pending).toEqual({
      success: false,
      error: "eventOnly requires a known caret; use eventAll insertion or move the caret first",
    });
    expect(calls).toEqual([]);
  });

  test("forwards signal, mutation progress and pre-existing text to case verification", async () => {
    const { typer, calls } = harness();
    const signal = new AbortController().signal;
    expect(await typer.type({ text: "ab", operation: "insert", signal, display: "2" })).toEqual({
      success: true,
    });
    expect(calls).toEqual([
      { plan: buildAsciiKeyEventPlan("a", true), mutated: false, signal },
      { plan: buildAsciiKeyEventPlan("b", true), mutated: true, signal },
      { text: "ab", signal, display: "2", before: "old" },
    ]);
  });

  test("verifies replacement clear on the target display before typing", async () => {
    const { typer, adb, calls } = harness();
    const signal = new AbortController().signal;
    expect(await typer.type({ text: "a", operation: "replace", signal, display: "2" })).toEqual({
      success: true,
    });
    expect(adb.getExecutedCommands()).toEqual([
      "shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A",
      "shell input keyevent KEYCODE_DEL",
    ]);
    expect(calls).toEqual([
      { signal, freshness: "fresh", minTimestamp: 0, display: "2", skipScreenshot: true },
      { plan: buildAsciiKeyEventPlan("a", true), mutated: true, signal },
      { text: "a", signal, display: "2", before: "" },
    ]);
  });

  test("marks a failed clear verification as partial and stops typing", async () => {
    const { typer, host, calls } = harness();
    host.observer.execute = async () => observation("old");
    expect(await typer.type({ text: "a", operation: "replace" })).toEqual({
      success: false,
      partialApplication: true,
      error: "Field was not fully cleared: 3 UTF-16 units remain",
    });
    expect(calls).toEqual([]);
  });
});

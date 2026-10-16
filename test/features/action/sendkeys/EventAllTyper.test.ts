import { android, createSendKeysHarness } from "../SendKeysTestHarness";
import { describe, expect, test } from "bun:test";
import { EventAllTyper } from "../../../../src/features/action/sendkeys/EventAllTyper";
import { eventHost } from "./EventTyperTestHarness";

describe("EventAllTyper", () => {
  test("executor callbacks see method patches made after constructor wiring", async () => {
    const { executor } = createSendKeysHarness(android);
    const planned: string[] = [];
    const dispatched: unknown[] = [];
    Reflect.set(executor, "getKeyEventPlan", async (char: string) => {
      planned.push(char);
      return { commands: ["patched key event"] };
    });
    Reflect.set(executor, "executeKeyEventPlanSafely", async (...args: unknown[]) => {
      dispatched.push(args);
      return undefined;
    });
    Reflect.set(
      executor,
      "verifyKeyEventLetterCase",
      async (_text: string, result: { success: boolean }) => result,
    );
    expect(await executor.type({ action: "type", text: "ab", mode: "eventAll" })).toMatchObject({
      success: true,
      resolvedMode: "eventAll",
    });
    expect(planned).toContain("a");
    expect(planned).toContain("b");
    expect(dispatched).toEqual([
      [{ commands: ["shell input text 'ab'"], textLength: 2 }, true, undefined],
    ]);
  });

  test("sends Unicode-only text through insertion without a focus or clear read", async () => {
    const { host, calls } = eventHost();
    expect(await new EventAllTyper(host).type({ text: "😀é", operation: "insert" })).toEqual({
      success: true,
      resolvedMode: "a11y",
    });
    expect(calls).toEqual([{ insert: "😀é", options: undefined, signal: undefined }]);
  });

  test("batches ASCII with textLength through the executor's safe dispatch callback", async () => {
    const { host, calls } = eventHost();
    const signal = new AbortController().signal;
    expect(
      await new EventAllTyper(host).type({
        text: "ab",
        operation: "insert",
        focusedInputVerified: true,
        signal,
        display: "2",
      }),
    ).toEqual({ success: true });
    expect(calls).toEqual([
      { clear: "insert", signal, display: "2" },
      { precedingState: false },
      { plan: { commands: ["shell input text 'ab'"], textLength: 2 }, mutated: true, signal },
      { verify: "ab", mode: "eventAll", signal, display: "2", before: undefined },
    ]);
  });

  test("keeps password key events separate and redacts delivery failures", async () => {
    const { host, calls } = eventHost();
    host.setPasswordField(true);
    const typer = new EventAllTyper(host);
    expect(
      await typer.type({ text: "ab", operation: "insert", focusedInputVerified: true }),
    ).toEqual({ success: true });
    const dispatches = calls.filter(
      (call) => typeof call === "object" && call !== null && "plan" in call,
    );
    expect(dispatches).toEqual([
      { plan: { commands: ["shell input keyevent KEYCODE_A"] }, mutated: false, signal: undefined },
      { plan: { commands: ["shell input keyevent KEYCODE_B"] }, mutated: true, signal: undefined },
    ]);
    host.executeKeyEventPlanSafely = async () => ({ success: false, error: "redacted failure" });
    const failed = await typer.type({
      text: "secret",
      operation: "insert",
      focusedInputVerified: true,
    });
    expect(failed).toMatchObject({ success: false, committedGraphemes: 0 });
    expect(failed.error).not.toContain("U+0073");
    expect(failed.error).not.toContain("secret");
  });

  test("inserts all remaining graphemes after an unknown caret without further key events", async () => {
    const { host, calls } = eventHost();
    host.insertText = async (text, options, signal) => {
      calls.push({ insert: text, options, signal });
      return { success: true, caretPlaced: false, warning: "unknown caret" };
    };
    expect(
      await new EventAllTyper(host).type({
        text: "a😀b",
        operation: "insert",
        focusedInputVerified: true,
      }),
    ).toEqual({ success: true, warning: "unknown caret unknown caret" });
    expect(
      calls.filter((call) => typeof call === "object" && call !== null && "plan" in call),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => typeof call === "object" && call !== null && "insert" in call),
    ).toEqual([
      {
        insert: "😀",
        options: {
          expectedSuffix: "a",
          precedingState: { text: "old", selectionStart: 3, selectionEnd: 3 },
        },
        signal: undefined,
      },
      { insert: "b", options: undefined, signal: undefined },
    ]);
  });

  test("checks an unchanged clear warning on the target display after typing", async () => {
    const { host, calls } = eventHost();
    const signal = new AbortController().signal;
    host.clearForReplace = async () => ({
      result: { success: true },
      unchangedWarning: "clear unchanged",
    });
    host.readFreshObservation = async (readSignal, display) => {
      calls.push({ readSignal, display });
      return { timestamp: 1 };
    };
    host.readFocusedText = () => "a";
    expect(
      await new EventAllTyper(host).type({
        text: "a",
        operation: "replace",
        focusedInputVerified: true,
        signal,
        display: "2",
      }),
    ).toEqual({ success: true });
    expect(calls).toContainEqual({ readSignal: signal, display: "2" });
  });
});

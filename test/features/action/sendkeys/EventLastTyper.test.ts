import { describe, expect, test } from "bun:test";
import { EventLastTyper } from "../../../../src/features/action/sendkeys/EventLastTyper";
import {
  IME_COMMIT_READ_BACK_SETTLE_MS,
  CARET_UNKNOWN_WARNING,
} from "../../../../src/features/action/SendKeys";
import { eventHost } from "./EventTyperTestHarness";

describe("EventLastTyper", () => {
  test("falls back through the host when no non-whitespace tail key exists", async () => {
    const { host, calls } = eventHost();
    const typer = new EventLastTyper(host);
    expect(await typer.type({ text: "😀 ", operation: "replace" })).toEqual({
      success: true,
      resolvedMode: "a11y",
    });
    expect(calls).toEqual([{ replace: "😀 " }]);
  });

  test("preserves prefix, key, suffix and verification ordering on the requested display", async () => {
    const { host, calls } = eventHost();
    const signal = new AbortController().signal;
    expect(
      await new EventLastTyper(host).type({
        text: "😀a😀",
        operation: "insert",
        signal,
        display: "2",
      }),
    ).toEqual({ success: true });
    expect(calls).toEqual([
      { focus: "2", signal, error: expect.stringContaining("focused editable field") },
      { insert: "😀", options: undefined, signal },
      { precedingState: true },
      { plan: { commands: ["shell input keyevent KEYCODE_A"] }, mutated: true, signal },
      {
        insert: "😀",
        options: {
          expectedSuffix: "a",
          precedingState: { text: "old", selectionStart: 3, selectionEnd: 3 },
        },
        signal,
      },
      { verify: "😀a😀", mode: "eventLast", signal, display: "2", before: "old" },
    ]);
  });

  test("proves an unknown prefix caret after settling before dispatching the tail", async () => {
    const { host, calls, timer } = eventHost();
    let reads = 0;
    host.textClient.readInsertTextState = async () =>
      ++reads === 1
        ? { text: "", selectionStart: 0, selectionEnd: 0 }
        : { text: "😀", selectionStart: 2, selectionEnd: 2 };
    const warning =
      "Text was inserted, but the caret could not be placed after it (test); the caret position is unknown, so insert any further text with request_insert_text rather than key events";
    expect(CARET_UNKNOWN_WARNING.test(warning)).toBe(true);
    host.textClient.replace = async () => ({ success: true, caretPlaced: false, warning });
    timer.enableAutoAdvance();
    expect(await new EventLastTyper(host).type({ text: "😀a", operation: "replace" })).toEqual({
      success: true,
    });
    expect(timer.getSleepHistory()).toEqual([IME_COMMIT_READ_BACK_SETTLE_MS]);
    expect(reads).toBe(2);
    expect(calls).toContain("resetCaretState");
    expect(
      calls.filter((call) => typeof call === "object" && call !== null && "plan" in call),
    ).toHaveLength(1);
  });

  test("stops with a partial result when the prefix caret cannot be proven", async () => {
    const { host, calls, timer } = eventHost();
    timer.enableAutoAdvance();
    host.textClient.replace = async () => ({ success: true, caretPlaced: false });
    const result = await new EventLastTyper(host).type({ text: "😀a", operation: "replace" });
    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      error: expect.stringContaining("prefix insert could not place the caret"),
    });
    expect(calls).toHaveLength(1);
  });

  test("reads current caret safety after planning and stops before mutation", async () => {
    const { host, calls, timer } = eventHost();
    host.getKeyEventPlan = async () => {
      await timer.sleep(1);
      return { commands: ["tail"] };
    };
    const pending = new EventLastTyper(host).type({ text: "a", operation: "insert" });
    host.isCaretUnsafe = () => true;
    timer.advanceTime(1);
    expect(await pending).toMatchObject({
      success: false,
      error: expect.stringContaining("previous insert could not place the caret"),
    });
    expect(calls).toEqual([]);
  });
});

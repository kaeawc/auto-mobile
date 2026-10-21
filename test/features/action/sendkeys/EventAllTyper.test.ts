import { android, createSendKeysHarness } from "../SendKeysTestHarness";
import { describe, expect, test } from "bun:test";
import { EventAllTyper } from "../../../../src/features/action/sendkeys/EventAllTyper";
import {
  ANDROID_INPUT_TEXT_CHUNK_CHARS,
  ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS,
  type KeyEventPlan,
} from "../../../../src/utils/android-cmdline-tools/asciiKeyEvents";
import { eventHost, observation } from "./EventTyperTestHarness";

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

  test("splits a long ASCII run into bounded input text dispatches so cancel stops between chunks", async () => {
    const { host, calls } = eventHost();
    const text = "abcdefghij".repeat(7);
    expect(
      await new EventAllTyper(host).type({
        text,
        operation: "insert",
        focusedInputVerified: true,
      }),
    ).toEqual({ success: true });
    const plans = calls
      .filter(
        (call): call is { plan: KeyEventPlan } =>
          typeof call === "object" && call !== null && "plan" in call,
      )
      .map((call) => call.plan);
    expect(plans.map((plan) => plan.commands.length)).toEqual([1, 1, 1]);
    expect(plans.map((plan) => plan.textLength)).toEqual([
      ANDROID_INPUT_TEXT_CHUNK_CHARS,
      ANDROID_INPUT_TEXT_CHUNK_CHARS,
      text.length - 2 * ANDROID_INPUT_TEXT_CHUNK_CHARS,
    ]);
    expect(
      plans
        .flatMap((plan) => plan.commands)
        .map((command) => command.slice("shell input text '".length, -1))
        .join(""),
    ).toBe(text);
  });

  test("types a long ASCII run as one input text command on API 30", async () => {
    const { host, calls } = eventHost();
    host.getAndroidApiLevel = async () => 30;
    const text = "abcdefghij".repeat(7);
    host.readFocusedText = () => text;
    await new EventAllTyper(host).type({ text, operation: "insert", focusedInputVerified: true });
    const plan = calls.find(
      (call): call is { plan: KeyEventPlan } =>
        typeof call === "object" && call !== null && "plan" in call,
    )?.plan;
    expect(plan).toEqual({ commands: [`shell input text '${text}'`], textLength: text.length });
  });

  test("keeps finished chunks committed when a later pre-API-31 chunk fails (#13164)", async () => {
    const { host } = eventHost();
    host.getAndroidApiLevel = async () => 30;
    let dispatched = 0;
    host.executeKeyEventPlanSafely = async () => {
      dispatched++;
      return dispatched === 2 ? { success: false, error: "adb dropped" } : undefined;
    };
    const first = "a".repeat(ANDROID_INPUT_TEXT_PRE31_CHUNK_CHARS);
    const result = await new EventAllTyper(host).type({
      text: `${first}${"b".repeat(10)}`,
      operation: "insert",
      focusedInputVerified: true,
    });
    expect(result).toMatchObject({ success: false, committedGraphemes: first.length });
    expect(dispatched).toBe(2);
  });

  test("counts only the failed run's finished chunks after earlier runs (#13164)", async () => {
    const { host } = eventHost();
    host.getAndroidApiLevel = async () => 36;
    let dispatched = 0;
    host.executeKeyEventPlanSafely = async () => {
      dispatched++;
      return dispatched === 3 ? { success: false, error: "boom" } : undefined;
    };
    const result = await new EventAllTyper(host).type({
      text: "a".repeat(ANDROID_INPUT_TEXT_CHUNK_CHARS * 3),
      operation: "insert",
      focusedInputVerified: true,
    });
    expect(result).toMatchObject({
      success: false,
      committedGraphemes: ANDROID_INPUT_TEXT_CHUNK_CHARS * 2,
    });
  });

  test("keeps password key events separate and redacts delivery failures", async () => {
    const { host, calls } = eventHost();
    host.session.typingPasswordField = true;
    const typer = new EventAllTyper(host);
    expect(
      await typer.type({ text: "ab", operation: "insert", focusedInputVerified: true }),
    ).toEqual({ success: true });
    const dispatches = calls.filter(
      (call) => typeof call === "object" && call !== null && "plan" in call,
    );
    expect<unknown>(dispatches).toEqual([
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
    expect<unknown>(
      calls.filter((call) => typeof call === "object" && call !== null && "insert" in call),
    ).toEqual([
      {
        insert: "😀",
        options: {
          expectedSuffix: "a",
          precedingState: {
            text: "old",
            isShowingHintText: false,
            selectionStart: 3,
            selectionEnd: 3,
          },
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
      return observation();
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

  describe("pre-API-31 delivery read-back (#12733)", () => {
    const text = "abcdefgh";
    function api30Host(fieldText: string | undefined) {
      const { host, timer, calls } = eventHost();
      timer.enableAutoAdvance();
      host.getAndroidApiLevel = async () => 30;
      host.readFocusedText = () => fieldText;
      return { host, timer, calls };
    }
    const typeText = (
      host: ReturnType<typeof eventHost>["host"],
      operation: "insert" | "replace",
    ) => new EventAllTyper(host).type({ text, operation, focusedInputVerified: true });

    test("fails as partial with the committed prefix when the device dropped characters", async () => {
      const { host, timer } = api30Host("abcdfgh");
      const result = await typeText(host, "insert");
      expect(result).toMatchObject({
        success: false,
        partialApplication: true,
        committedGraphemes: 4,
      });
      expect(result.error).toContain("dropped");
      // Bounded settle polling: three reads, two settle sleeps.
      expect(timer.getSleepHistory()).toHaveLength(2);
    });

    test("succeeds when the field contains the typed text after existing content", async () => {
      const { host } = api30Host("oldabcdefgh");
      expect(await typeText(host, "insert")).toMatchObject({ success: true });
    });

    test("accepts a read that settles on the second attempt", async () => {
      const { host } = api30Host("abcd");
      const reads = ["abcd", "xabcdefgh"];
      host.readFocusedText = () => reads.shift();
      expect(await typeText(host, "replace")).toMatchObject({ success: true });
    });

    test("does not fail when the field cannot be read", async () => {
      const { host } = api30Host(undefined);
      expect(await typeText(host, "insert")).toMatchObject({ success: true });
    });

    test("does not fail on a case-only difference, which the letter-case check owns", async () => {
      const { host } = api30Host("ABCDEFGH");
      expect(await typeText(host, "insert")).toMatchObject({ success: true });
    });

    test("never reads or reports a password field's text", async () => {
      const { host } = api30Host("abc");
      host.session.typingPasswordField = true;
      expect(await typeText(host, "insert")).toMatchObject({ success: true });
    });

    test("API 31+ is unchanged: no extra read-back", async () => {
      const { host } = api30Host("abcdfgh");
      host.getAndroidApiLevel = async () => 31;
      expect(await typeText(host, "insert")).toMatchObject({ success: true });
    });
  });
});

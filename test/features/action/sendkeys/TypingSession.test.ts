import { describe, expect, test } from "bun:test";
import { TypingSession } from "../../../../src/features/action/sendkeys/TypingSession";
import { android, createSendKeysHarness } from "../SendKeysTestHarness";
import { observation } from "./EventTyperTestHarness";

// The session deliberately shares the original executor lifetime, including overlapping calls.
describe("TypingSession", () => {
  test("starts with independent mutable state for each executor session", () => {
    const first = new TypingSession();
    const second = new TypingSession();
    expect(first).toEqual({
      androidCaretUnsafe: false,
      imeUserId: undefined,
      typingPasswordField: false,
    });
    first.androidCaretUnsafe = true;
    first.imeUserId = 10;
    first.typingPasswordField = true;
    expect(second).toEqual({
      androidCaretUnsafe: false,
      imeUserId: undefined,
      typingPasswordField: false,
    });
  });

  test("preserves an unsafe caret across inserts until a key explicitly resets it", async () => {
    const { executor, client } = createSendKeysHarness(android);
    client.insert = async () => ({ success: true, caretPlaced: false });
    expect(await executor.type({ action: "type", text: "😀", mode: "a11y" })).toMatchObject({
      success: true,
    });
    expect(await executor.type({ action: "type", text: "a", mode: "eventOnly" })).toMatchObject({
      success: false,
      error: expect.stringContaining("known caret"),
    });
    await executor.key({ action: "key", key: "ARROW_LEFT" });
    expect(await executor.type({ action: "type", text: "a", mode: "eventOnly" })).toMatchObject({
      success: true,
    });
  });

  test("password state survives a completed command and a key, then is assigned by the next type", async () => {
    const { executor } = createSendKeysHarness(android, { execute: async () => observation("") });
    executor.setTargetLayer("prototype");
    executor.setTargetPasswordField(true);
    await executor.type({ action: "type", text: "secret", mode: "a11y" });
    expect(executor.isPasswordTarget()).toBe(true);
    await executor.key({ action: "key", key: "ARROW_LEFT" });
    expect(executor.isPasswordTarget()).toBe(true);
    executor.setTargetPasswordField(false);
    await executor.type({ action: "type", text: "ordinary", mode: "a11y" });
    expect(executor.isPasswordTarget()).toBe(false);
  });

  test("overlapping commands see the same caret state after their asynchronous planning", async () => {
    const { executor, client } = createSendKeysHarness(android);
    const planned = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    Reflect.set(executor, "getKeyEventPlan", async () => {
      planned.resolve();
      await resume.promise;
      return { commands: ["shell input keyevent KEYCODE_A"] };
    });
    const pending = executor.type({ action: "type", text: "a", mode: "eventOnly" });
    await planned.promise;
    client.insert = async () => ({ success: true, caretPlaced: false });
    await executor.type({ action: "type", text: "😀", mode: "a11y" });
    resume.resolve();
    expect(await pending).toMatchObject({
      success: false,
      error: expect.stringContaining("known caret"),
    });
  });
});

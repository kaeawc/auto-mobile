import { afterEach, describe, expect, test } from "bun:test";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../../src/utils/debug";
import type { ObserveResult } from "../../../src/models";
import { DefaultSendKeysCommandExecutor, SendKeys } from "../../../src/features/action/SendKeys";
import { clearAndroidImeQuarantine } from "../../../src/features/action/androidImeLock";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness, focused } from "./SendKeysTestHarness";

// Debug mode is module state: this file runs isolated instead of entering the shared-safe suite.
const device = { ...android, deviceId: "ime-trace-fake" };
afterEach(() => clearAndroidImeQuarantine(device.deviceId));

function passwordField(): ObserveResult {
  return {
    ...focused,
    viewHierarchy: {
      hierarchy: {
        node: {
          $: { focused: "true", class: "android.widget.EditText", text: "", password: "true" },
        },
      },
    },
  };
}

function harness(
  text: string,
  observation: ObserveResult = {
    ...focused,
    viewHierarchy: {
      hierarchy: {
        node: { $: { focused: "true", class: "android.widget.MultiAutoCompleteTextView", text } },
      },
    },
  },
) {
  const observer = { execute: async () => observation };
  const h = createSendKeysHarness(device, observer);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const executor = new DefaultSendKeysCommandExecutor(device, h.adbFactory, observer, {
    textClient: h.client,
    timer,
    inputKey: { press: async () => ({ success: true }) },
  });
  const action = new SendKeys(device, h.adbFactory, {
    executor,
    observer,
    timer,
    timestampProvider: { now: async () => 1 },
  });
  return { ...h, executor, action, timer };
}

describe("IME trace opt-in", () => {
  afterEach(() => {
    setDebugModeEnabled(false);
    expect(isDebugModeEnabled()).toBe(false);
  });

  test.each([true, false])("debug trace survives a commit with success=%s", async (success) => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async (_text, _prior, _signal, _delivery, trace) => {
      expect(trace).toBe(true);
      return {
        success,
        ...(success ? { insertedText: "hello" } : { error: "commit failed" }),
        imeTrace: ["seq=1 t=0 event=complete"],
      };
    };
    const result = await h.executor.type({ action: "type", text: "hello", mode: "ime" });
    expect(result.success).toBe(success);
    expect(result.imeTrace).toEqual(["seq=1 t=0 event=complete"]);
  });

  test("clear and commit traces concatenate even when verification fails", async () => {
    setDebugModeEnabled(true);
    const h = harness("different");
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async (_text, _prior, _signal, delivery, trace) => {
      expect(trace).toBe(true);
      return {
        success: true,
        insertedText: delivery === "clearField" ? "" : "wrong",
        imeTrace: [delivery === "clearField" ? "clear" : "commit"],
      };
    };
    const result = await h.executor.type({
      action: "type",
      text: "hello",
      mode: "ime",
      operation: "replace",
    });
    expect(result.success).toBe(false);
    expect(result.imeTrace).toEqual(["clear", "commit"]);
  });

  test("overlapping clear and commit snapshots keep each line once in order", async () => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    const clearLines = ["seq=1 t=0 event=commitStart", "seq=2 t=0 event=complete"];
    const commitLines = ["seq=3 t=0 event=commitStart", "seq=4 t=0 event=complete"];
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async (_text, _prior, _signal, delivery) => ({
      success: true,
      insertedText: delivery === "clearField" ? "" : "hello",
      imeTrace: delivery === "clearField" ? clearLines : [...clearLines, ...commitLines],
    });
    const result = await h.executor.type({
      action: "type",
      text: "hello",
      mode: "ime",
      operation: "replace",
    });
    expect(result.success).toBe(true);
    expect(result.imeTrace).toEqual([...clearLines, ...commitLines]);
  });

  test("merged snapshots keep only the last 512 unique lines", async () => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    const lines = Array.from({ length: 600 }, (_, index) => `seq=${index + 1} t=0 event=complete`);
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async (_text, _prior, _signal, delivery) => ({
      success: true,
      insertedText: delivery === "clearField" ? "" : "hello",
      imeTrace: delivery === "clearField" ? lines.slice(0, 350) : lines.slice(300),
    });
    const result = await h.executor.type({
      action: "type",
      text: "hello",
      mode: "ime",
      operation: "replace",
    });
    expect(result.success).toBe(true);
    expect(result.imeTrace).toEqual(lines.slice(-512));
  });

  test.each(["command", "span"] as const)(
    "%s restoration failure preserves the trace",
    async (path) => {
      setDebugModeEnabled(true);
      const h = harness("hello");
      h.adb.setCommandResponse("shell ime disable", { stdout: "", stderr: "disable failed" });
      h.client.supportsImeTrace = async () => true;
      h.client.commitViaIme = async () => ({
        success: true,
        insertedText: "hello",
        imeTrace: ["seq=1 t=0 event=complete"],
      });
      const command = { action: "type", text: "hello", mode: "ime" } as const;
      const result =
        path === "command"
          ? await h.executor.type(command)
          : (await h.action.execute([command])).commands[0];
      expect(result.success).toBe(false);
      expect(result.imeFailure?.stage).toBe("restoration");
      expect(result.imeTrace).toEqual(["seq=1 t=0 event=complete"]);
    },
  );

  test("each type command receives only its own trace", async () => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    h.client.supportsImeTrace = async () => true;
    let commits = 0;
    h.client.commitViaIme = async (text) => ({
      success: true,
      insertedText: text,
      imeTrace: [`seq=${++commits} t=0 event=complete`],
    });
    const result = await h.action.execute([
      { action: "type", text: "he", mode: "ime" },
      { action: "type", text: "llo", mode: "ime" },
    ]);
    expect(result.success).toBe(true);
    expect(result.commands.map((command) => command.imeTrace)).toEqual([
      ["seq=1 t=0 event=complete"],
      ["seq=2 t=0 event=complete"],
    ]);
  });

  test("password failure redaction preserves text-free trace", async () => {
    setDebugModeEnabled(true);
    const h = harness("", passwordField());
    h.client.supportsImePasswordCommit = async () => true;
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async () => ({
      success: false,
      error: "commit failed",
      imeTrace: ["secure=true"],
    });
    const result = (await h.action.execute([{ action: "type", text: "secret", mode: "ime" }]))
      .commands[0];
    expect(result.success).toBe(false);
    expect(result.imeTrace).toEqual(["secure=true"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test.each([
    [false, true],
    [true, false],
  ])("debug=%s capability=%s keeps the default shape", async (debug, capability) => {
    setDebugModeEnabled(debug);
    const h = harness("hello");
    h.client.supportsImeTrace = async () => capability;
    h.client.commitViaIme = async (_text, _prior, _signal, _delivery, trace) => {
      expect(trace).toBeUndefined();
      return { success: true, insertedText: "hello" };
    };
    const result = await h.executor.type({ action: "type", text: "hello", mode: "ime" });
    expect(result.success).toBe(true);
    expect("imeTrace" in result).toBe(false);
  });
});

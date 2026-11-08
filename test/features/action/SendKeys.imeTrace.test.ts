import { createSendKeysTextClient } from "../../../src/features/action/sendkeys/CtrlProxyTextClient";
import { buildObserveResult } from "../../helpers/observeFixture";
import { createExecResult } from "../../../src/utils/execResult";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { isDebugModeEnabled, setDebugModeEnabled } from "../../../src/utils/debug";
import type { ObserveResult } from "../../../src/models";
import { DefaultSendKeysCommandExecutor, SendKeys } from "../../../src/features/action/SendKeys";
import { clearAndroidImeQuarantine } from "../../../src/features/action/androidImeLock";
import { IME_EDITOR_NONE_APPLIED_ERROR } from "../../../src/features/action/imeFailureDiagnostics";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android/AndroidCtrlProxyClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness, focused } from "./SendKeysTestHarness";

// Debug mode is module state: this file runs isolated instead of entering the shared-safe suite.
const device = { ...android, deviceId: "ime-trace-fake" };
afterEach(() => clearAndroidImeQuarantine(device.deviceId));

function passwordField(): ObserveResult {
  return buildObserveResult({
    ...focused,
    viewHierarchy: {
      hierarchy: {
        node: {
          $: { focused: "true", class: "android.widget.EditText", text: "", password: "true" },
        },
      },
    },
  });
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
    pendingImeRestores: h.pendingImeRestores,
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

  test.each([true, false])(
    "debug trace is returned on failure only (success=%s)",
    async (success) => {
      setDebugModeEnabled(true);
      const h = harness("hello");
      h.client.supportsImeTrace = async () => true;
      h.client.commitViaIme = async (
        _text,
        _prior,
        _signal,
        { delivery: _delivery, trace } = {},
      ) => {
        expect(trace).toBe(true);
        return {
          success,
          ...(success ? { insertedText: "hello" } : { error: "commit failed" }),
          imeTrace: ["seq=1 t=0 event=complete"],
        };
      };
      const result = await h.executor.type({ action: "type", text: "hello", mode: "ime" });
      expect(result.success).toBe(success);
      // #17464: a successful command's trace is debug data, not part of the response.
      expect(result.imeTrace).toEqual(success ? undefined : ["seq=1 t=0 event=complete"]);
    },
  );

  test("clear and commit traces concatenate even when verification fails", async () => {
    setDebugModeEnabled(true);
    const h = harness("different");
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async (_text, _prior, _signal, { delivery, trace } = {}) => {
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
    h.client.commitViaIme = async (_text, _prior, _signal, { delivery } = {}) => ({
      success: true,
      insertedText: delivery === "clearField" ? "" : "wrong",
      imeTrace: delivery === "clearField" ? clearLines : [...clearLines, ...commitLines],
    });
    const result = await h.executor.type({
      action: "type",
      text: "hello",
      mode: "ime",
      operation: "replace",
    });
    expect(result.success).toBe(false);
    expect(result.imeTrace).toEqual([...clearLines, ...commitLines]);
  });

  test("merged snapshots keep only the last 512 unique lines", async () => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    const lines = Array.from({ length: 600 }, (_, index) => `seq=${index + 1} t=0 event=complete`);
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async (_text, _prior, _signal, { delivery } = {}) => ({
      success: true,
      insertedText: delivery === "clearField" ? "" : "wrong",
      imeTrace: delivery === "clearField" ? lines.slice(0, 350) : lines.slice(300),
    });
    const result = await h.executor.type({
      action: "type",
      text: "hello",
      mode: "ime",
      operation: "replace",
    });
    expect(result.success).toBe(false);
    expect(result.imeTrace).toEqual(lines.slice(-512));
  });

  test("standalone restoration failure preserves the trace", async () => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    h.adb.setCommandResponse("shell ime disable", createExecResult("", "disable failed"));
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async () => ({
      success: true,
      insertedText: "hello",
      imeTrace: ["seq=1 t=0 event=complete"],
    });
    const result = await h.executor.type({ action: "type", text: "hello", mode: "ime" });
    expect(result.success).toBe(false);
    expect(result.imeFailure?.stage).toBe("restoration");
    expect(result.imeTrace).toEqual(["seq=1 t=0 event=complete"]);
  });

  test("lazy restoration failure leaves the acknowledged command without a trace", async () => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    h.adb.setCommandResponse("shell ime disable", createExecResult("", "disable failed"));
    h.client.supportsImeTrace = async () => true;
    h.client.commitViaIme = async () => ({
      success: true,
      insertedText: "hello",
      imeTrace: ["seq=1 t=0 event=complete"],
    });
    const result = (await h.action.execute([{ action: "type", text: "hello", mode: "ime" }]))
      .commands[0];
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("imeTrace");
    await expect(h.pendingImeRestores.flush(device.deviceId)).rejects.toThrow("Could not restore");
    expect(result).not.toHaveProperty("imeTrace");
  });

  test("a failing command's trace excludes earlier commands' lines (#17464)", async () => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    h.client.supportsImeTrace = async () => true;
    // The device returns its whole ring buffer, so command 2's snapshot repeats command 1's lines.
    const first = ["seq=1 t=0 event=commitStart", "seq=2 t=0 event=commitFinish success=true"];
    const second = ["seq=3 t=0 event=commitStart", "seq=4 t=0 event=commitFinish success=false"];
    let commits = 0;
    h.client.commitViaIme = async (text) =>
      ++commits === 1
        ? { success: true, insertedText: text, totalTimeMs: 0, imeTrace: first }
        : { success: false, error: "commit failed", imeTrace: [...first, ...second] };
    const result = await h.action.execute([
      { action: "type", text: "he", mode: "ime" },
      { action: "type", text: "llo", mode: "ime" },
    ]);
    expect(result.success).toBe(false);
    expect(result.commands.map((command) => command.imeTrace)).toEqual([undefined, second]);
  });

  test("a failed restart retry keeps the trace of the attempt it replaced", async () => {
    setDebugModeEnabled(true);
    const h = harness("hello");
    h.client.supportsImeTrace = async () => true;
    const first = ["seq=1 t=0 event=commitStart", "seq=2 t=0 event=editorRestarted"];
    const second = ["seq=3 t=0 event=commitStart", "seq=4 t=0 event=commitFinish success=false"];
    let commits = 0;
    h.client.commitViaIme = async () =>
      ++commits === 1
        ? {
            success: false,
            error: IME_EDITOR_NONE_APPLIED_ERROR,
            insertedText: "",
            imeTrace: first,
          }
        : { success: false, error: "commit failed", imeTrace: [...first, ...second] };
    const result = await h.executor.type({ action: "type", text: "hello", mode: "ime" });
    expect(commits).toBe(2);
    expect(result.success).toBe(false);
    expect(result.imeTrace).toEqual([...first, ...second]);
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
    h.client.commitViaIme = async (_text, _prior, _signal, { delivery: _delivery, trace } = {}) => {
      expect(trace).toBeUndefined();
      return { success: true, insertedText: "hello" };
    };
    const result = await h.executor.type({ action: "type", text: "hello", mode: "ime" });
    expect(result.success).toBe(true);
    expect("imeTrace" in result).toBe(false);
  });
});

test.each([true, false])(
  "SendKeys carries editorConsumed=%s through verification",
  async (editorConsumed) => {
    const h = harness("helloworld");
    h.client.commitViaIme = async () => ({
      success: true,
      insertedText: "helloworld",
      ...(editorConsumed ? { editorConsumed: true } : {}),
    });
    const result = await h.action.execute([{ action: "type", text: "hello\nworld", mode: "ime" }]);
    expect(result.success).toBe(editorConsumed);
    expect(result.commands[0]).not.toHaveProperty("editorConsumed");
    expect(result.commands[0]).not.toHaveProperty("insertedText");
  },
);

test("Android SendKeys adapter forwards the consumed verdict", async () => {
  const h = harness("helloworld");
  const client = AndroidCtrlProxyClient.createForTesting(device, h.adb);
  const instance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  const commit = spyOn(client, "commitViaIme").mockResolvedValue({
    totalTimeMs: 0,
    success: true,
    insertedText: "helloworld",
    editorConsumed: true,
  });
  try {
    const adapter = createSendKeysTextClient(device, h.adbFactory);
    expect(await adapter.commitViaIme("hello\nworld", null)).toMatchObject({
      success: true,
      insertedText: "helloworld",
      editorConsumed: true,
    });
  } finally {
    commit.mockRestore();
    instance.mockRestore();
  }
});

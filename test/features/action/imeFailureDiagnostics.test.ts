import { afterEach, describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import { DefaultSendKeysCommandExecutor, SendKeys } from "../../../src/features/action/SendKeys";
import { clearAndroidImeQuarantine } from "../../../src/features/action/androidImeLock";
import {
  confirmImeCommitAfterSyncLoss,
  IME_EDITOR_SYNC_LOST_CONFIRMED_WARNING,
  IME_EDITOR_SYNC_LOST_ERROR,
  IME_INSERTED_TEXT_UNAVAILABLE_WARNING,
  verifyImeCommitResult,
  verifyImeInsertedText,
} from "../../../src/features/action/imeFailureDiagnostics";
import { FakeTimer } from "../../fakes/FakeTimer";
import { android, createSendKeysHarness, focused } from "./SendKeysTestHarness";

const device = { ...android, deviceId: "ime-failure-diagnostics-fake" };
afterEach(() => clearAndroidImeQuarantine(device.deviceId));

// Model-level observer fake, not a captured/parser fixture.
function field(text: string): ObserveResult {
  return {
    ...focused,
    viewHierarchy: {
      hierarchy: {
        node: { $: { focused: "true", class: "android.widget.MultiAutoCompleteTextView", text } },
      },
    },
  };
}

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

function harness(text: string, observation: ObserveResult = field(text)) {
  let observationReads = 0;
  const observer = {
    execute: async () => {
      observationReads++;
      return observation;
    },
  };
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
  return {
    ...h,
    executor,
    action,
    timer,
    get observationReads() {
      return observationReads;
    },
  };
}

describe("IME failure diagnostics", () => {
  test.each([
    ["john_doe@example.com", "johndoe@example.com"],
    ["user_name", "username"],
    ["~/Downloads", "/Downloads"],
    ["it`s", "its"],
  ])("device success cannot hide a lost literal marker in %s", async (text, insertedText) => {
    const observation = field("");
    const h = harness("", observation);
    h.client.commitViaIme = async () => {
      observation.viewHierarchy = field(insertedText).viewHierarchy;
      return { success: true, insertedText };
    };

    const result = await h.executor.type({ action: "type", text, mode: "ime" });

    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      imeFailure: { stage: "verification", observedText: insertedText },
    });
  });

  test.each([
    ["*bold*", "bold"],
    ["john_doe@example.com", "john_doe@example.com"],
  ])(
    "device success verifies real formatting or exact literal text in %s",
    async (text, insertedText) => {
      const observation = field("");
      const h = harness("", observation);
      h.client.commitViaIme = async () => {
        observation.viewHierarchy = field(insertedText).viewHierarchy;
        return { success: true, insertedText };
      };

      const result = await h.executor.type({ action: "type", text, mode: "ime" });

      expect(result.success).toBe(true);
      expect(result).not.toHaveProperty("imeFailure");
    },
  );

  test("a password-field read-back mismatch never names the typed or observed value", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const result = await verifyImeCommitResult({ success: true }, "hunter2", {
      timer,
      settleMs: 1,
      observe: async () => field("other"),
      checkAbort: () => {},
      lacksRequiredFocus: () => false,
      focusedText: () => "other",
      focusError: "unfocused",
      passwordField: true,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "IME partial commit: sent <password, 7 characters> but the focused field holds a different value",
    );
    expect(result.imeFailure).toMatchObject({
      expectedText: "<password, 7 characters>",
      observedText: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/hunter2|other/);
  });

  test("an explicit-mode read-back that shows a password field redacts the mismatch", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const result = await verifyImeCommitResult({ success: true }, "hunter2", {
      timer,
      settleMs: 1,
      observe: async () => passwordField(),
      checkAbort: () => {},
      lacksRequiredFocus: () => false,
      focusedText: () => "other",
      focusError: "unfocused",
      isPasswordField: () => true,
    });

    expect(result.success).toBe(false);
    expect(result.imeFailure).toMatchObject({
      expectedText: "<password, 7 characters>",
      observedText: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/hunter2|other/);
  });

  test.each(["ime", "imeKeyEvents"] as const)(
    "explicit %s failure into a password field never carries the typed text",
    async (mode) => {
      const h = harness("", passwordField());
      h.client.commitViaIme = async () => ({
        success: false,
        error: "Input connection lost during commit",
        partialApplication: true,
        committedUnits: 3,
      });

      const result = await h.action.execute([{ action: "type", text: "hunter2", mode }]);

      expect(result.success).toBe(false);
      expect(result.commands[0]?.imeFailure).toMatchObject({
        expectedText: "<password, 7 characters>",
        observedText: null,
      });
      expect(JSON.stringify(result.commands)).not.toContain("hunter2");
    },
  );

  test("a selector resolved to a password field redacts an explicit-mode failure", async () => {
    const h = harness("visible");
    h.client.commitViaIme = async () => ({ success: false, error: "No active input connection" });
    const action = new SendKeys(device, h.adbFactory, {
      executor: h.executor,
      observer: { execute: async () => field("visible") },
      timer: h.timer,
      timestampProvider: { now: async () => 1 },
      focuser: { focus: async () => ({ success: true, focusVerified: true, passwordField: true }) },
    });

    const result = await action.execute([{ action: "type", text: "hunter2", mode: "ime" }], {
      testTag: "password",
    });

    expect(result.commands[0]?.imeFailure?.expectedText).toBe("<password, 7 characters>");
    expect(JSON.stringify(result.commands)).not.toContain("hunter2");
  });

  test("a non-password explicit-mode failure keeps the typed text in its diagnostic", async () => {
    const h = harness("visible");
    h.client.commitViaIme = async () => ({ success: false, error: "No active input connection" });

    const result = await h.action.execute([{ action: "type", text: "hello", mode: "ime" }]);

    expect(result.commands[0]?.imeFailure?.expectedText).toBe("hello");
  });

  test("retains acknowledged progress and the final verification mismatch without fallback", async () => {
    const h = harness("@every");
    h.client.commitViaIme = async () => ({
      success: true,
      committedUnits: 9,
      committedGraphemes: 4,
    });
    const result = await h.executor.type({ action: "type", text: "@everyone" });
    expect(result).toMatchObject({
      success: false,
      requestedMode: "auto",
      resolvedMode: "ime",
      partialApplication: true,
      committedUnits: 9,
      committedGraphemes: 4,
      imeFailure: {
        stage: "verification",
        expectedText: "@everyone",
        observedText: "@every",
        focusedFieldClass: "android.widget.MultiAutoCompleteTextView",
        textMayHaveBeenApplied: true,
        committedUnits: 9,
        verifiedGraphemes: 4,
      },
    });
    expect(h.deliveries).toEqual([]);
    expect(h.timer.getSleepHistory()).toEqual([150, 150]);
  });

  test.each([
    ["IME service did not start within timeout", "activationBinding", false],
    ["No active input connection within timeout", "activationBinding", false],
    ["Input connection lost during commit", "commit", true],
    ["Input connection lost while finishing composition", "commit", true],
    ["unknown old APK error", "commit", true],
  ])("preserves backend cause %s and distinguishes stage %s", async (cause, stage, applied) => {
    const h = harness("");
    h.client.commitViaIme = async () => ({ success: false, error: cause });
    const result = await h.executor.type({ action: "type", text: "@everyone" });
    expect(result.error).toBe(cause);
    expect(result).toMatchObject({
      success: false,
      resolvedMode: "ime",
      imeFailure: {
        cause,
        stage,
        expectedText: "@everyone",
        focusedFieldClass: "android.widget.MultiAutoCompleteTextView",
        textMayHaveBeenApplied: applied,
      },
    });
    expect(h.deliveries).toEqual([]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  describe("sync loss after full dispatch (#10799)", () => {
    const syncLost = {
      success: false,
      error: IME_EDITOR_SYNC_LOST_ERROR,
      partialApplication: true,
      committedUnits: 9,
    };

    test.each(["ime", "imeKeyEvents"] as const)(
      "%s reports success when the read-back holds the whole text",
      async (mode) => {
        const h = harness("@everyone");
        h.client.commitViaIme = async () => syncLost;
        const result = await h.executor.type({ action: "type", text: "@everyone", mode });
        expect(result).toMatchObject({
          success: true,
          resolvedMode: mode,
          committedUnits: 9,
          warning: IME_EDITOR_SYNC_LOST_CONFIRMED_WARNING,
        });
        expect(result.error).toBeUndefined();
        expect(result.partialApplication).toBeUndefined();
        expect(result).not.toHaveProperty("imeFailure");
        expect(h.timer.getSleepHistory()).toEqual([]);
      },
    );

    test("waits for a lagging read-back before confirming", async () => {
      const reads = [field("@every"), field("@everyone")];
      const h = harness("", field(""));
      const observer = { execute: async () => reads.shift() ?? field("@everyone") };
      const executor = new DefaultSendKeysCommandExecutor(device, h.adbFactory, observer, {
        textClient: h.client,
        timer: h.timer,
        inputKey: { press: async () => ({ success: true }) },
      });
      h.client.commitViaIme = async () => syncLost;
      const result = await executor.type({ action: "type", text: "@everyone", mode: "ime" });
      expect(result.success).toBe(true);
      expect(h.timer.getSleepHistory()).toEqual([150]);
    });

    test("a commit that stopped early keeps partial application", async () => {
      const h = harness("@every");
      h.client.commitViaIme = async () => syncLost;
      const result = await h.executor.type({ action: "type", text: "@everyone", mode: "ime" });
      expect(result).toMatchObject({
        success: false,
        partialApplication: true,
        error: `${IME_EDITOR_SYNC_LOST_ERROR}; up to 9 editing units were dispatched before the commit stopped`,
        imeFailure: { stage: "commit", cause: IME_EDITOR_SYNC_LOST_ERROR, committedUnits: 9 },
      });
      expect(h.timer.getSleepHistory()).toEqual([150, 150]);
    });

    test("a password field stays unverified and never names the text", async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      let observed = 0;
      const result = await confirmImeCommitAfterSyncLoss(syncLost, "hunter2", {
        timer,
        settleMs: 1,
        observe: async () => {
          observed++;
          return passwordField();
        },
        checkAbort: () => {},
        lacksRequiredFocus: () => false,
        focusedText: () => "hunter2",
        focusError: "unfocused",
        isPasswordField: () => true,
      });
      expect(result).toBe(syncLost);
      expect(observed).toBe(1);
    });

    test("other failures are returned without observing the editor", async () => {
      const failure = { success: false, error: "Input connection lost during IME key events" };
      const result = await confirmImeCommitAfterSyncLoss(failure, "abc", {
        timer: new FakeTimer(),
        settleMs: 1,
        observe: async () => {
          throw new Error("must not observe");
        },
        checkAbort: () => {},
        lacksRequiredFocus: () => false,
        focusedText: () => "abc",
        focusError: "unfocused",
      });
      expect(result).toBe(failure);
    });

    test("an observation error keeps the failure", async () => {
      const result = await confirmImeCommitAfterSyncLoss(syncLost, "abc", {
        timer: new FakeTimer(),
        settleMs: 1,
        observe: async () => {
          throw new Error("observe failed");
        },
        checkAbort: () => {},
        lacksRequiredFocus: () => false,
        focusedText: () => "abc",
        focusError: "unfocused",
      });
      expect(result).toBe(syncLost);
    });
  });

  test("unsupported explicit IME is a precise no-commit failure", async () => {
    const h = harness("");
    h.client.supportsImeCommit = async () => false;
    const result = await h.executor.type({ action: "type", text: "@everyone", mode: "ime" });
    expect(result).toMatchObject({
      success: false,
      imeFailure: { stage: "unsupportedCapability", textMayHaveBeenApplied: false },
    });
    expect(h.committed).toEqual([]);
  });

  test("ambiguous dispatch exceptions do not imply the editor was unchanged", async () => {
    const h = harness("");
    h.client.commitViaIme = async () => {
      throw new Error("envelope lost");
    };
    const result = await h.executor.type({ action: "type", text: "@everyone" });
    expect(result).toMatchObject({
      success: false,
      error: "envelope lost",
      imeFailure: { stage: "transport", cause: "envelope lost", textMayHaveBeenApplied: true },
    });
    expect(h.deliveries).toEqual([]);
  });

  test("transport result markers survive the executor adapter without implying a no-op", async () => {
    const h = harness("");
    h.client.commitViaIme = async () => ({
      success: false,
      error: "response timed out",
      partialApplication: true,
      committedUnits: 2,
      imeFailureStage: "transport",
    });
    const result = await h.executor.type({ action: "type", text: "@everyone" });
    expect(result).toMatchObject({
      success: false,
      committedUnits: 2,
      imeFailure: {
        stage: "transport",
        cause: "response timed out",
        textMayHaveBeenApplied: true,
        committedUnits: 2,
      },
    });
    expect(h.inserted).toEqual([]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("progress overrides even a binding-like backend error; it cannot authorize a no-op retry", async () => {
    const h = harness("");
    h.client.commitViaIme = async () => ({
      success: false,
      error: "No active input connection",
      committedUnits: 2,
    });
    const result = await h.executor.type({ action: "type", text: "@everyone" });
    expect(result).toMatchObject({
      success: false,
      imeFailure: { stage: "commit", textMayHaveBeenApplied: true, committedUnits: 2 },
    });
    expect(result.imeFailure).not.toHaveProperty("verifiedGraphemes", 2);
    expect(h.inserted).toEqual([]);
  });

  test("a restoration failure retains acknowledged dispatch progress", async () => {
    const h = harness("@everyone");
    h.adb.setCommandResponse("shell ime disable", { stdout: "", stderr: "disable failed" });
    h.client.commitViaIme = async () => ({ success: true, committedUnits: 9 });
    const result = await h.executor.type({ action: "type", text: "@everyone" });
    expect(result).toMatchObject({
      success: false,
      committedUnits: 9,
      imeFailure: { stage: "restoration", textMayHaveBeenApplied: true, committedUnits: 9 },
    });
    expect(result.error).toContain("Text commit succeeded, but");
    expect(h.inserted).toEqual([]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("span restoration diagnostics belong to the last IME type and retain its progress", async () => {
    const h = harness("@everyone");
    const priors: (string | null)[] = [];
    h.adb.setCommandResponse("shell ime disable", { stdout: "", stderr: "disable failed" });
    h.client.commitViaIme = async (_text, prior) => {
      priors.push(prior);
      return { success: true, committedUnits: 9, committedGraphemes: 4 };
    };
    const result = await h.action.execute([
      { action: "type", text: "@every" },
      { action: "type", text: "@everyone" },
      { action: "key", key: "enter" },
    ]);
    expect(result).toMatchObject({ success: false, completedCommands: 2, failedIndex: 1 });
    expect(result.commands[0].success).toBe(true);
    expect(result.commands[1]).toMatchObject({
      action: "type",
      success: false,
      committedUnits: 9,
      committedGraphemes: 4,
      imeFailure: {
        stage: "restoration",
        expectedText: "@everyone",
        observedText: null,
        focusedFieldClass: "android.widget.MultiAutoCompleteTextView",
        textMayHaveBeenApplied: true,
        committedUnits: 9,
        verifiedGraphemes: 4,
      },
    });
    expect(result.error).toBe(result.commands[1].error);
    expect(result.error).toContain("Text commit succeeded, but");
    expect(result.commands[2]).toMatchObject({ action: "key", success: true });
    expect(result.commands[2]).not.toHaveProperty("imeFailure");
    expect(priors).toEqual([null, null]);
    expect(h.inserted).toEqual([]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("span cleanup retains the original verification diagnostic when restoration also fails", async () => {
    const h = harness("@every");
    h.adb.setCommandResponse("shell ime disable", { stdout: "", stderr: "disable failed" });
    h.client.commitViaIme = async () => ({ success: true, committedUnits: 9 });
    const result = await h.action.execute([{ action: "type", text: "@everyone" }]);
    expect(result).toMatchObject({ success: false, failedIndex: 0 });
    expect(result.commands[0]).toMatchObject({
      committedUnits: 9,
      imeFailure: {
        stage: "verification",
        expectedText: "@everyone",
        observedText: "@every",
        textMayHaveBeenApplied: true,
        committedUnits: 9,
      },
    });
    expect(result.commands[0].imeFailure?.cause).toContain("IME partial commit");
    expect(result.commands[0].imeFailure?.cause).not.toContain("restore");
    expect(result.error).toContain("Could not restore the original keyboard");
    expect(h.timer.getSleepHistory()).toEqual([150, 150]);
  });

  test.each(["shell settings get secure default_input_method", "shell ime list -s"])(
    "span snapshot failure is attributed to activation: %s",
    async (command) => {
      const h = harness("");
      h.adb.setCommandError(command, new Error("snapshot unavailable"));
      const result = await h.action.execute([{ action: "type", text: "@everyone" }]);
      expect(result.commands[0]).toMatchObject({
        success: false,
        imeFailure: {
          stage: "activationBinding",
          expectedText: "@everyone",
          focusedFieldClass: "android.widget.MultiAutoCompleteTextView",
          textMayHaveBeenApplied: false,
        },
      });
      expect(result.commands[0].imeFailure?.cause).toContain("snapshot unavailable");
      expect(h.committed).toEqual([]);
    },
  );

  test("a failed replace clear is wrapped inside the IME span before any commit", async () => {
    const h = harness("");
    const commit = h.client.commitViaIme;
    h.client.commitViaIme = async (...args) =>
      args[3] === "clearField" ? { success: false, error: "clear rejected" } : commit(...args);
    const result = await h.action.execute([
      { action: "type", text: "@everyone", operation: "replace" },
    ]);
    expect(result.commands[0]).toMatchObject({
      success: false,
      imeFailure: { stage: "commit", cause: "clear rejected", expectedText: "@everyone" },
    });
    expect(h.committed).toEqual([]);
    expect(h.inserted).toEqual([]);
  });

  test.each(["@everyone", "Testing broadcast mention @everyone"])(
    "pins existing separator tolerance for a single segment: %s",
    async (text) => {
      const h = harness(`${text}, `);
      expect(await h.executor.type({ action: "type", text })).toMatchObject({
        success: true,
        resolvedMode: "ime",
      });
      expect(h.committed).toEqual([text]);
      expect(h.timer.getSleepHistory()).toEqual([]);
    },
  );

  test("accepts multi-segment content in order when the editor adds separators", async () => {
    const h = harness("one bold tail, ");
    h.client.commitViaIme = async () => ({ success: true, committedUnits: 15 });
    const result = await h.executor.type({ action: "type", text: "one *bold* tail" });
    expect(result).toMatchObject({ success: true, resolvedMode: "ime", committedUnits: 15 });
    expect(result).not.toHaveProperty("imeFailure");
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("pins explicit accessibility caret warning and does not call it IME success", async () => {
    const h = harness("@everyone");
    h.client.insert = async () => ({
      success: true,
      caretPlaced: false,
      warning: "ACTION_SET_SELECTION returned false",
    });
    const result = await h.executor.type({ action: "type", text: "@everyone", mode: "a11y" });
    expect(result).toMatchObject({
      success: true,
      requestedMode: "a11y",
      resolvedMode: "a11y",
      warning: "ACTION_SET_SELECTION returned false",
    });
    expect(result).not.toHaveProperty("imeFailure");
    const next = await h.executor.type({ action: "type", text: "x", mode: "imeKeyEvents" });
    expect(next.success).toBe(false);
    expect(next.error).toContain("requires a known caret");
    expect(h.committed).toEqual([]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
});

describe("IME inserted delta verification", () => {
  const text = "line one\nline two\nline three";
  test.each([
    { name: "search field keeps its query and focus", after: "hello", insertedText: "hello" },
    { name: "chat composer sends and clears, keeps focus", after: "", insertedText: "" },
  ])(
    "a trailing newline the editor consumed as submit is not a partial commit: $name",
    async ({ after, insertedText }) => {
      const observation = field("");
      const h = harness("", observation);
      h.client.commitViaIme = async () => {
        observation.viewHierarchy = field(after).viewHierarchy;
        return { success: true, insertedText };
      };
      const result = await h.executor.type({ action: "type", text: "hello\n" });
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.partialApplication).toBeUndefined();
      expect(result.imeFailure).toBeUndefined();
      expect(result.warning).toBeUndefined();
      expect(h.timer.getSleepHistory()).toEqual([]);
    },
  );

  test("forgives only the final newline when the preceding newline is inserted", async () => {
    const observation = field("");
    const h = harness("", observation);
    h.client.commitViaIme = async () => {
      observation.viewHierarchy = field("hello\n").viewHierarchy;
      return { success: true, insertedText: "hello\n" };
    };
    const result = await h.executor.type({ action: "type", text: "hello\n\n" });
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.partialApplication).toBeUndefined();
    expect(result.imeFailure).toBeUndefined();
    expect(result.warning).toBeUndefined();
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test.each([
    {
      name: "two trailing newlines lost",
      text: "hello\n\n",
      insertedText: "hello",
      after: "hello",
    },
    { name: "middle newline lost", text: "one\ntwo\n", insertedText: "onetwo", after: "onetwo" },
    { name: "empty delta without submit", text: "hello", insertedText: "", after: "" },
    { name: "empty delta with stale field", text: "hello\n", insertedText: "", after: "stale" },
  ])("does not forgive an incomplete commit: $name", async ({ text, insertedText, after }) => {
    const observation = field("");
    const h = harness("", observation);
    h.client.commitViaIme = async () => {
      observation.viewHierarchy = field(after).viewHierarchy;
      return { success: true, insertedText };
    };
    const result = await h.executor.type({ action: "type", text });
    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      imeFailure: { stage: "verification", observedText: insertedText },
    });
    expect(result.error).toContain(`the editor inserted ${JSON.stringify(insertedText)}`);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test.each([
    { name: "retained query", after: "hello", success: true },
    { name: "cleared composer", after: "", success: false },
  ])("keeps legacy read-back behaviour after submit: $name", async ({ after, success }) => {
    const observation = field("");
    const h = harness("", observation);
    h.client.commitViaIme = async () => {
      observation.viewHierarchy = field(after).viewHierarchy;
      return { success: true };
    };
    h.client.supportsImeInsertedText = async () => false;
    const result = await h.executor.type({ action: "type", text: "hello\n" });
    expect(result.success).toBe(success);
    expect(result).not.toHaveProperty("insertedText");
    if (success) {
      expect(result.error).toBeUndefined();
      expect(result.partialApplication).toBeUndefined();
      expect(result.imeFailure).toBeUndefined();
      expect(result.warning).toBe(IME_INSERTED_TEXT_UNAVAILABLE_WARNING);
      expect(h.timer.getSleepHistory()).toEqual([]);
    } else {
      expect(result.error).toContain('the focused field holds ""');
      expect(result).toMatchObject({
        partialApplication: true,
        imeFailure: { stage: "verification", observedText: "" },
      });
      expect(h.timer.getSleepHistory()).toEqual([150, 150]);
    }
  });

  test.each([
    "line online two\nline three",
    "line line two\nline three",
    "line one\nltwo\nline three",
    "line one\nline twline three",
    "",
  ])("rejects dropped units after one readable observation: %j", async (insertedText) => {
    const h = harness(text + insertedText);
    let readsAtCommit = 0;
    h.client.commitViaIme = async () => {
      readsAtCommit = h.observationReads;
      return { success: true, committedUnits: 28, insertedText };
    };
    const result = await h.executor.type({ action: "type", text, mode: "ime" });
    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      imeFailure: { stage: "verification", observedText: insertedText },
    });
    expect(result.error).toContain(`the editor inserted ${JSON.stringify(insertedText)}`);
    expect(h.observationReads).toBe(readsAtCommit + 1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test.each([
    { text: "one\ntwo three", insertedText: "onetwo three" },
    { text: "one\ntwo three", insertedText: "one\ntwothree" },
    { text: "hi, there", insertedText: "hi there" },
    { text: "hello", insertedText: "prefix hello" },
  ])("rejects nonexact inserted delta: $insertedText", async ({ text, insertedText }) => {
    const h = harness(text + insertedText);
    h.client.commitViaIme = async () => ({ success: true, insertedText });
    const result = await h.executor.type({ action: "type", text, mode: "ime" });
    expect(result).toMatchObject({
      success: false,
      partialApplication: true,
      imeFailure: { stage: "verification", observedText: insertedText },
    });
    expect(result.error).toContain(JSON.stringify(insertedText));
  });

  test.each([
    { error: "Editor disconnected during IME commit", committedUnits: 5, insertedText: "" },
    { error: "IME commit deadline exceeded", committedUnits: 6, insertedText: "abcdef" },
  ])("keeps device cause and inserted delta: $error", async (failure) => {
    const h = harness(text);
    h.client.commitViaIme = async () => ({ success: false, partialApplication: true, ...failure });
    const result = await h.executor.type({ action: "type", text, mode: "ime" });
    expect(result.imeFailure).toMatchObject({
      cause: failure.error,
      observedText: failure.insertedText,
    });
    expect(result.error).toBe(
      `${failure.error}; up to ${failure.committedUnits} editing units were dispatched before the commit stopped`,
    );
  });

  test("a delta mismatch stops the batch before the second type", async () => {
    const h = harness(text + text);
    let calls = 0;
    h.client.commitViaIme = async () => {
      calls++;
      return { success: true, insertedText: "" };
    };
    const result = await h.action.execute([
      { action: "type", text, mode: "ime" },
      { action: "type", text: "second", mode: "ime" },
    ]);
    expect(result.success).toBe(false);
    expect(result.failedIndex).toBe(0);
    expect(result.error).toContain("IME partial commit");
    expect(calls).toBe(1);
  });

  test.each([
    { text: "hello", insertedText: "hello" },
    { text: "5551234567", insertedText: "(555) 123-4567" },
    { text: "- item", insertedText: "• item" },
    { text: "*bold*", insertedText: "bold" },
    { text: "hello", insertedText: "HELLO" },
    { text: "hi @name there", insertedText: "prefix hi name there suffix" },
    { text: "```code```", insertedText: "prefix code suffix" },
  ])("accepts editor transformations and still observes: $insertedText", async (input) => {
    const h = harness(input.insertedText);
    let readsAtCommit = 0;
    h.client.commitViaIme = async () => {
      readsAtCommit = h.observationReads;
      return { success: true, insertedText: input.insertedText };
    };
    const result = await h.executor.type({ action: "type", text: input.text, mode: "ime" });
    expect(result.success).toBe(true);
    expect(h.observationReads).toBeGreaterThan(readsAtCommit);
  });

  test("an old APK retains legacy whole-field acceptance and warns once", async () => {
    const h = harness(text + "line online two\nline three");
    h.client.commitViaIme = async () => ({ success: true, committedUnits: 28 });
    let probes = 0;
    h.client.supportsImeInsertedText = async () => {
      probes++;
      return false;
    };
    const result = await h.action.execute([{ action: "type", text, mode: "ime" }]);
    expect(result.success).toBe(true);
    expect(result.commands[0].warning).toBe(IME_INSERTED_TEXT_UNAVAILABLE_WARNING);
    expect(result.commands[0]).not.toHaveProperty("insertedText");
    expect(probes).toBe(1);
    expect(result.commands[0].warning).not.toContain(text);
  });

  test("a failed capability probe preserves the verified commit without a skew warning", async () => {
    const h = harness("hello");
    h.client.commitViaIme = async () => ({ success: true, committedUnits: 5 });
    let probes = 0;
    h.client.supportsImeInsertedText = async () => {
      probes++;
      throw new Error("socket dropped after commit");
    };
    const result = await h.executor.type({ action: "type", text: "hello", mode: "ime" });
    expect(result).toMatchObject({ success: true, committedUnits: 5, resolvedMode: "ime" });
    expect(result.warning).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(probes).toBe(1);
  });

  test.each(["signal", "AbortError"] as const)(
    "a failed capability probe still honours %s cancellation",
    async (kind) => {
      const h = harness("hello");
      h.client.commitViaIme = async () => ({ success: true });
      const controller = new AbortController();
      const error = new Error("probe cancelled");
      h.client.supportsImeInsertedText = async () => {
        if (kind === "signal") {
          controller.abort(error);
        } else {
          error.name = "AbortError";
        }
        throw error;
      };
      await expect(
        h.executor.type({ action: "type", text: "hello", mode: "ime" }, controller.signal),
      ).rejects.toThrow("probe cancelled");
    },
  );

  test("a new APK without insertedText has no skew warning", async () => {
    const h = harness("hello");
    h.client.commitViaIme = async () => ({ success: true });
    let probes = 0;
    h.client.supportsImeInsertedText = async () => {
      probes++;
      return true;
    };
    const result = await h.executor.type({ action: "type", text: "hello", mode: "ime" });
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(probes).toBe(1);
  });

  test.each([
    { name: "delta present", password: false, success: true, mode: "ime", insertedText: "hello" },
    { name: "password", password: true, success: true, mode: "ime" },
    { name: "failed commit", password: false, success: false, mode: "ime" },
    { name: "key events", password: false, success: true, mode: "imeKeyEvents" },
  ] as const)("does not probe or warn for $name", async (input) => {
    const h = input.password ? harness("", passwordField()) : harness("hello");
    h.client.supportsImePasswordCommit = async () => true;
    let probes = 0;
    h.client.supportsImeInsertedText = async () => {
      probes++;
      return false;
    };
    h.client.commitViaIme = async () => ({
      success: input.success,
      ...(input.success ? {} : { error: "No active input connection" }),
      ...("insertedText" in input ? { insertedText: input.insertedText } : {}),
    });
    const result = await h.executor.type({ action: "type", text: "hello", mode: input.mode });
    expect(result.success).toBe(input.success);
    expect(result.warning).toBeUndefined();
    expect(probes).toBe(0);
  });

  test("clear-field delivery does not probe or warn", async () => {
    const h = harness("");
    let probes = 0;
    h.client.supportsImeInsertedText = async () => {
      probes++;
      return false;
    };
    const result = await h.executor.clear(undefined, undefined, "ime");
    expect(result.success).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(probes).toBe(0);
  });

  test("password masked delta mismatch stays unverifiable without naming values", async () => {
    const h = harness("", passwordField());
    h.client.supportsImePasswordCommit = async () => true;
    h.client.commitViaIme = async () => ({ success: true, insertedText: "other-secret" });
    const result = await h.action.execute([{ action: "type", text: "hunter2" }]);
    expect(result.success).toBe(true);
    expect(result.commands[0]).not.toHaveProperty("imeFailure");
    expect(JSON.stringify(result.commands)).not.toMatch(/hunter2|other-secret/);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("consumed text and lost focus after auto pre-check stay successful", async () => {
    const observation = field("");
    const h = harness("", observation);
    h.client.commitViaIme = async () => {
      observation.viewHierarchy = {
        hierarchy: { node: { $: { class: "android.widget.TextView", focused: "false" } } },
      };
      return { success: true, insertedText: "" };
    };
    const result = await h.executor.type({ action: "type", text: "hello\n" });
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("imeFailure");
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("delta mismatch with an unreadable focused editor stays successful", async () => {
    const observation = field("");
    observation.viewHierarchy = {
      hierarchy: { node: { $: { class: "android.widget.EditText", focused: "true" } } },
    };
    const h = harness("", observation);
    h.client.commitViaIme = async () => ({ success: true, insertedText: "" });
    const result = await h.executor.type({ action: "type", text, mode: "ime" });
    expect(result.success).toBe(true);
    expect(result).not.toHaveProperty("imeFailure");
    expect(h.observationReads).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("delta mismatch with explicit missing focus keeps the focus failure", async () => {
    const observation = field("");
    observation.viewHierarchy = {
      hierarchy: { node: { $: { class: "android.widget.TextView", focused: "false" } } },
    };
    const h = harness("", observation);
    h.client.commitViaIme = async () => ({ success: true, insertedText: "" });
    const result = await h.executor.type({ action: "type", text, mode: "ime" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("focused");
    expect(result.error).not.toContain("IME partial commit");
    expect(result.imeFailure?.stage).toBe("verification");
    expect(h.observationReads).toBe(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("readable delta mismatch uses password routing redaction", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const result = await verifyImeCommitResult(
      { success: true, insertedText: "other-secret" },
      "hunter2",
      {
        timer,
        settleMs: 1,
        observe: async () => field("other"),
        checkAbort: () => {},
        lacksRequiredFocus: () => false,
        focusedText: () => "other",
        focusError: "unfocused",
        passwordField: true,
      },
    );
    expect(result.success).toBe(false);
    expect(result.imeFailure).toMatchObject({
      expectedText: "<password, 7 characters>",
      observedText: null,
    });
    expect(JSON.stringify({ error: result.error, imeFailure: result.imeFailure })).not.toMatch(
      /hunter2|other-secret/,
    );
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("delta mismatch with an observation error keeps the device acknowledgement", async () => {
    const timer = new FakeTimer();
    const deviceResult = { success: true, insertedText: "" };
    let observations = 0;
    const result = await verifyImeCommitResult(deviceResult, text, {
      timer,
      settleMs: 1,
      observe: async () => {
        observations++;
        throw new Error("fake hierarchy unavailable");
      },
      checkAbort: () => {},
      lacksRequiredFocus: () => false,
      focusedText: () => "",
      focusError: "unfocused",
    });
    expect(result).toBe(deviceResult);
    expect(observations).toBe(1);
    expect(timer.getSleepHistory()).toEqual([]);
  });

  test("the public command result omits insertedText", async () => {
    const h = harness("hello");
    h.client.commitViaIme = async () => ({ success: true, insertedText: "hello" });
    const result = await h.action.execute([{ action: "type", text: "hello", mode: "ime" }]);
    expect(result.success).toBe(true);
    expect(result.commands[0]).not.toHaveProperty("insertedText");
  });
});

test.each([true, false])("verification honours editorConsumed=%s", (editorConsumed) => {
  const result = verifyImeInsertedText(
    {
      success: true,
      insertedText: "helloworld",
      ...(editorConsumed ? { editorConsumed: true } : {}),
    },
    "hello\nworld",
  );
  expect(result.success).toBe(editorConsumed);
  if (!editorConsumed) {
    expect(result.error).toContain("IME partial commit");
  }
});

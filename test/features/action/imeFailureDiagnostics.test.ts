import { afterEach, describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../../src/models";
import { DefaultSendKeysCommandExecutor, SendKeys } from "../../../src/features/action/SendKeys";
import { clearAndroidImeQuarantine } from "../../../src/features/action/androidImeLock";
import {
  confirmImeCommitAfterSyncLoss,
  IME_EDITOR_SYNC_LOST_CONFIRMED_WARNING,
  IME_EDITOR_SYNC_LOST_ERROR,
  verifyImeCommitResult,
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

describe("IME failure diagnostics", () => {
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

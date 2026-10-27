import { observation } from "./EventTyperTestHarness";
import { TypingSession } from "../../../../src/features/action/sendkeys/TypingSession";
import { android, createSendKeysHarness } from "../SendKeysTestHarness";
import { clearAndroidImeQuarantine } from "../../../../src/features/action/androidImeLock";
import { afterEach, describe, expect, test } from "bun:test";
import {
  ImeCommitTyper,
  type ImeCommitTyperHost,
  type ImeCommitRestoration,
} from "../../../../src/features/action/sendkeys/ImeCommitTyper";
import type { AndroidImeSpan } from "../../../../src/features/action/sendkeys/ImeSpan";
import { FakeTimer } from "../../../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  const calls: unknown[] = [];
  const span: AndroidImeSpan = {
    safeToRestore: true,
    snapshot: { prior: "keyboard/.Ime", wasEnabled: true, priorSubtype: { id: 7 } },
  };
  const host: ImeCommitTyperHost = {
    session: Object.assign(new TypingSession(), { imeUserId: 10 }),
    executeAndroidImeCommit: (...args) => typer.executeAndroidImeCommit(...args),
    clearImeFieldWithKeyEvents: (...args) => typer.clearImeFieldWithKeyEvents(...args),
    markPartialAfterMutation: (result) =>
      result.success ? result : { ...result, partialApplication: true },
    device: { deviceId: "ime-typer-unit" },
    timer,
    textClient: {
      supportsImeCommit: async () => true,
      supportsImeKeyEvents: async () => true,
      supportsImeClearField: async () => true,
      supportsImeInsertedText: async () => true,
      commitViaIme: async (text, prior, signal, delivery, trace) => {
        calls.push({ text, prior, signal, delivery, trace });
        return { success: true, insertedText: text };
      },
    },
    observer: {
      execute: async (options) => {
        calls.push({ observe: options });
        return { ...observation(), updatedAt: timer.now() };
      },
    },
    imeTraceContext: { getStore: () => undefined },
    eventOnlyTyper: { clearEventOnlyForReplace: async () => ({ success: true }) },
    getTargetLayer: () => undefined,
    isSendKeysBudgetExhausted: () => false,
    executeAndroidType: async (options) => {
      calls.push({ fallback: options });
      return { success: true };
    },
    verifySafeImeRecovery: async () => true,
    checkAbort: (signal, error) => {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
    },
    restoreIme: async (prior, enabled, subtype) => {
      calls.push({ restore: prior, enabled, subtype });
    },
    clearAndVerifyAndroid: async (_signal, _display, clear) => ({ result: await clear!() }),
    withTextWarnings: (result, warnings) => {
      const combined = [...warnings, result.warning].filter(Boolean);
      return { ...result, ...(combined.length ? { warning: combined.join(" ") } : {}) };
    },
    requireFocusedAndroidInput: async () => ({ success: true, hierarchy: { hierarchy: {} } }),
    readFocusedText: () => undefined,
    readFocusedTextSnapshot: () => undefined,
  };
  const restoration: ImeCommitRestoration = {
    pinImeUser: async () => ({ success: true }),
    readDefaultIme: async () => ({ success: true, imeId: "keyboard/.Ime" }),
    readCommitImeEnabled: async () => ({ success: true, enabled: true }),
    pinnedImeCatalog: () => ({ readSubtype: async () => ({ id: 7 }) }),
    checkKeyboardProfileSupport: async () => ({ success: true }),
    setRequestedKeyboardProfile: async () => ({ success: true }),
    restoreKeyboardProfileIfNeeded: async () => {
      calls.push("restoreProfile");
    },
    activateCommitIme: async () => {
      calls.push("activate");
      return true;
    },
  };
  const service = {
    imeSpan: span as AndroidImeSpan | undefined,
    acquireImeSpan: async (active: AndroidImeSpan, signal?: AbortSignal) => {
      calls.push({ acquire: active === span, signal });
    },
  };
  const typer = new ImeCommitTyper(host, service, restoration);
  return {
    typer,
    host,
    service,
    restoration,
    calls,
    timer,
    span,
  };
}

describe("ImeCommitTyper", () => {
  afterEach(() => clearAndroidImeQuarantine("ime-typer-unit"));

  test("executor restoration resolves method patches after constructor wiring", async () => {
    const { executor, client } = createSendKeysHarness(android);
    const restored: unknown[] = [];
    client.commitViaIme = async (text) => ({ success: true, insertedText: text });
    Reflect.set(executor, "restoreIme", async (...args: unknown[]) => {
      restored.push(args);
    });
    expect(await executor.type({ action: "type", text: "a", mode: "ime" })).toMatchObject({
      success: true,
      resolvedMode: "ime",
    });
    expect(restored).toHaveLength(1);
    expect(restored[0]).toEqual(["com.example.keyboard/.Ime", false, { id: null }]);
  });

  test("executor commit dispatch observes patches in every IME route", async () => {
    for (const mode of ["ime", "imeKeyEvents", "auto"] as const) {
      const { executor } = createSendKeysHarness(android);
      const calls: unknown[] = [];
      Reflect.set(executor, "executeAndroidImeCommit", (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve({ success: true });
      });
      expect(await executor.type({ action: "type", text: "a", mode })).toMatchObject({
        success: true,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([
        "a",
        "insert",
        undefined,
        {
          signal: undefined,
          display: undefined,
          focusedInputVerified: mode === "auto",
          focusedFieldClass: mode === "auto" ? "android.widget.EditText" : undefined,
          passwordField: undefined,
        },
        ...(mode === "imeKeyEvents" ? ["imeKeyEvents"] : []),
      ]);
    }
  });

  test("executor IME snapshot and activation callbacks resolve patches lazily", async () => {
    const { executor } = createSendKeysHarness(android);
    const calls: string[] = [];
    Reflect.set(executor, "pinImeUser", () => {
      calls.push("pin");
      return Promise.resolve({ success: true });
    });
    Reflect.set(executor, "readDefaultIme", () => {
      calls.push("readDefault");
      return Promise.resolve({ success: false, error: "patched default read" });
    });
    expect(await executor.type({ action: "type", text: "a", mode: "ime" })).toMatchObject({
      success: false,
      error: "patched default read",
    });
    expect(calls).toEqual(["pin", "readDefault"]);
    const activated = createSendKeysHarness(android);
    Reflect.set(activated.executor, "activateCommitIme", () => {
      calls.push("activate");
      return Promise.resolve(false);
    });
    Reflect.set(activated.executor, "restoreIme", () => {
      calls.push("restore");
      return Promise.resolve();
    });
    expect(await activated.executor.type({ action: "type", text: "a", mode: "ime" })).toMatchObject(
      { success: false, error: "Failed to activate the IME for text commit." },
    );
    expect(calls).toEqual(["pin", "readDefault", "activate", "restore"]);
  });

  test("executor clear fallback resolves a patch installed after construction", async () => {
    const { executor, client } = createSendKeysHarness(android);
    client.supportsImeClearField = async () => false;
    const calls: unknown[] = [];
    Reflect.set(executor, "clearImeFieldWithKeyEvents", (...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve({ success: false, error: "patched clear" });
    });
    expect(
      await executor.type({ action: "type", text: "a", operation: "replace", mode: "ime" }),
    ).toMatchObject({ success: false, error: "patched clear" });
    expect(calls).toEqual([[undefined, undefined]]);
  });

  test("auto fallback recurses through the current host callback with routing intact", async () => {
    const { typer, host, calls } = harness();
    host.textClient.supportsImeCommit = async () => false;
    const routing = {
      signal: new AbortController().signal,
      display: "2",
      focusedInputVerified: true,
    };
    expect(
      await typer.type({
        text: "hello",
        operation: "insert",
        autoImeFallback: "eventAll",
        routing,
      }),
    ).toEqual({ success: true, resolvedMode: "eventAll" });
    expect(calls).toEqual([
      {
        fallback: {
          text: "hello",
          operation: "insert",
          mode: "eventAll",
          keyboardProfile: undefined,
          autoImeFallback: undefined,
          routing,
        },
      },
    ]);
  });

  test("shares the active span and sends key events without restoring its keyboard", async () => {
    const { typer, calls, span } = harness();
    const signal = new AbortController().signal;
    expect(
      await typer.type({
        text: "a",
        operation: "insert",
        mode: "imeKeyEvents",
        routing: { signal, passwordField: true },
      }),
    ).toMatchObject({ success: true, resolvedMode: "imeKeyEvents" });
    expect(span.lastType).toEqual({ text: "a", focusedFieldClass: undefined, passwordField: true });
    expect(calls).toEqual([
      { acquire: true, signal },
      { text: "a", prior: null, signal, delivery: "keyEvents", trace: undefined },
      "restoreProfile",
    ]);
  });

  test("clears before committing a replacement and skips activation for an existing snapshot", async () => {
    const { typer, host, calls } = harness();
    host.getTargetLayer = () => "prototype";
    const signal = new AbortController().signal;
    expect(
      await typer.type({
        text: "replacement",
        operation: "replace",
        routing: { signal, display: "2" },
      }),
    ).toMatchObject({ success: true, resolvedMode: "ime" });
    expect(calls).toEqual([
      { acquire: true, signal },
      { text: "", prior: null, signal, delivery: "clearField", trace: undefined },
      { text: "replacement", prior: null, signal, delivery: "commit", trace: undefined },
      "restoreProfile",
    ]);
  });

  test("checks caret safety after asynchronous capability probing", async () => {
    const { typer, host, calls, timer } = harness();
    host.textClient.supportsImeKeyEvents = async () => {
      await timer.sleep(1);
      return true;
    };
    const pending = typer.type({ text: "a", operation: "insert", mode: "imeKeyEvents" });
    host.session.androidCaretUnsafe = true;
    timer.enableAutoAdvance();
    expect(await pending).toMatchObject({
      success: false,
      error: expect.stringContaining("known caret"),
    });
    expect(calls).toEqual([{ acquire: true, signal: undefined }]);
  });

  test("restores through the current host callback outside a span, then clears the pinned user", async () => {
    const { typer, host, calls, service } = harness();
    service.imeSpan = undefined;
    host.getTargetLayer = () => "prototype";
    host.restoreIme = async () => {
      calls.push({ restoredUser: host.session.imeUserId });
    };
    expect(await typer.type({ text: "a", operation: "insert" })).toMatchObject({ success: true });
    expect(calls).toContainEqual({ restoredUser: 10 });
    expect(host.session.imeUserId).toBeUndefined();
  });

  test("does not restore or retry a session-unsafe commit and marks the span unsafe", async () => {
    const { typer, host, span, calls } = harness();
    span.snapshot!.prior = null;
    host.textClient.commitViaIme = async () => ({
      success: false,
      sessionUnsafe: true,
      error: "cancelled",
    });
    expect(
      await typer.type({ text: "a", operation: "insert", mode: "imeKeyEvents" }),
    ).toMatchObject({ success: false });
    expect(span.safeToRestore).toBe(false);
    expect(calls).toEqual([{ acquire: true, signal: undefined }]);
  });

  const restartNothing = {
    success: false,
    error:
      "Editor restarted its input connection during IME commit; none of the dispatched text is in the editor",
    insertedText: "",
  };

  test("retries an editor restart that committed nothing, with backoff, then succeeds", async () => {
    const { typer, host, timer } = harness();
    timer.enableAutoAdvance();
    let attempts = 0;
    host.textClient.commitViaIme = async (text) =>
      ++attempts < 3 ? { ...restartNothing } : { success: true, insertedText: text };
    expect(await typer.type({ text: "abc", operation: "insert" })).toMatchObject({
      success: true,
    });
    expect(attempts).toBe(3);
    expect(timer.getSleepHistory()).toEqual([100, 200]);
  });

  test("surfaces the restart after the bounded retries are exhausted", async () => {
    const { typer, host, timer } = harness();
    timer.enableAutoAdvance();
    let attempts = 0;
    host.textClient.commitViaIme = async () => {
      attempts++;
      return { ...restartNothing };
    };
    expect(await typer.type({ text: "abc", operation: "insert" })).toMatchObject({
      success: false,
    });
    expect(attempts).toBe(3);
  });

  test("never resends when the restart left partial text in the editor", async () => {
    const { typer, host, timer } = harness();
    timer.enableAutoAdvance();
    let attempts = 0;
    host.textClient.commitViaIme = async () => {
      attempts++;
      return { ...restartNothing, insertedText: "a" };
    };
    expect(await typer.type({ text: "abc", operation: "insert" })).toMatchObject({
      success: false,
    });
    expect(attempts).toBe(1);
  });
});

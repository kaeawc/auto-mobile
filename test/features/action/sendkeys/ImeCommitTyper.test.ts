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
  let userId: number | undefined = 10;
  let password = false;
  const host: ImeCommitTyperHost = {
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
        return { timestamp: timer.now() };
      },
    },
    imeTraceContext: { getStore: () => undefined },
    eventOnlyTyper: { clearEventOnlyForReplace: async () => ({ success: true }) },
    getImeUserId: () => userId,
    setImeUserId: (value) => {
      userId = value;
    },
    isCaretUnsafe: () => false,
    isPasswordField: () => password,
    setPasswordField: (value) => {
      password = value;
    },
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
  return {
    typer: new ImeCommitTyper(host, service, restoration),
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
    host.isCaretUnsafe = () => true;
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
      calls.push({ restoredUser: host.getImeUserId() });
    };
    expect(await typer.type({ text: "a", operation: "insert" })).toMatchObject({ success: true });
    expect(calls).toContainEqual({ restoredUser: 10 });
    expect(host.getImeUserId()).toBeUndefined();
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
});

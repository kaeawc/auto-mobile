import { TypingSession } from "../../../../src/features/action/sendkeys/TypingSession";
import type { EventAllTyperHost } from "../../../../src/features/action/sendkeys/EventAllTyper";
import type { EventLastTyperHost } from "../../../../src/features/action/sendkeys/EventLastTyper";
import type { ObserveResult } from "../../../../src/models";
import { buildAsciiKeyEventPlan } from "../../../../src/utils/android-cmdline-tools/asciiKeyEvents";
import { FakeTimer } from "../../../fakes/FakeTimer";

export function observation(text = "old"): ObserveResult {
  return {
    timestamp: 1,
    viewHierarchy: {
      hierarchy: { node: { $: { focused: "true", class: "android.widget.EditText", text } } },
    },
  };
}

export function eventHost() {
  const calls: unknown[] = [];
  const timer = new FakeTimer();
  const host: EventLastTyperHost & EventAllTyperHost = {
    session: new TypingSession(),
    preExistingFieldText: (_hierarchy, operation) => (operation === "replace" ? "" : "old"),
    markPartialAfterMutation: (result) =>
      result.success ? result : { ...result, partialApplication: true },
    hasFocusedPasswordField: () => false,
    graphemeCodePoints: (graphemes) =>
      graphemes
        .map((g) =>
          Array.from(
            g,
            (c) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
          ).join(" "),
        )
        .join(", "),
    markPartialAfterPriorMutation: (result, mutated) =>
      mutated && !result.success ? { ...result, partialApplication: true } : result,
    textClient: {
      replace: async (text) => {
        calls.push({ replace: text });
        return { success: true };
      },
      readInsertTextState: async () => ({ text: "old", selectionStart: 3, selectionEnd: 3 }),
    },
    timer,
    insertText: async (text, options, signal) => {
      calls.push({ insert: text, options, signal });
      return { success: true };
    },
    requireFocusedAndroidInput: async (signal, error, display) => {
      calls.push({ focus: display, signal, error });
      return { success: true, hierarchy: observation().viewHierarchy! };
    },
    readPrecedingState: async (needed) => {
      calls.push({ precedingState: needed });
      return needed ? { text: "old", selectionStart: 3, selectionEnd: 3 } : undefined;
    },
    executeKeyEventPlanSafely: async (plan, mutated, signal) => {
      calls.push({ plan, mutated, signal });
      return undefined;
    },
    withTextWarnings: (result, warnings) => {
      const combined = [...warnings, result.warning].filter(Boolean);
      return { ...result, ...(combined.length ? { warning: combined.join(" ") } : {}) };
    },
    verifyKeyEventLetterCase: async (text, result, mode, signal, display, before) => {
      calls.push({ verify: text, mode, signal, display, before });
      return result;
    },
    checkAbort: (signal, error) => {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
    },
    resetCaretState: () => {
      calls.push("resetCaretState");
    },
    getKeyEventPlan: async (char) => buildAsciiKeyEventPlan(char, true),
    getEventAllKeyEventPlan: async (char) =>
      char.length === 1 ? buildAsciiKeyEventPlan(char, true) : null,
    clearForReplace: async (operation, signal, display) => {
      calls.push({ clear: operation, signal, display });
      return { result: { success: true } };
    },
    readFocusedText: () => "old",
    readFreshObservation: async () => observation(),
  };
  return { host, timer, calls };
}

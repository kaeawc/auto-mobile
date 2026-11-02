import { expect, test } from "bun:test";
import { IosTyper, type IosTyperDeps } from "../../../../src/features/action/sendkeys/IosTyper";
import { TypingSession } from "../../../../src/features/action/sendkeys/TypingSession";
import { IOS_TEXT_CHUNK_CODE_POINTS } from "../../../../src/features/action/sendkeys/IosTextChunks";
import { IOS_FOCUSED_VALUE_READ_WINDOW } from "../../../../src/features/action/iosTypedTextVerification";
import { markPartialAfterMutation } from "../../../../src/features/action/sendkeys/ExecutorHelpers";
import { TextIndeterminateError } from "../../../../src/features/action/TextIndeterminateError";
import {
  resolveTextCtrlProxyTimeoutMs,
  runWithTextRequestContext,
} from "../../../../src/features/action/textTransportTimeout";
import type { TextActionResult } from "../../../../src/features/action/SendKeys";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { typedObservation } from "../IosTypedTextTestHarness";
import { DefaultElementParser } from "../../../../src/features/utility/ElementParser";
import { nodeAttributes } from "../../../../src/models/ViewHierarchyResult";

function harness() {
  const timer = new FakeTimer();
  const state = {
    value: "",
    reads: 0,
    clears: 0,
    failChunk: 0,
    failVerification: 0,
    secure: false,
  };
  const inserts: Array<{ text: string; options: Parameters<IosTyperDeps["insert"]>[1] }> = [];
  const observations: Array<Parameters<IosTyperDeps["observer"]["execute"]>[0]> = [];
  let failure: TextActionResult = { success: false, error: "runner refused", retryable: true };
  const deps: IosTyperDeps = {
    session: new TypingSession(),
    timer,
    targetLayer: () => undefined,
    observer: {
      execute: async (options) => {
        observations.push(options);
        state.reads++;
        return typedObservation(state.value, state.secure);
      },
    },
    clear: async () => {
      state.clears++;
      state.value = "";
      return { success: true };
    },
    insert: async (text, options) => {
      inserts.push({ text, options });
      if (inserts.length === state.failChunk) {
        return failure;
      }
      if (inserts.length !== state.failVerification) {
        state.value += text;
      }
      return { success: true };
    },
    withTextWarnings: (result, warnings) => {
      const warning = [...warnings, result.warning].filter(Boolean).join(" ");
      return { ...result, ...(warning ? { warning } : {}) };
    },
    markPartialAfterMutation,
  };
  return {
    deps,
    timer,
    state,
    inserts,
    observations,
    typer: new IosTyper(deps),
    setFailure: (value: TextActionResult) => {
      failure = value;
    },
  };
}

const longText = "a".repeat(3 * IOS_TEXT_CHUNK_CODE_POINTS + IOS_TEXT_CHUNK_CODE_POINTS / 2);

test("the first chunk replaces selected text and the remaining chunk is sent", async () => {
  const h = harness();
  h.state.value = "prefixSELECTEDsuffix";
  const text = "😀".repeat(1500);
  const insert = h.deps.insert;
  h.deps.insert = async (chunk, options) => {
    const result = await insert(chunk, options);
    if (h.inserts.length === 1) {
      h.state.value = `prefix${chunk}suffix`;
    }
    return result;
  };
  expect(await h.typer.executeIosType(text, "insert")).toEqual({
    success: true,
    resolvedMode: "xcuiTypeText",
  });
  expect(h.inserts.map(({ text: chunk }) => Array.from(chunk).length)).toEqual([1000, 500]);
  expect(h.inserts.map(({ text: chunk }) => chunk).join("")).toBe(text);
  expect(h.state.value).toBe(`prefix${"😀".repeat(1000)}suffix${"😀".repeat(500)}`);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test.each(["missing character", "altered prefix"])(
  "a first-chunk selection replacement with a %s still fails",
  async (mismatch) => {
    const h = harness();
    h.state.value = "prefixSELECTEDsuffix";
    const insert = h.deps.insert;
    h.deps.insert = async (chunk, options) => {
      const result = await insert(chunk, options);
      h.state.value =
        mismatch === "missing character" ? `prefix${chunk.slice(1)}suffix` : `Prefix${chunk}suffix`;
      return result;
    };
    const result = await h.typer.executeIosType("a".repeat(1500), "insert");
    expect(result.success).toBe(false);
    expect(result.error).toContain("not fully appended");
    expect(result.error).toContain("chunk 1 of 2 failed; 0 code points committed");
    expect(h.inserts).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  },
);

test("a later chunk replacing text still fails verification", async () => {
  const h = harness();
  h.state.value = "prefixSELECTEDsuffix";
  const insert = h.deps.insert;
  h.deps.insert = async (chunk, options) => {
    const before = h.state.value;
    const result = await insert(chunk, options);
    if (h.inserts.length === 2) {
      h.state.value = before.replace("SELECTED", chunk);
    }
    return result;
  };
  const result = await h.typer.executeIosType(longText, "insert");
  expect(result).toMatchObject({ success: false, partialApplication: true, retryable: false });
  expect(result.error).toContain("not fully appended");
  expect(result.error).toContain("chunk 2 of 4 failed; 1000 code points committed");
  expect(h.inserts).toHaveLength(2);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

for (const operation of ["insert", "replace"] as const) {
  test.each([2, 3])(
    `${operation} reports committed progress when chunk %s throws`,
    async (failed) => {
      const h = harness();
      const insert = h.deps.insert;
      let markedPartial = 0;
      h.deps.markPartialAfterMutation = (result) => {
        markedPartial++;
        return markPartialAfterMutation(result);
      };
      h.deps.insert = async (chunk, options) => {
        if (h.inserts.length + 1 === failed) {
          h.inserts.push({ text: chunk, options });
          throw new Error("page navigated during typing");
        }
        return insert(chunk, options);
      };
      const result = await h.typer.executeIosType(longText, operation);
      expect(result).toMatchObject({ success: false, partialApplication: true, retryable: false });
      expect(result.error).toBe(
        `page navigated during typing iOS chunk ${failed} of 4 failed; ${(failed - 1) * 1000} code points committed in fully successful chunks.`,
      );
      expect(h.inserts).toHaveLength(failed);
      expect(h.state.value).toBe("a".repeat((failed - 1) * 1000));
      expect(markedPartial).toBe(operation === "replace" ? 1 : 0);
      expect(h.timer.getSleepHistory()).toEqual([]);
    },
  );

  test(`${operation} still throws when the first chunk insert throws`, async () => {
    const h = harness();
    h.deps.insert = async (text, options) => {
      h.inserts.push({ text, options });
      throw new Error("first insert failed");
    };
    await expect(h.typer.executeIosType(longText, operation)).rejects.toThrow(
      "first insert failed",
    );
    expect(h.inserts).toHaveLength(1);
    expect(h.state.value).toBe("");
    expect(h.timer.getSleepHistory()).toEqual([]);
  });
}

test("single-chunk insert retains the transport warning", async () => {
  const h = harness();
  const insert = h.deps.insert;
  h.deps.insert = async (text, options) => ({ ...(await insert(text, options)), warning: "w" });
  expect((await h.typer.executeIosType("short", "insert")).warning).toBe("w");
});

test.each([false, true])(
  "focus moving to another field after chunk one stops before chunk two (secure=%s)",
  async (secure) => {
    const h = harness();
    h.state.secure = secure;
    const observe = h.deps.observer.execute;
    h.deps.observer.execute = async (options) => {
      const observation = await observe(options);
      const parser = new DefaultElementParser();
      for (const root of parser.extractRootNodes(observation.viewHierarchy!)) {
        parser.traverseNode(root, (node) => {
          const attributes = nodeAttributes(node);
          if (attributes.focused === "true") {
            attributes["resource-id"] = h.inserts.length === 0 ? "first" : "second";
            if (!secure && h.inserts.length > 0) {
              attributes.value = "another field's value";
            }
          }
        });
      }
      return observation;
    };
    const result = await h.typer.executeIosType(longText, "insert");
    expect(result).toMatchObject({ success: false, partialApplication: true, retryable: false });
    expect(result.error).toContain("focus moved to another field");
    expect(result.error).toContain("chunk 2 of 4 failed; 1000 code points committed");
    expect(h.inserts).toHaveLength(1);
    expect(h.state.reads).toBe(2);
  },
);

test("3500 code points append in four verified requests with one read per chunk", async () => {
  const h = harness();
  expect(await h.typer.executeIosType(longText, "insert")).toEqual({
    success: true,
    resolvedMode: "xcuiTypeText",
  });
  expect(h.inserts.map(({ text }) => Array.from(text).length)).toEqual([1000, 1000, 1000, 500]);
  expect(h.inserts.map(({ text }) => text).join("")).toBe(longText);
  expect(h.inserts.map(({ options }) => options?.timeoutMs)).toEqual(
    h.inserts.map(({ text }) => resolveTextCtrlProxyTimeoutMs(text)),
  );
  expect(h.state.reads).toBe(5);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("a partial repeated-character chunk stops further inserts", async () => {
  const h = harness();
  h.state.value = "x".repeat(100);
  const insert = h.deps.insert;
  h.deps.insert = async (text, options) => {
    const result = await insert(text, options);
    if (h.inserts.length === 2) {
      h.state.value = h.state.value.slice(0, -500);
    }
    return result;
  };
  const result = await h.typer.executeIosType(longText, "insert");
  expect(result).toMatchObject({ success: false, partialApplication: true, retryable: false });
  expect(result.error).toContain("not fully appended");
  expect(result.error).toContain("1000 code points committed");
  expect(h.inserts).toHaveLength(2);
});

test("chunk typing warns once when repeated values saturate the XCUI window", async () => {
  const h = harness();
  h.state.value = "a".repeat(IOS_FOCUSED_VALUE_READ_WINDOW);
  h.deps.observer.execute = async () =>
    typedObservation(h.state.value.slice(0, IOS_FOCUSED_VALUE_READ_WINDOW));
  const result = await h.typer.executeIosType(longText, "insert");
  expect(result.success).toBe(true);
  expect(result.warning).toContain("not verified");
  expect(result.warning).toBe(
    "iOS typed text result was not verified: the focused field value fills the 512-character read window, so a change past it cannot be seen.",
  );
  expect(h.inserts).toHaveLength(4);
});

test("chunk typing fails open when stable field identity is unavailable", async () => {
  const h = harness();
  h.deps.observer.execute = async () => ({
    ...typedObservation(h.state.value),
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            class: "UITextField",
            focused: "true",
            editable: "true",
            value: h.state.value,
          },
        },
      },
    },
  });
  expect((await h.typer.executeIosType(longText, "insert")).success).toBe(true);
  expect(h.inserts).toHaveLength(4);
});

test("bounds identify a focus change when resource ids are unavailable", async () => {
  const h = harness();
  h.deps.observer.execute = async () => ({
    ...typedObservation(h.state.value),
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            class: "UITextField",
            focused: "true",
            editable: "true",
            value: h.state.value,
            bounds: h.inserts.length === 0 ? "[0,10][100,100]" : "[200,10][300,100]",
          },
        },
      },
    },
  });
  const result = await h.typer.executeIosType(longText, "insert");
  expect(result.error).toContain("focus moved to another field");
  expect(result.error).toContain("1000 code points committed");
  expect(h.inserts).toHaveLength(1);
});

test("field growth and text-derived attributes do not change chunk target identity", async () => {
  const h = harness();
  h.deps.observer.execute = async () => ({
    ...typedObservation(h.state.value),
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            class: "UITextField",
            focused: "true",
            editable: "true",
            value: h.state.value,
            "resource-id": "field",
            "view-id": h.state.value,
            text: h.state.value,
            label: h.state.value,
            bounds: `[0,10][100,${100 + h.inserts.length * 10}]`,
          },
        },
      },
    },
  });
  expect((await h.typer.executeIosType(longText, "insert")).success).toBe(true);
  expect(h.inserts).toHaveLength(4);
});

test.each(["insert", "replace"] as const)(
  "%s abort before the first chunk still throws",
  async (operation) => {
    const h = harness();
    const controller = new AbortController();
    const observe = h.deps.observer.execute;
    h.deps.observer.execute = async (options) => {
      const result = await observe(options);
      controller.abort("cancelled before typing");
      return result;
    };
    await expect(h.typer.executeIosType(longText, operation, controller.signal)).rejects.toBe(
      "cancelled before typing",
    );
    expect(h.inserts).toHaveLength(0);
    expect(h.state.clears).toBe(operation === "replace" ? 1 : 0);
  },
);

test("verification chains the previous chunk's read and stops on unchanged chunk three", async () => {
  const h = harness();
  h.state.failVerification = 3;
  const result = await h.typer.executeIosType(longText, "insert");
  expect(result.success).toBe(false);
  expect(result.error).toContain("2000 code points committed");
  expect(result.error).toContain("chunk 3 of 4");
  expect(result.error).toContain("focused field value is unchanged");
  expect(h.inserts).toHaveLength(3);
  expect(h.state.reads).toBe(4);
});

test.each(["insert", "replace"] as const)(
  "%s stops on insert failure and reports only successful chunks",
  async (operation) => {
    const h = harness();
    h.state.failChunk = 3;
    const result = await h.typer.executeIosType(longText, operation);
    expect(result.success).toBe(false);
    expect(result.error).toContain("2000 code points committed");
    expect(result.error).toContain("chunk 3 of 4");
    expect(result.error).toContain("runner refused");
    expect(result.partialApplication).toBe(true);
    expect(result.retryable).toBe(false);
    expect(h.inserts).toHaveLength(3);
  },
);

test("indeterminate chunk preserves its diagnosis and cannot be retryable", async () => {
  const h = harness();
  h.state.failChunk = 3;
  h.setFailure({ success: false, error: new TextIndeterminateError("append timeout").message });
  const result = await h.typer.executeIosType(longText, "replace");
  expect(result.retryable).toBe(false);
  expect(result.partialApplication).toBe(true);
  expect(result.error).toContain("Text outcome is indeterminate:");
  expect(result.error).toContain("Observed afterwards:");
  expect(result.error).toContain("2000 code points committed");
  expect(result.error).toContain("chunk 3 of 4");
  expect(h.inserts).toHaveLength(3);
});

test.each(["insert", "replace"] as const)(
  "%s refuses oversized text before any clear, observe or insert",
  async (operation) => {
    const h = harness();
    h.state.value = "keep me";
    const result = await h.typer.executeIosType(
      "a".repeat(40 * IOS_TEXT_CHUNK_CODE_POINTS),
      operation,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("iOS nothing was typed:");
    expect(result.error).toContain("40000 code points would take about 720 s");
    expect(result.error).toContain("split the text");
    expect(result.error).toContain("setText / paste");
    expect(h.inserts).toEqual([]);
    expect(h.state).toMatchObject({ reads: 0, clears: 0, value: "keep me" });
  },
);

test("remaining request deadline refuses before preparation", async () => {
  const h = harness();
  const result = await runWithTextRequestContext({ getDeadlineMs: () => 60_000 }, () =>
    h.typer.executeIosType(longText, "replace"),
  );
  expect(result.success).toBe(false);
  expect(h.inserts).toEqual([]);
  expect(h.state).toMatchObject({ reads: 0, clears: 0 });
});

test("a 3500-code-point web assignment bypasses the chunked typing budget and inserts once", async () => {
  const h = harness();
  h.deps.willAssignWebValue = () => true;
  h.deps.assignsWebValue = () => h.state.clears === 1;
  const result = await runWithTextRequestContext({ getDeadlineMs: () => 60_000 }, () =>
    h.typer.executeIosType(longText, "replace"),
  );
  expect(result.success).toBe(true);
  expect(h.inserts.map(({ text }) => text)).toEqual([longText]);
  expect(h.state).toMatchObject({ clears: 1, reads: 2, value: longText });
});

test.each([true, false])(
  "post-clear budget uses elapsed time only for predicted web assignment=%s",
  async (predicted) => {
    const h = harness();
    h.deps.willAssignWebValue = () => predicted && h.state.clears === 0;
    h.deps.assignsWebValue = () => false;
    const clear = h.deps.clear;
    h.deps.clear = async () => {
      const result = await clear();
      h.timer.advanceTime(10_000);
      return { ...result, warning: "clear warning" };
    };
    const result = await runWithTextRequestContext({ getDeadlineMs: () => 90_000 }, () =>
      h.typer.executeIosType(longText, "replace"),
    );
    expect(result.success).toBe(!predicted);
    expect(result.warning).toBe("clear warning");
    expect(h.state.clears).toBe(1);
    if (predicted) {
      expect(result).toMatchObject({ partialApplication: true, retryable: false });
      expect(result.error).toContain("field was cleared and nothing was typed");
      expect(h.inserts).toEqual([]);
    } else {
      expect(h.inserts).toHaveLength(4);
    }
  },
);

test("a predicted web assignment that falls back within budget types all chunks", async () => {
  const h = harness();
  h.deps.willAssignWebValue = () => true;
  h.deps.assignsWebValue = () => false;
  const result = await runWithTextRequestContext({ getDeadlineMs: () => 120_000 }, () =>
    h.typer.executeIosType(longText, "replace"),
  );
  expect(result.success).toBe(true);
  expect(h.state).toMatchObject({ clears: 1, reads: 5, value: longText });
  expect(h.inserts.map(({ text }) => text.length)).toEqual([1000, 1000, 1000, 500]);
});

test.each(["short", "😀".repeat(IOS_TEXT_CHUNK_CODE_POINTS)])(
  "one chunk retains a single insert and verification",
  async (text) => {
    const h = harness();
    expect(await h.typer.executeIosType(text, "insert")).toEqual({
      success: true,
      resolvedMode: "xcuiTypeText",
      ...(text.length >= IOS_FOCUSED_VALUE_READ_WINDOW
        ? {
            warning:
              "iOS typed text result was not verified: the focused field value fills the 512-character read window, so a change past it cannot be seen.",
          }
        : {}),
    });
    expect(h.inserts).toEqual([
      { text, options: { timeoutMs: resolveTextCtrlProxyTimeoutMs(text), abortSignal: undefined } },
    ]);
    expect(h.state.reads).toBe(2);
    expect(h.timer.getSleepHistory()).toEqual([]);
  },
);

test("replace clears exactly once before the first chunk", async () => {
  const h = harness();
  h.state.value = "old";
  expect((await h.typer.executeIosType(longText, "replace")).success).toBe(true);
  expect(h.state.clears).toBe(1);
  expect(h.state.value).toBe(longText);
  expect(h.inserts).toHaveLength(4);
});

test("prototype short text retains its existing verification bypass", async () => {
  const h = harness();
  h.deps.targetLayer = () => "prototype";
  h.deps.insert = async () => ({ success: true, warning: "runner warning" });
  expect(await h.typer.executeIosType("short", "insert")).toEqual({
    success: true,
    warning: "runner warning",
    resolvedMode: "xcuiTypeText",
  });
  expect(h.state.reads).toBe(1);
});

test("prototype multi-chunk text verifies each chunk", async () => {
  const h = harness();
  h.deps.targetLayer = () => "prototype";
  expect((await h.typer.executeIosType(longText, "insert")).success).toBe(true);
  expect(h.state.reads).toBe(5);
});

test("replace verification failure retains partial mutation", async () => {
  const h = harness();
  h.state.failVerification = 3;
  const result = await h.typer.executeIosType(longText, "replace");
  expect(result).toMatchObject({ success: false, partialApplication: true });
  expect(result.error).toContain("2000 code points committed");
  expect(h.state.clears).toBe(1);
  expect(h.inserts).toHaveLength(3);
});

test("each chunk uses the remaining deadline, same signal and display", async () => {
  const h = harness();
  const controller = new AbortController();
  const insert = h.deps.insert;
  h.deps.insert = async (text, options) => {
    const result = await insert(text, options);
    h.timer.advanceTime(17_000);
    return result;
  };
  const deadline = 85_000;
  const result = await runWithTextRequestContext({ getDeadlineMs: () => deadline }, () =>
    h.typer.executeIosType(longText, "insert", controller.signal, "2"),
  );
  expect(result.success).toBe(true);
  expect(h.inserts.map(({ options }) => options?.timeoutMs)).toEqual([
    84_000, 67_000, 50_000, 33_000,
  ]);
  expect(
    h.inserts.every(
      ({ options }) => options?.deadlineMs === 84_000 && options.abortSignal === controller.signal,
    ),
  ).toBe(true);
  expect(h.observations.every((options) => options?.display === "2")).toBe(true);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("abort between chunks reports committed text and dispatches no later append", async () => {
  const h = harness();
  const controller = new AbortController();
  const insert = h.deps.insert;
  h.deps.insert = async (text, options) => {
    const result = await insert(text, options);
    if (h.inserts.length === 2) {
      controller.abort(new Error("caller cancelled"));
    }
    return result;
  };
  const result = await h.typer.executeIosType(longText, "insert", controller.signal);
  expect(result).toMatchObject({ success: false, partialApplication: true, retryable: false });
  expect(result.error).toBe(
    "caller cancelled iOS chunk 3 of 4 failed; 2000 code points committed in fully successful chunks.",
  );
  expect(h.inserts).toHaveLength(2);
});

test("clear and insert warnings are retained once, alongside verification warnings", async () => {
  const h = harness();
  h.state.secure = true;
  h.deps.clear = async () => ({ success: true, warning: "clear warning" });
  const insert = h.deps.insert;
  h.deps.insert = async (text, options) => ({
    ...(await insert(text, options)),
    warning: "insert warning",
  });
  const result = await h.typer.executeIosType(longText, "replace");
  expect(result.warning).toBe(
    "clear warning insert warning iOS typed text check skipped for a secure field.",
  );
});

test("secure verification warnings across chunks are deduplicated", async () => {
  const h = harness();
  h.state.secure = true;
  const result = await h.typer.executeIosType(longText, "insert");
  expect(result).toEqual({
    success: true,
    resolvedMode: "xcuiTypeText",
    warning: "iOS typed text check skipped for a secure field.",
  });
  expect(h.state.reads).toBe(5);
  expect(h.inserts).toHaveLength(4);
});

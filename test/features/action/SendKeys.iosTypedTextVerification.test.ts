import { FakeTimer } from "../../fakes/FakeTimer";
import { DefaultSendKeysCommandExecutor } from "../../../src/features/action/SendKeys";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import {
  compareIosTypedText,
  IOS_FOCUSED_VALUE_READ_WINDOW,
} from "../../../src/features/action/iosTypedTextVerification";
import { expect, test } from "bun:test";
import {
  typedObservation,
  unfocusedObservation,
  unfocusedNativeInputObservation,
} from "./IosTypedTextTestHarness";
import { createSendKeysHarness, ios } from "./SendKeysTestHarness";
import type { ObserveResult } from "../../../src/models";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";

const noFocusPrefix = "iOS nothing was typed: no text field has focus.";

test.each([
  { text: "abc", before: "prefixSELECTEDsuffix", after: "prefixabcsuffix" },
  { text: "abc", before: "SELECTEDsuffix", after: "abcsuffix" },
  { text: "abc", before: "prefixSELECTED", after: "prefixabc" },
  { text: "abc", before: "SELECTED", after: "abc" },
  { text: "abc", before: "abcSELECTEDsuffix", after: "abcabcsuffix" },
  { text: "😀", before: "prefixSELECTEDsuffix", after: "prefix😀suffix" },
])(
  "only the first chunk accepts a selected range replacement ($before)",
  ({ text, before, after }) => {
    const previous = { secure: false, value: before };
    const current = { secure: false, value: after };
    expect(
      compareIosTypedText(text, previous, current, { verifyAppend: true, firstChunk: true }),
    ).toEqual({
      success: true,
    });
    expect(
      compareIosTypedText(text, previous, current, { verifyAppend: true, firstChunk: false })
        .success,
    ).toBe(false);
    expect(compareIosTypedText(text, previous, current, true).success).toBe(false);
  },
);

test("first-chunk replacement must retain the full chunk and surrounding text", () => {
  const before = { secure: false, value: "prefixSELECTEDsuffix" };
  for (const value of [
    "prefixabsuffix",
    "Prefixabcsuffix",
    "prefixabcSuffix",
    "prefix!abcsuffix",
  ]) {
    expect(
      compareIosTypedText(
        "abc",
        before,
        { secure: false, value },
        { verifyAppend: true, firstChunk: true },
      ).success,
    ).toBe(false);
  }
});

test.each([false, true])(
  "unchanged chunk values still report nothing typed (first=%s)",
  (firstChunk) => {
    const field = { secure: false, value: "prefixabcsuffix" };
    expect(compareIosTypedText("abc", field, field, { verifyAppend: true, firstChunk })).toEqual({
      success: false,
      error: "iOS nothing was typed: the focused field value is unchanged.",
    });
  },
);

test("native editable snapshots share the first-chunk-only replacement check", () => {
  const before = {
    secure: false,
    value: "web",
    nativeEditableValues: { field: "prefixSELECTEDsuffix" },
  };
  const after = { secure: false, value: "web", nativeEditableValues: { field: "prefixabcsuffix" } };
  expect(
    compareIosTypedText("abc", before, after, { verifyAppend: true, firstChunk: true }),
  ).toEqual({ success: true });
  expect(
    compareIosTypedText("abc", before, after, { verifyAppend: true, firstChunk: false }).success,
  ).toBe(false);
  expect(compareIosTypedText("abc", before, after, true).success).toBe(false);
});

test("chunk verification rejects a partial repeated-character append despite an existing prefix", () => {
  const before = "x".repeat(100) + "a".repeat(1000);
  const result = compareIosTypedText(
    "a".repeat(1000),
    { secure: false, value: before },
    { secure: false, value: before + "a".repeat(500) },
    true,
  );
  expect(result.success).toBe(false);
  expect(result.error).toContain("not fully appended");
});

test("chunk verification accepts a full repeated-character append", () => {
  const before = "x".repeat(100) + "a".repeat(1000);
  const chunk = "a".repeat(1000);
  expect(
    compareIosTypedText(
      chunk,
      { secure: false, value: before },
      { secure: false, value: before + chunk },
      true,
    ),
  ).toEqual({ success: true });
});

test.each(["a", "x"])("chunk verification warns for a saturated XCUI value window (%s)", (last) => {
  const result = compareIosTypedText(
    "a".repeat(1000),
    { secure: false, value: "a".repeat(IOS_FOCUSED_VALUE_READ_WINDOW) },
    { secure: false, value: last.repeat(IOS_FOCUSED_VALUE_READ_WINDOW) },
    true,
  );
  expect(result.success).toBe(true);
  expect(result.warning).toContain("not verified");
  expect(result.warning).toBe(
    "iOS typed text result was not verified: the focused field value fills the 512-character read window, so a change past it cannot be seen.",
  );
});

test("the chunk that first fills the read window uses the single-shot warning once", () => {
  const before = { secure: false, value: "old" };
  const after = { secure: false, value: "a".repeat(IOS_FOCUSED_VALUE_READ_WINDOW) };
  const chunk = "a".repeat(1000);
  const singleShot = compareIosTypedText(chunk, before, after);
  expect(singleShot.success).toBe(true);
  expect(singleShot.warning).toContain("512-character read window");
  expect(compareIosTypedText(chunk, before, after, true)).toEqual(singleShot);
});

test("readable chunk verification requires exactly the inserted chunk and preserves existing text", () => {
  const before = { secure: false, value: "old" };
  for (const value of ["oldab", "oldxyz", "old!abc", "NEWabc"]) {
    expect(compareIosTypedText("abc", before, { secure: false, value }, true)).toEqual({
      success: false,
      error: "iOS typed text chunk was not fully appended to the focused field.",
    });
  }
  expect(compareIosTypedText("abc", before, { secure: false, value: "oldabc" }, true)).toEqual({
    success: true,
  });
});

test.each([
  { text: "a", before: "abac", after: "abaca" },
  { text: "abc", before: "abcab", after: "abcabcab" },
  { text: "😀", before: "😀x", after: "😀😀x" },
])(
  "chunk insertion verification handles repeated occurrences for $text",
  ({ text, before, after }) => {
    expect(
      compareIosTypedText(
        text,
        { secure: false, value: before },
        { secure: false, value: after },
        true,
      ),
    ).toEqual({ success: true });
  },
);

for (const operation of ["insert", "replace"] as const) {
  const name = operation === "insert" ? "append" : operation;
  test(`iOS ${name} refuses to insert when no field or keyboard has focus`, async () => {
    const h = createSendKeysHarness(ios, { execute: async () => unfocusedObservation() });
    const result = await h.executor.type({ action: "type", text: "hello", operation });
    expect(result.success).toBe(false);
    expect(result.error?.startsWith(noFocusPrefix)).toBe(true);
    expect(result.error).toContain("tapOn");
    expect(result.warning).toBeUndefined();
    expect(h.inserted).toEqual([]);
  });

  test(`iOS ${name} refuses an unfocused native input with the keyboard dismissed`, async () => {
    let reads = 0;
    const observation = unfocusedNativeInputObservation();
    const h = createSendKeysHarness(ios, {
      execute: async () => {
        reads++;
        return observation;
      },
    });
    const result = await h.executor.type({ action: "type", text: "hello", operation });
    expect(result.success).toBe(false);
    expect(result.error?.startsWith(noFocusPrefix)).toBe(true);
    expect(h.inserted).toEqual([]);
    expect(reads).toBe(operation === "replace" ? 3 : 1);
  });

  test(`iOS ${name} keeps dispatching without readable focus when the keyboard is visible`, async () => {
    const h = createSendKeysHarness(ios, { execute: async () => unfocusedObservation(true) });
    const result = await h.executor.type({ action: "type", text: "hello", operation });
    expect(result.success).toBe(true);
    expect(h.inserted).toEqual(["hello"]);
    expect(result.warning).toContain("focused field could not be read");
  });
}

for (const unavailable of ["rejected", "stale", "hierarchy error", "missing hierarchy"] as const) {
  test(`iOS dispatches when the focus read is ${unavailable}`, async () => {
    const observation = unfocusedObservation();
    if (unavailable === "stale") {
      observation.freshness = { isFresh: false };
    } else if (unavailable === "hierarchy error") {
      observation.viewHierarchy!.hierarchy.error = "Hierarchy unavailable";
    } else if (unavailable === "missing hierarchy") {
      observation.viewHierarchy = undefined;
    }
    const h = createSendKeysHarness(ios, {
      execute: async () => {
        if (unavailable === "rejected") {
          throw new Error("Observer unavailable");
        }
        return observation;
      },
    });
    const result = await h.executor.type({ action: "type", text: "hello" });
    expect(result.success).toBe(true);
    expect(h.inserted).toEqual(["hello"]);
    expect(result.error).toBeUndefined();
    expect(result.warning).toContain("focused field could not be read");
  });
}

const cases = [
  { name: "unchanged", before: "old", after: "old", success: false, error: "nothing was typed" },
  { name: "masked", before: "", after: "(123) 456", success: true },
  { name: "truncated", before: "", after: "123", success: true, warning: '"123"' },
  { name: "autocorrected", before: "", after: "changed", success: true, warning: '"changed"' },
  { name: "unreadable", before: "", after: undefined, success: true, warning: "not verified" },
  {
    name: "secure",
    before: "secret",
    after: "secret",
    secure: true,
    success: true,
    warning: "skipped",
  },
];
for (const row of cases) {
  test(`iOS typing verification: ${row.name}`, async () => {
    const reads: ObserveScreenExecuteOptions[] = [];
    const h = createSendKeysHarness(ios, {
      execute: async (options = {}) => {
        reads.push(options);
        if (reads.length === 1) {
          return typedObservation(row.before, row.secure);
        }
        if (row.after === undefined) {
          throw new Error("No hierarchy");
        }
        return typedObservation(row.after);
      },
    });
    const result = await h.executor.type({ action: "type", text: "123456" });
    expect(result.success).toBe(row.success);
    if (row.error) {
      expect(result.error).toContain(row.error);
    }
    if (row.warning) {
      expect(result.warning).toContain(row.warning);
    } else {
      expect(result.warning).toBeUndefined();
    }
    expect(reads).toHaveLength(row.secure ? 1 : 2);
    expect(reads.every((options) => options.skipScreenshot && options.freshness === "fresh")).toBe(
      true,
    );
    if (row.secure) {
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
}

test("iOS runner failure stays unchanged and skips the post-type read", async () => {
  let reads = 0;
  const h = createSendKeysHarness(ios, {
    execute: async () => {
      reads++;
      return typedObservation("");
    },
  });
  h.client.insert = async () => ({ success: false, error: "runner refused", retryable: false });
  expect(await h.executor.type({ action: "type", text: "123456" })).toMatchObject({
    success: false,
    error: "runner refused",
    retryable: false,
  });
  expect(reads).toBe(1);
});

test("replacement compares against the field after clearing", async () => {
  let value = "123456";
  const h = createSendKeysHarness(ios, { execute: async () => typedObservation(value) });
  h.client.clear = async () => {
    value = "";
    return { success: true };
  };
  h.client.insert = async (text) => {
    value = text;
    return { success: true };
  };
  expect(
    await h.executor.type({ action: "type", text: "123456", operation: "replace" }),
  ).toMatchObject({ success: true });
});

test("iOS executor exposes partial application and refuses replay after committed chunks", async () => {
  let value = "";
  let inserts = 0;
  const h = createSendKeysHarness(ios, { execute: async () => typedObservation(value) });
  h.client.insert = async (text) => {
    if (++inserts === 3) {
      return { success: false, error: "runner refused", retryable: true };
    }
    value += text;
    return { success: true };
  };
  const result = await h.executor.type({ action: "type", text: "a".repeat(3500) });
  expect(result).toMatchObject({ success: false, partialApplication: true, retryable: false });
  expect(result.error).toContain("chunk 3 of 4");
  expect(result.error).toContain("2000 code points committed");
  expect(value).toBe("a".repeat(2000));
  expect(inserts).toBe(3);
});

test("literal subsequence preserves case, punctuation, repeated characters and Unicode", () => {
  const before = { value: "", secure: false };
  for (const [text, value] of [
    ["Ab", "ab"],
    ["a!", "a"],
    ["aa", "a"],
    ["😀", "😁"],
  ]) {
    expect(compareIosTypedText(text!, before, { value, secure: false }).warning).toContain(
      JSON.stringify(value),
    );
  }
  expect(compareIosTypedText("😀a", before, { value: "😀-a", secure: false })).toEqual({
    success: true,
  });
});

test("an exhausted read-back deadline preserves confirmed typing without starting a read", async () => {
  const timer = new FakeTimer();
  let reads = 0;
  const observer = {
    execute: async () => {
      reads++;
      return typedObservation("");
    },
  };
  const h = createSendKeysHarness(ios, observer);
  h.client.insert = async () => {
    timer.advanceTime(100);
    return { success: true };
  };
  const executor = new DefaultSendKeysCommandExecutor(ios, h.adbFactory, observer, {
    timer,
    textClient: h.client,
  });
  const result = await runWithTextRequestContext({ getDeadlineMs: () => 1100 }, () =>
    executor.type({ action: "type", text: "123456" }),
  );
  expect(result).toMatchObject({ success: true });
  expect(result.warning).toContain("not verified");
  expect(reads).toBe(1);
});

test("a hanging read-back is bounded by the request deadline", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  let reads = 0;
  const observer = {
    execute: async () => {
      reads++;
      return reads === 1 ? typedObservation("") : new Promise<ObserveResult>(() => {});
    },
  };
  const h = createSendKeysHarness(ios, observer);
  const executor = new DefaultSendKeysCommandExecutor(ios, h.adbFactory, observer, {
    timer,
    textClient: h.client,
  });
  const result = await runWithTextRequestContext({ getDeadlineMs: () => timer.now() + 1100 }, () =>
    executor.type({ action: "type", text: "123456" }),
  );
  expect(result).toMatchObject({ success: true });
  expect(result.warning).toContain("not verified");
  expect(reads).toBe(2);
});

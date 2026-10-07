import { FakeTimer } from "../../fakes/FakeTimer";
import { DefaultSendKeysCommandExecutor } from "../../../src/features/action/SendKeys";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import { compareIosTypedText } from "../../../src/features/action/iosTypedTextVerification";
import { expect, test } from "bun:test";
import { typedObservation } from "./IosTypedTextTestHarness";
import { createSendKeysHarness, ios } from "./SendKeysTestHarness";
import type { ObserveResult } from "../../../src/models";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";

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

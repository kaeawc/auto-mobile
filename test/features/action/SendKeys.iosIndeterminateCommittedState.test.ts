import { expect, test } from "bun:test";
import { typedObservation } from "./IosTypedTextTestHarness";
import { createSendKeysHarness, ios } from "./SendKeysTestHarness";
import { TextIndeterminateError } from "../../../src/features/action/TextIndeterminateError";
import { describeIosCommittedText } from "../../../src/features/action/iosTypedTextVerification";
import type { ObserveResult } from "../../../src/models";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";

const indeterminate = new TextIndeterminateError("Set text timed out after 5000ms").message;

function harness(after: (() => Promise<ObserveResult>) | undefined, before = "") {
  const reads: ObserveScreenExecuteOptions[] = [];
  const h = createSendKeysHarness(ios, {
    execute: async (options = {}) => {
      reads.push(options);
      return reads.length === 1 ? typedObservation(before) : after!();
    },
  });
  h.client.insert = async () => ({ success: false, error: indeterminate, retryable: false });
  return { h, reads };
}

test("indeterminate iOS typing reports an unchanged field and stays non-retryable", async () => {
  const { h, reads } = harness(async () => typedObservation(""));
  const result = await h.executor.type({ action: "type", text: "alice" });
  expect(result).toMatchObject({ success: false, retryable: false });
  expect(result.error).toContain("Text outcome is indeterminate");
  expect(result.error).toContain("value is unchanged");
  expect(reads).toHaveLength(2);
});

test("indeterminate iOS typing reports typed characters that did land", async () => {
  const { h } = harness(async () => typedObservation("alice"));
  const result = await h.executor.type({ action: "type", text: "alice" });
  expect(result.error).toContain("now contains the typed characters");
  expect(result.retryable).toBe(false);
});

test("indeterminate iOS typing reports a partial or altered value", async () => {
  const { h } = harness(async () => typedObservation("ali"));
  const result = await h.executor.type({ action: "type", text: "alice" });
  expect(result.error).toContain('changed to "ali"');
});

test("indeterminate iOS typing says what is unknown when the field cannot be read", async () => {
  const { h } = harness(async () => {
    throw new Error("No hierarchy");
  });
  const result = await h.executor.type({ action: "type", text: "alice" });
  expect(result.error).toContain("could not be read");
  expect(result.error).toContain("Text outcome is indeterminate");
});

test("the post-timeout read is bounded without a request deadline", async () => {
  const { h, reads } = harness(async () => typedObservation(""));
  await h.executor.type({ action: "type", text: "alice" });
  expect(reads[1]?.timeoutMs).toBeLessThanOrEqual(2000);
  expect(reads[1]?.freshness).toBe("fresh");
  expect(reads[1]?.skipScreenshot).toBe(true);
});

test("a hanging post-timeout read still returns the typed indeterminate error", async () => {
  const { h } = harness(() => new Promise<ObserveResult>(() => {}));
  const result = await h.executor.type({ action: "type", text: "alice" });
  expect(result).toMatchObject({ success: false, retryable: false });
  expect(result.error).toContain("could not be read");
});

test("a secure field is never echoed", () => {
  expect(
    describeIosCommittedText("hunter2", { value: "x", secure: false }, { secure: true }),
  ).not.toContain("hunter2");
  expect(describeIosCommittedText("x", { secure: false }, { secure: true })).toContain("secure");
});

test("a changed native editable that is not the focused field is reported", () => {
  const text = describeIosCommittedText(
    "alice",
    { value: "", secure: false, nativeEditableValues: { to: "" } },
    { value: "", secure: false, nativeEditableValues: { to: "alice" } },
  );
  expect(text).toContain("another editable");
});

test("a runner refusal that is not indeterminate is not rewritten or re-read", async () => {
  const { h, reads } = harness(async () => typedObservation(""));
  h.client.insert = async () => ({ success: false, error: "runner refused", retryable: false });
  const result = await h.executor.type({ action: "type", text: "alice" });
  expect(result.error).toBe("runner refused");
  expect(reads).toHaveLength(1);
});

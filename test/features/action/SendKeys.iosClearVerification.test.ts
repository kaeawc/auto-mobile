import { expect, test } from "bun:test";
import { DefaultSendKeysCommandExecutor, SendKeys } from "../../../src/features/action/SendKeys";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import type { ObserveScreenExecuteOptions } from "../../../src/features/observe/interfaces/ObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { typedObservation } from "./IosTypedTextTestHarness";
import { createSendKeysHarness, ios } from "./SendKeysTestHarness";

function harness(initial = "", secure = false) {
  let value = initial;
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const reads: ObserveScreenExecuteOptions[] = [];
  const calls: string[] = [];
  const observer = {
    execute: async (options: ObserveScreenExecuteOptions = {}) => {
      reads.push(options);
      return typedObservation(value, secure);
    },
  };
  const h = createSendKeysHarness(ios, observer);
  h.client.clear = async () => {
    calls.push("clear");
    value = "";
    return { success: true };
  };
  h.client.insert = async (text) => {
    calls.push(`insert:${text}`);
    value += text;
    return { success: true };
  };
  const executor = new DefaultSendKeysCommandExecutor(ios, h.adbFactory, observer, {
    timer,
    textClient: h.client,
  });
  const action = new SendKeys(ios, h.adbFactory, {
    timer,
    executor,
    observer: { execute: async () => typedObservation("") },
    timestampProvider: { now: async () => 1 },
  });
  return {
    ...h,
    executor,
    action,
    observer,
    timer,
    reads,
    calls,
    get value() {
      return value;
    },
    set value(text: string) {
      value = text;
    },
  };
}

function deleteLast(h: ReturnType<typeof harness>) {
  h.client.clear = async () => {
    h.calls.push("clear");
    h.value = h.value.slice(0, -1);
    return { success: true };
  };
}

test("#11949: three acknowledged partial clears stop the batch before typing", async () => {
  const h = harness(":son");
  deleteLast(h);
  const result = await h.action.execute([{ action: "clear" }, { action: "type", text: ":sonr" }]);
  expect(result).toMatchObject({ success: false, failedIndex: 0 });
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]).toMatchObject({
    success: false,
    error: expect.stringContaining('remaining value: ":"'),
  });
  expect(h.calls).toEqual(["clear", "clear", "clear"]);
  expect(h.value).toBe(":");
  expect(h.timer.getSleepHistory()).toEqual([100, 200]);
});

test("popup reinsertion is read after acknowledgement and typing follows the verified retry", async () => {
  const h = harness(":son");
  h.client.clear = async () => {
    h.calls.push("clear");
    h.value = h.calls.length === 1 ? ":so" : "";
    return { success: true };
  };
  const result = await h.action.execute([{ action: "clear" }, { action: "type", text: ":sonr" }]);
  expect(result.success).toBe(true);
  expect(result.commands[0]).toMatchObject({ success: true });
  expect(result.commands[0]?.warning).toBeUndefined();
  expect(h.calls).toEqual(["clear", "clear", "insert::sonr"]);
  expect(h.value).toBe(":sonr");
  expect(h.timer.getSleepHistory()).toEqual([100]);
});

test("empty clear needs one fresh hierarchy-only read and no retry", async () => {
  const h = harness("old");
  expect(await h.executor.clear(undefined, "main")).toEqual({ success: true });
  expect(h.calls).toEqual(["clear"]);
  expect(h.reads).toHaveLength(1);
  expect(h.reads[0]).toMatchObject({
    freshness: "fresh",
    skipScreenshot: true,
    skipAccessibilityAudit: true,
    display: "main",
  });
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("placeholder value is blank after clearing", async () => {
  const h = harness();
  h.client.clear = async () => {
    h.calls.push("clear");
    h.value = "Email";
    return { success: true };
  };
  expect(await h.executor.clear()).toEqual({ success: true });
  expect(h.calls).toEqual(["clear"]);
});

test("unchanged mask settles after one retry with remaining-value evidence", async () => {
  const h = harness("$0.00");
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  const result = await h.executor.clear();
  expect(result.success).toBe(true);
  expect(result.warning).toContain('The field still holds "$0.00"');
  expect(result.warning).toContain("mask or permanent prefix");
  expect(h.calls).toEqual(["clear", "clear"]);
});

test("secure clear skips verification without reading or exposing its value", async () => {
  const h = harness("secret-value", true);
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  const result = await h.executor.clear();
  expect(result).toEqual({ success: true, warning: "iOS clear check skipped for a secure field." });
  expect(JSON.stringify(result)).not.toContain("secret-value");
  expect(h.calls).toEqual(["clear"]);
  expect(h.reads).toHaveLength(1);
});

test("unreadable observation preserves acknowledgement with an explicit warning", async () => {
  const h = harness();
  h.observer.execute = async () => {
    throw new Error("No hierarchy");
  };
  expect(await h.executor.clear()).toEqual({
    success: true,
    warning: "iOS clear was not verified: the focused field could not be read.",
  });
  expect(h.calls).toEqual(["clear"]);
});

test("runner clear failure is returned unchanged without observation", async () => {
  const h = harness();
  const failure = { success: false, error: "runner refused", retryable: false };
  h.client.clear = async () => failure;
  expect(await h.executor.clear()).toBe(failure);
  expect(h.reads).toEqual([]);
});

test("runner retry failure is returned without further read or mutation", async () => {
  const h = harness("old");
  const failure = { success: false, error: "retry refused", retryable: false };
  h.client.clear = async () => {
    h.calls.push("clear");
    return h.calls.length === 1 ? { success: true } : failure;
  };
  expect(await h.executor.clear()).toBe(failure);
  expect(h.calls).toEqual(["clear", "clear"]);
  expect(h.reads).toHaveLength(1);
});

test("abort while sleeping propagates without another clear", async () => {
  const h = harness(":son");
  deleteLast(h);
  const controller = new AbortController();
  const reason = new Error("cancel clear");
  h.timer.setTimeout(() => controller.abort(reason), 50);
  await expect(h.executor.clear(controller.signal)).rejects.toBe(reason);
  expect(h.calls).toEqual(["clear"]);
  expect(h.timer.getSleepHistory()).toEqual([100]);
});

test("deadline that cannot cover backoff returns remaining value without sleeping", async () => {
  const h = harness(":son");
  deleteLast(h);
  const deadline = h.timer.now() + 1050;
  const result = await runWithTextRequestContext({ getDeadlineMs: () => deadline }, () =>
    h.executor.clear(),
  );
  expect(result).toEqual({
    success: false,
    error: 'iOS clear left text in the focused field after 1 attempt(s); remaining value: ":so".',
  });
  expect(h.calls).toEqual(["clear"]);
  expect(h.timer.getSleepHistory()).toEqual([]);
});

test("replacement does not insert after clear attempts leave changing text", async () => {
  const h = harness(":son");
  deleteLast(h);
  expect(
    await h.executor.type({ action: "type", text: ":sonr", operation: "replace" }),
  ).toMatchObject({
    success: false,
    resolvedMode: "xcuiTypeText",
    error: expect.stringContaining('remaining value: ":"'),
  });
  expect(h.calls).toEqual(["clear", "clear", "clear"]);
});

test("replacement preserves both clear and typed verification warnings", async () => {
  const h = harness("$0.00");
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  h.client.insert = async () => {
    h.calls.push("insert");
    h.value = "$1";
    return { success: true };
  };
  const result = await h.executor.type({ action: "type", text: "123", operation: "replace" });
  expect(result.success).toBe(true);
  expect(result.warning).toContain('The field still holds "$0.00"');
  expect(result.warning).toContain('observed value: "$1"');
  expect(h.calls).toEqual(["clear", "clear", "insert"]);
});

test("replacement compares against the emptied field even when replacing identical text", async () => {
  const h = harness("same");
  const result = await h.executor.type({ action: "type", text: "same", operation: "replace" });
  expect(result).toMatchObject({ success: true, resolvedMode: "xcuiTypeText" });
  expect(result.warning).toBeUndefined();
  expect(h.calls).toEqual(["clear", "insert:same"]);
});

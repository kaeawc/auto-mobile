import { expect, spyOn, test } from "bun:test";
import { getFocusedTextField } from "../../../src/features/action/ClearText";
import { DefaultSendKeysCommandExecutor, SendKeys } from "../../../src/features/action/SendKeys";
import { runWithTextRequestContext } from "../../../src/features/action/textTransportTimeout";
import { logger } from "../../../src/utils/logger";
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

test("#12023: replacement fails when two acknowledged clears remove nothing", async () => {
  const h = harness("old value");
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  const result = await h.action.execute([{ action: "type", text: "new", operation: "replace" }]);
  expect(result).toMatchObject({ success: false, failedIndex: 0 });
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]?.error).toContain("removed nothing");
  expect(result.commands[0]).toMatchObject({
    success: false,
    error: expect.stringContaining('remaining value: "old value"'),
  });
  expect(result.commands[0]).not.toHaveProperty("partialApplication");
  expect(h.calls).toEqual(["clear", "clear"]);
  expect(h.value).toBe("old value");
  expect(h.timer.getSleepHistory()).toEqual([100]);
});

test.each([
  { initial: "old value", text: "new" },
  { initial: ":son", text: ":sonr" },
])("#12023: untouched clear stops the batch for $initial", async ({ initial, text }) => {
  const h = harness(initial);
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  const result = await h.action.execute([{ action: "clear" }, { action: "type", text }]);
  expect(result).toMatchObject({ success: false, failedIndex: 0 });
  expect(result.commands).toHaveLength(1);
  expect(result.commands[0]).toMatchObject({
    success: false,
    error: expect.stringContaining(`remaining value: ${JSON.stringify(initial)}`),
  });
  expect(result.commands[0]).not.toHaveProperty("partialApplication");
  expect(h.calls).toEqual(["clear", "clear"]);
  expect(h.value).toBe(initial);
  expect(h.timer.getSleepHistory()).toEqual([100]);
});

test("#12023: split-call clear fails before a separately requested type", async () => {
  const h = harness("old value");
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  const cleared = await h.action.execute([{ action: "clear" }]);
  expect(cleared).toMatchObject({ success: false, failedIndex: 0 });
  expect(cleared.commands).toHaveLength(1);
  expect(cleared.commands[0]?.error).toContain('remaining value: "old value"');
  expect(cleared.commands[0]).not.toHaveProperty("partialApplication");
  expect(h.calls).toEqual(["clear", "clear"]);
  expect(h.value).toBe("old value");
  const typed = await h.action.execute([{ action: "type", text: "new" }]);
  expect(typed.success).toBe(true);
  expect(typed.commands).toHaveLength(1);
  expect(cleared.commands).toHaveLength(1);
  expect(cleared.success).toBe(false);
  expect(h.calls).toEqual(["clear", "clear", "insert:new"]);
});

test.each(["old value", "$0.00"])(
  "#12023: standalone clear fails for an untouched pre-clear value %s",
  async (initial) => {
    const h = harness(initial);
    h.client.clear = async () => {
      h.calls.push("clear");
      return { success: true };
    };
    const result = await h.executor.clear();
    expect(result).toEqual({
      success: false,
      error: expect.stringContaining(`remaining value: ${JSON.stringify(initial)}`),
    });
    expect(result.error).toContain("removed nothing");
    expect(h.calls).toEqual(["clear", "clear"]);
    expect(h.value).toBe(initial);
    expect(h.timer.getSleepHistory()).toEqual([100]);
  },
);

test("#12023: untouched first clear succeeds when the retry empties the field", async () => {
  const h = harness("old value");
  h.client.clear = async () => {
    h.calls.push("clear");
    if (h.calls.length === 2) {
      h.value = "";
    }
    return { success: true };
  };
  expect(await h.executor.clear()).toEqual({ success: true });
  expect(h.calls).toEqual(["clear", "clear"]);
  expect(h.value).toBe("");
  expect(h.timer.getSleepHistory()).toEqual([100]);
});

test.each(["", "Email"])(
  "#12023: a pre-clear blank or placeholder %j stays successful",
  async (initial) => {
    const h = harness(initial);
    h.client.clear = async () => {
      h.calls.push("clear");
      return { success: true };
    };
    expect(await h.executor.clear()).toEqual({ success: true });
    expect(h.calls).toEqual(["clear"]);
    expect(h.timer.getSleepHistory()).toEqual([]);
  },
);

test("#12023: a failed pre-read warns without values and preserves legacy verification", async () => {
  const h = harness("old");
  const observe = h.observer.execute;
  let reads = 0;
  h.observer.execute = async (options) => {
    if (++reads === 1) {
      throw new Error("transport could expose old");
    }
    return observe(options);
  };
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const result = await h.executor.clear();
    expect(result.success).toBe(true);
    expect(result.warning).toContain("mask or permanent prefix");
    expect(h.calls).toEqual(["clear", "clear"]);
    expect(h.value).toBe("old");
    expect(reads).toBe(3);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("old");
  } finally {
    warn.mockRestore();
  }
});

test.each(["stale", "no hierarchy", "omitted value"])(
  "#12023: unavailable pre-clear %s falls back with a value-free warning",
  async (kind) => {
    const h = harness("old");
    const observe = h.observer.execute;
    let reads = 0;
    h.observer.execute = async (options) => {
      if (++reads !== 1) {
        return observe(options);
      }
      const observation = typedObservation("old", false, kind === "omitted value");
      if (kind === "no hierarchy") {
        delete observation.viewHierarchy;
      } else if (kind === "stale") {
        observation.freshness = { isFresh: false, staleDurationMs: 1000 };
      }
      return observation;
    };
    h.client.clear = async () => {
      h.calls.push("clear");
      return { success: true };
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await h.executor.clear();
      expect(result.success).toBe(true);
      expect(result.warning).toContain("mask or permanent prefix");
      expect(reads).toBe(3);
      expect(h.calls).toEqual(["clear", "clear"]);
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("old");
    } finally {
      warn.mockRestore();
    }
  },
);

test("#12023: abort during the pre-read prevents the first clear", async () => {
  const h = harness("old");
  const controller = new AbortController();
  const reason = new Error("cancel pre-read");
  h.observer.execute = async (options) => {
    expect(options?.signal).toBeDefined();
    controller.abort(reason);
    return typedObservation("old");
  };
  await expect(h.executor.clear(controller.signal)).rejects.toBe(reason);
  expect(h.calls).toEqual([]);
});

test("#12023: pre-read uses the live text deadline and falls back after timing out", async () => {
  const h = harness("old");
  const deadline = h.timer.now() + 1050;
  let reads = 0;
  let readSignal: AbortSignal | undefined;
  h.observer.execute = async (options) => {
    reads++;
    expect(h.calls).toEqual([]);
    expect(options?.timeoutMs).toBe(50);
    readSignal = options?.signal;
    return new Promise(() => {});
  };
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const result = await runWithTextRequestContext({ getDeadlineMs: () => deadline }, () =>
      h.executor.clear(),
    );
    expect(result).toEqual({
      success: true,
      warning: "iOS clear was not verified: the focused field could not be read.",
    });
    expect(reads).toBe(1);
    expect(readSignal?.aborted).toBe(true);
    expect(h.calls).toEqual(["clear"]);
    expect(warn).toHaveBeenCalled();
    expect(h.timer.now()).toBe(50);
  } finally {
    warn.mockRestore();
  }
});

test("empty clear reads the field before and after clearing with fresh hierarchy-only options", async () => {
  const h = harness("old");
  const observe = h.observer.execute;
  const values: string[] = [];
  h.observer.execute = async (options) => {
    values.push(h.value);
    return observe(options);
  };
  expect(await h.executor.clear(undefined, "main")).toEqual({ success: true });
  expect(h.calls).toEqual(["clear"]);
  expect(values).toEqual(["old", ""]);
  expect(h.reads).toHaveLength(2);
  for (const read of h.reads) {
    expect(read).toMatchObject({
      freshness: "fresh",
      skipScreenshot: true,
      skipAccessibilityAudit: true,
      display: "main",
    });
  }
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

test("an omitted value after a no-op clear remains unverified", async () => {
  const h = harness("old");
  h.observer.execute = async () => typedObservation(h.value, false, true);
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  expect(await h.executor.clear()).toEqual({
    success: true,
    warning: "iOS clear was not verified: the focused field could not be read.",
  });
  expect(h.calls).toEqual(["clear"]);
  expect(h.value).toBe("old");
});

test("a clear/type batch carries the warning for an omitted clear read-back value", async () => {
  const h = harness("old");
  h.observer.execute = async () => typedObservation(h.value, false, true);
  h.client.clear = async () => {
    h.calls.push("clear");
    return { success: true };
  };
  const result = await h.action.execute([{ action: "clear" }, { action: "type", text: "new" }]);
  const warning = "iOS clear was not verified: the focused field could not be read.";
  expect(result.success).toBe(true);
  expect(result.commands[0]).toMatchObject({ success: true, warning });
  expect(result.warning).toContain(warning);
  expect(h.calls).toEqual(["clear", "insert:new"]);
});

test.each(["standalone", "batch"])(
  "an unreadable retry after leftover text fails the %s clear before typing",
  async (mode) => {
    const h = harness(":son");
    deleteLast(h);
    const observe = h.observer.execute;
    h.observer.execute = async (options) => {
      if (h.calls.length === 2) {
        throw new Error("No hierarchy after retry");
      }
      return observe(options);
    };
    const failure = {
      success: false,
      partialApplication: true,
      error:
        'iOS clear could not be verified after 2 attempt(s); the focused field last held ":so" and could not be read again.',
    };
    if (mode === "standalone") {
      expect(await h.executor.clear()).toEqual(failure);
    } else {
      const result = await h.action.execute([
        { action: "clear" },
        { action: "type", text: ":sonr" },
      ]);
      expect(result).toMatchObject({ success: false, failedIndex: 0 });
      expect(result.commands).toHaveLength(1);
      expect(result.commands[0]).toMatchObject(failure);
    }
    expect(h.calls).toEqual(["clear", "clear"]);
    expect(h.value).toBe(":s");
    expect(h.timer.getSleepHistory()).toEqual([100]);
  },
);

test.each([
  { value: undefined, expected: undefined, legacy: "" },
  { value: "", expected: "", legacy: "" },
  { value: "Email", expected: "", legacy: "" },
  { value: "leftover", expected: "leftover", legacy: "leftover" },
])(
  "clear read-back options distinguish missing and blank values: %j",
  ({ value, expected, legacy }) => {
    const hierarchy = {
      hierarchy: {
        node: {
          class: "UITextField",
          focused: true,
          actions: ["set_text"],
          text: "Accessibility label",
          "ios-accessibility-label": "Other label",
          "hint-text": "Email",
          ...(value === undefined ? {} : { value }),
        },
      },
    };
    expect(getFocusedTextField(hierarchy, undefined, { iosPlaceholderAsBlank: true })?.value).toBe(
      expected,
    );
    expect(getFocusedTextField(hierarchy, undefined, { iosEmptyAsBlank: true })?.value).toBe(
      legacy,
    );
  },
);

test.each([
  { class: "UITextField", password: true, value: "Email" },
  { class: "UITextField", password: "true", value: "" },
  { class: "UISecureTextField", value: "Email" },
  { class: "UISecureTextField" },
])("clear read-back options preserve secure classification and values: %j", (properties) => {
  const hierarchy = {
    hierarchy: {
      node: { focused: true, actions: ["set_text"], "hint-text": "Email", ...properties },
    },
  };
  const baseline = getFocusedTextField(hierarchy);
  expect(baseline).toEqual({ value: properties.value, secure: true });
  expect(getFocusedTextField(hierarchy, undefined, { iosPlaceholderAsBlank: true })).toEqual(
    baseline,
  );
  expect(getFocusedTextField(hierarchy, undefined, { iosEmptyAsBlank: true })).toEqual(baseline);
});

test("unchanged mask settles after one retry with remaining-value evidence", async () => {
  const h = harness("$5.00");
  h.client.clear = async () => {
    h.calls.push("clear");
    h.value = "$0.00";
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

test("runner clear failure is returned unchanged after the pre-read", async () => {
  const h = harness();
  const failure = { success: false, error: "runner refused", retryable: false };
  h.client.clear = async () => failure;
  expect(await h.executor.clear()).toBe(failure);
  expect(h.reads).toHaveLength(1);
});

test("runner retry failure is returned without further read or mutation", async () => {
  const h = harness("old");
  const failure = { success: false, error: "retry refused", retryable: false };
  h.client.clear = async () => {
    h.calls.push("clear");
    return h.calls.length === 1 ? { success: true } : failure;
  };
  expect(await h.executor.clear()).toEqual({ ...failure, partialApplication: true });
  expect(h.calls).toEqual(["clear", "clear"]);
  expect(h.reads).toHaveLength(2);
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
    partialApplication: true,
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
  const h = harness("$5.00");
  h.client.clear = async () => {
    h.calls.push("clear");
    h.value = "$0.00";
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

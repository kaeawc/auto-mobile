import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { ClearText } from "../../../src/features/action/ClearText";
import { InputText } from "../../../src/features/action/InputText";
import { DefaultSendKeysCommandExecutor, SendKeys } from "../../../src/features/action/SendKeys";
import { SetUIState } from "../../../src/features/action/SetUIState";
import {
  runWithTextRequestContext,
  TEXT_REQUEST_RESPONSE_MARGIN_MS,
} from "../../../src/features/action/textTransportTimeout";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../../src/features/observe/ios";
import type { BootedDevice, ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAwaitIdle } from "../../fakes/FakeAwaitIdle";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { typedObservation } from "./IosTypedTextTestHarness";
import { createSendKeysHarness, ios, android } from "./SendKeysTestHarness";

type Entry = "sendKeys clear" | "sendKeys replace" | "ClearText" | "setUIState";
type Outcome = {
  name: string;
  values: Array<string | undefined>;
  success: boolean;
  clears: number;
  warning?: string;
  error?: string;
  secure?: boolean;
  failedRequest?: number;
};
const outcomes: Outcome[] = [
  { name: "empty", values: ["old", ""], success: true, clears: 1 },
  {
    name: "secure",
    values: ["secret"],
    secure: true,
    success: true,
    clears: 1,
    warning: "check skipped",
  },
  {
    name: "unreadable first",
    values: [undefined],
    success: true,
    clears: 1,
    warning: "not verified",
  },
  {
    name: "same leftover",
    values: ["prefix5", "prefix", "prefix"],
    success: true,
    clears: 2,
    warning: "still holds",
  },
  {
    name: "untouched",
    values: ["old", "old", "old"],
    success: false,
    clears: 2,
    error: 'remaining value: "old"',
  },
  {
    name: "changing leftover",
    values: ["abcd", "abc", "ab", "a"],
    success: false,
    clears: 3,
    error: 'remaining value: "a"',
  },
  {
    name: "unreadable after leftover",
    values: ["abcd", "abc", undefined],
    success: false,
    clears: 2,
    error: 'last held "abc"',
  },
  {
    name: "first request fails",
    values: ["old"],
    success: false,
    clears: 1,
    failedRequest: 1,
    error: "runner refused clear",
  },
  {
    name: "retry request fails",
    values: ["abcd", "abc"],
    success: false,
    clears: 2,
    failedRequest: 2,
    error: "runner refused clear",
  },
];
const entries: Entry[] = ["sendKeys clear", "sendKeys replace", "ClearText", "setUIState"];
// setUIState re-focuses and re-clears per field attempt. An untouched clear
// fails all three attempts before input or its final-value check can run.
const rows = entries.flatMap((entry) =>
  outcomes.map((outcome) => {
    const fieldAttempts =
      entry === "setUIState" &&
      (outcome.name === "changing leftover" ||
        outcome.name === "unreadable after leftover" ||
        outcome.name === "untouched")
        ? 3
        : 1;
    const sleeps = outcome.clears === 3 ? [100, 200] : outcome.clears === 2 ? [100] : [];
    return {
      entry,
      ...outcome,
      clears: outcome.clears * fieldAttempts,
      fieldAttempts,
      sleeps: Array.from({ length: fieldAttempts }, () => sleeps).flat(),
    };
  }),
);
let timer: FakeTimer;
let proxy: FakeIOSCtrlProxy;
let androidProxy: FakeCtrlProxy;
let iosInstance: ReturnType<typeof spyOn>;
let androidInstance: ReturnType<typeof spyOn>;

beforeEach(() => {
  timer = new FakeTimer();
  timer.enableAutoAdvance();
  proxy = new FakeIOSCtrlProxy(timer);
  androidProxy = new FakeCtrlProxy();
  iosInstance = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(
    proxy as unknown as IOSCtrlProxyClient,
  );
  androidInstance = spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    androidProxy as unknown as AndroidCtrlProxyClient,
  );
});
afterEach(() => {
  iosInstance.mockRestore();
  androidInstance.mockRestore();
  timer.reset();
});

function clearAction(device: BootedDevice, observer: FakeObserveScreen) {
  const action = new ClearText(device, new FakeAdbExecutor(), undefined, timer);
  action.observeScreen = observer;
  action.window = new FakeWindow();
  action.awaitIdle = new FakeAwaitIdle();
  return action;
}

function fieldObservation(value: string): ObserveResult {
  return {
    timestamp: 1,
    screenSize: { width: 400, height: 800 },
    viewHierarchy: {
      hierarchy: {
        node: {
          $: {
            class: "UITextField",
            "resource-id": "field",
            focused: true,
            editable: true,
            value,
            text: "Email",
            bounds: { left: 0, top: 0, right: 200, bottom: 50 },
          },
        },
      },
    },
  };
}

function formAction(
  device: BootedDevice,
  clear: ClearText,
  input: (text: string) => Promise<{ success: boolean; text: string }>,
) {
  const observer = new FakeObserveScreen();
  observer.setObserveResult(fieldObservation("old"));
  const action = new SetUIState(device, new FakeAdbExecutor(), {
    timer,
    observeScreen: observer,
    clearText: clear,
    tapOnElement: { execute: async () => ({ success: true, focusVerified: true }) },
    inputText: {
      execute: async (text) => {
        const result = await input(text);
        observer.setObserveResult(fieldObservation(text));
        return result;
      },
    },
  });
  return { action, observer };
}

test.each(rows)("$entry / $name", async (row) => {
  let clears = 0;
  let typed = false;
  let inputCalls = 0;
  let readIndex = 0;
  const request = spyOn(proxy, "requestClearText").mockImplementation(async () => {
    clears++;
    return row.failedRequest === clears
      ? { success: false, totalTimeMs: 0, error: "runner refused clear", retryable: false }
      : { success: true, totalTimeMs: 0 };
  });
  const observer = new FakeObserveScreen();
  observer.setObserveResult(typedObservation("old"));
  const observe = spyOn(observer, "execute").mockImplementation(async (options) => {
    if (options?.minTimestamp !== undefined) {
      return typedObservation(typed ? "new" : "old");
    }
    const index =
      row.entry === "setUIState"
        ? readIndex++ % row.values.length
        : Math.min(readIndex++, row.values.length - 1);
    const value = row.values[index];
    return typedObservation(typed ? "new" : (value ?? ""), row.secure, value === undefined);
  });
  try {
    let result: {
      success: boolean;
      error?: string;
      warning?: string;
      warnings?: string[];
      partialApplication?: boolean;
      retryable?: boolean;
    };
    if (row.entry === "sendKeys clear" || row.entry === "sendKeys replace") {
      const h = createSendKeysHarness(ios, observer);
      h.client.clear = async () => proxy.requestClearText();
      h.client.insert = async () => {
        typed = true;
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
      const batch = await action.execute(
        row.entry === "sendKeys clear"
          ? [{ action: "clear" }, { action: "type", text: "new" }]
          : [{ action: "type", text: "new", operation: "replace" }],
      );
      result = batch.commands[0];
      expect(batch.success).toBe(row.success);
    } else {
      const clear = clearAction(ios, observer);
      if (row.entry === "ClearText") {
        result = await clear.execute();
      } else {
        const form = formAction(ios, clear, async (text) => {
          inputCalls++;
          typed = true;
          return { success: true, text };
        });
        const formResult = await form.action.execute({
          fields: [{ selector: { elementId: "field" }, value: "new" }],
        });
        result = formResult;
        if (row.success) {
          expect(formResult.fields[0].error).toBeUndefined();
        } else {
          expect(formResult.fields[0].error).toStartWith("Failed to clear text: ");
          expect(formResult.fields[0].error).toContain(row.error);
          expect(formResult.fields[0].attempts).toBe(row.fieldAttempts);
          expect(inputCalls).toBe(0);
        }
        expect(formResult.fields[0]).not.toHaveProperty("warnings");
      }
    }
    expect(result.success).toBe(row.success);
    if (row.warning) {
      const warning = row.entry.startsWith("sendKeys") ? result.warning : result.warnings?.[0];
      expect(warning).toContain(row.warning);
      if (row.entry === "setUIState") {
        expect(warning).toStartWith('elementId="field": ');
        expect(result.warnings).toHaveLength(1);
      }
    } else {
      expect(result.warning).toBeUndefined();
      expect(result).not.toHaveProperty("warnings");
    }
    if (row.error) {
      expect(result.error).toContain(row.error);
    }
    expect(typed).toBe(row.entry === "ClearText" ? false : row.success);
    expect(clears).toBe(row.clears);
    expect(timer.getSleepHistory()).toEqual(row.sleeps);
    if (row.entry.startsWith("sendKeys")) {
      if (row.success || row.failedRequest === 1 || row.name === "untouched") {
        expect(result).not.toHaveProperty("partialApplication");
      } else {
        expect(result.partialApplication).toBe(true);
      }
    } else {
      expect(result).not.toHaveProperty("partialApplication");
    }
    if (row.failedRequest && row.entry !== "setUIState") {
      expect(result.retryable).toBe(false);
    }
  } finally {
    request.mockRestore();
    observe.mockRestore();
  }
});

test("ClearText cancellation during verification rejects after the acknowledged clear", async () => {
  const observer = new FakeObserveScreen();
  observer.setObserveResult(typedObservation("old"));
  const controller = new AbortController();
  const reason = new Error("cancel verification");
  const read = spyOn(observer, "execute").mockImplementation(async (options) => {
    if (options?.minTimestamp === undefined && request.mock.calls.length === 1) {
      controller.abort(reason);
    }
    return typedObservation(request.mock.calls.length === 0 ? "old" : "");
  });
  const request = spyOn(proxy, "requestClearText");
  try {
    await expect(clearAction(ios, observer).execute(undefined, controller.signal)).rejects.toBe(
      reason,
    );
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    request.mockRestore();
  }
});

test("ClearText first and retry requests preserve the signal and live text deadline", async () => {
  const observer = new FakeObserveScreen();
  observer.setObserveResult(typedObservation("old"));
  const read = spyOn(observer, "execute").mockImplementation(async (options) =>
    typedObservation(
      options?.minTimestamp === undefined && request.mock.calls.length === 1 ? "abc" : "",
    ),
  );
  const request = spyOn(proxy, "requestClearText");
  const controller = new AbortController();
  const deadlineMs = 4000;
  try {
    const result = await runWithTextRequestContext({ getDeadlineMs: () => deadlineMs }, () =>
      clearAction(ios, observer).execute(undefined, controller.signal),
    );
    expect(result.success).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    for (const args of request.mock.calls) {
      expect(args).toEqual([
        undefined,
        5000,
        undefined,
        {
          abortSignal: controller.signal,
          deadlineMs: deadlineMs - TEXT_REQUEST_RESPONSE_MARGIN_MS,
        },
      ]);
    }
  } finally {
    read.mockRestore();
    request.mockRestore();
  }
});

test("InputText on iOS types at the caret without requesting a clear", async () => {
  const action = new InputText(ios, new FakeAdbExecutor(), undefined, timer);
  const observer = new FakeObserveScreen();
  observer.setObserveResult(() =>
    typedObservation(proxy.getTextInputHistory().length ? "oldnew" : "old"),
  );
  action.observeScreen = observer;
  action.window = new FakeWindow();
  action.awaitIdle = new FakeAwaitIdle();
  const request = spyOn(proxy, "requestClearText");
  try {
    expect(await action.execute("new")).toMatchObject({ success: true, text: "new" });
    expect(request).not.toHaveBeenCalled();
    expect(proxy.getTextInputHistory()).toEqual([{ text: "new", resourceId: undefined }]);
  } finally {
    request.mockRestore();
  }
});

test("Android ClearText and setUIState retain acknowledgement-only clearing without warnings", async () => {
  const observer = new FakeObserveScreen();
  observer.setObserveResult({
    timestamp: 1,
    viewHierarchy: {
      hierarchy: { node: { $: { class: "android.widget.EditText", focused: true, text: "old" } } },
    },
  });
  const clear = clearAction(android, observer);
  const request = spyOn(androidProxy, "requestClearText");
  try {
    const result = await clear.execute();
    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    expect(observer.getExecuteCallCount()).toBe(1);
    observer.clearHistory();
    const form = formAction(android, clear, async (text) => ({ success: true, text }));
    const formResult = await form.action.execute({
      fields: [{ selector: { elementId: "field" }, value: "new" }],
    });
    expect(formResult.success).toBe(true);
    expect(formResult.warnings).toBeUndefined();
    expect(formResult.fields[0]).not.toHaveProperty("warnings");
    expect(observer.getExecuteCallCount()).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    request.mockRestore();
  }
});

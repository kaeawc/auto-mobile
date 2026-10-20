import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { socketServerInputHooks } from "../helpers/socketServerInputHooks";
import type { DaemonRequest } from "../../src/daemon/types";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { ActionableError, type BootedDevice } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { spyOnIosClientInstance } from "../helpers/iosCtrlProxyClientSpies";

const reason = "No element has keyboard focus -- ensure a text field is focused";
const guidance = `IME action 'done' failed after the text was entered: ${reason}. Do not retype the text.`;
function createHandler(platform: "android" | "ios" = "ios", signal?: AbortSignal) {
  const timer = new FakeTimer();
  const handler = socketServerInputHooks(timer);
  const device: BootedDevice = { platform, deviceId: "fake-text", name: "Fake" };
  handler.resolveInputTargetDevice = async () => device;
  handler.requireCurrentFrameContext = () => {};
  handler.runTrackedKeyedDeviceInput = async (_method, _device, operation) => operation(signal);
  handler.executeAndroidAppendText = async () => ({ success: true, charsSent: 2 });
  return { handler, timer, device };
}

function request(submit?: boolean, append = false, platform = "ios"): DaemonRequest {
  return {
    id: "type-text",
    type: "mcp_request",
    method: "input/typeText",
    timeoutMs: 1000,
    params: {
      platform,
      deviceId: "fake-text",
      text: "1\n",
      submit,
      ...(append ? { mode: "append" } : {}),
    },
  };
}

function fakeIosClient() {
  // Only the two text methods can run; construction cannot start a real client.
  const client: IOSCtrlProxyClient = Object.create(IOSCtrlProxyClient.prototype);
  const setText = mock<typeof client.requestSetText>().mockResolvedValue({
    success: true,
    totalTimeMs: 0,
  });
  const ime = mock<typeof client.requestImeAction>().mockResolvedValue({
    success: true,
    action: "done",
    totalTimeMs: 0,
  });
  client.requestSetText = setText;
  client.requestImeAction = ime;
  spyOnIosClientInstance(client);
  return { setText, ime };
}

afterEach(() => {
  mock.restore();
  AndroidCtrlProxyClient.clearInstanceRegistryForTesting();
  IOSCtrlProxyClient.clearInstanceRegistryForTesting();
  expect(AndroidCtrlProxyClient.getExistingInstance("fake-text")).toBeNull();
  expect(IOSCtrlProxyClient.getExistingInstance("fake-text")).toBeNull();
});

test("input/typeText submit reports a returned IME failure after successful typing", async () => {
  const { handler } = createHandler();
  const { setText, ime } = fakeIosClient();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  ime.mockResolvedValue({ success: false, action: "done", totalTimeMs: 0, error: reason });

  await expect(handler.handleInputTypeText(request(true))).rejects.toThrow(guidance);
  expect(setText).toHaveBeenCalledWith("1\n", {
    timeoutMs: 1000,
    frameContext: undefined,
    abortSignal: undefined,
    onDispatch: expect.any(Function),
  });
  expect(ime).toHaveBeenCalledWith("done", 1000, undefined, undefined, expect.any(Function));
  expect(warn).toHaveBeenCalled();
});

test("input/typeText submit preserves a rejected IME error's class and metadata", async () => {
  const controller = new AbortController();
  const { handler } = createHandler("ios", controller.signal);
  const { ime } = fakeIosClient();
  const error = Object.assign(new ActionableError(reason), {
    code: "runner_failed",
    failureSource: "transport",
  });
  ime.mockRejectedValue(error);
  const result = handler.handleInputTypeText(request(true));

  await expect(result).rejects.toBe(error);
  await expect(result).rejects.toThrow(guidance);
  expect(error.code).toBe("runner_failed");
  expect(error.failureSource).toBe("transport");
  expect(controller.signal.aborted).toBe(false);
  expect(ime).toHaveBeenCalledWith(
    "done",
    1000,
    undefined,
    expect.any(AbortSignal),
    expect.any(Function),
  );
});

function prototypeOnlyIosClient(): IOSCtrlProxyClient {
  return Object.create(IOSCtrlProxyClient.prototype);
}

function prototypeOnlyAndroidClient(): AndroidCtrlProxyClient {
  return Object.create(AndroidCtrlProxyClient.prototype);
}

test.each([
  ["shared Error", "ios", false, new Error("owner cancelled submit")],
  ["string", "ios", false, "owner cancelled submit"],
  ["frozen Error", "ios", false, Object.freeze(new Error("owner cancelled submit"))],
  ["shared Error during append", "android", true, new Error("owner cancelled submit")],
] as const)(
  "input/typeText submit preserves cancellation: %s",
  async (_label, platform, append, abortReason) => {
    const controller = new AbortController();
    const { handler } = createHandler(platform, controller.signal);
    const originalMessage = abortReason instanceof Error ? abortReason.message : undefined;
    const abortingIme = (signal: AbortSignal | undefined): Promise<never> => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);
      const pending = new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      controller.abort(abortReason);
      return pending;
    };
    let ime;
    if (platform === "ios") {
      const iosClient = prototypeOnlyIosClient();
      spyOnIosClientInstance(iosClient);
      spyOn(iosClient, "requestSetText").mockResolvedValue({ success: true, totalTimeMs: 0 });
      ime = spyOn(iosClient, "requestImeAction").mockImplementation(
        (_action, _timeoutMs, _perf, signal) => abortingIme(signal),
      );
    } else {
      const androidClient = prototypeOnlyAndroidClient();
      spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(androidClient);
      ime = spyOn(androidClient, "requestImeAction").mockImplementation(
        (_action, _timeoutMs, _perf, signal) => abortingIme(signal),
      );
    }
    const warn = spyOn(logger, "warn").mockImplementation(() => {});

    await expect(handler.handleInputTypeText(request(true, append, platform))).rejects.toBe(
      abortReason,
    );
    if (abortReason instanceof Error && originalMessage !== undefined) {
      expect(abortReason.message).toBe(originalMessage);
    }
    expect(controller.signal.reason).toBe(abortReason);
    expect(ime).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  },
);

test.each([false, true])(
  "Android append preserves charsSent for an IME failure (throws=%s)",
  async (throws) => {
    const { handler } = createHandler("android");
    const client = prototypeOnlyAndroidClient();
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
    const ime = spyOn(client, "requestImeAction");
    if (throws) {
      ime.mockRejectedValue(new Error(reason));
    } else {
      ime.mockResolvedValue({ success: false, action: "done", totalTimeMs: 0, error: reason });
    }

    const result = handler.handleInputTypeText(request(true, true, "android"));
    await expect(result).rejects.toMatchObject({ message: guidance, charsSent: 2 });
  },
);

test.each([undefined, true])(
  "input/typeText success preserves the submit=%s response",
  async (submit) => {
    const { handler } = createHandler();
    const { ime } = fakeIosClient();

    expect(await handler.handleInputTypeText(request(submit))).toEqual({
      action: "input/typeText",
      platform: "ios",
      deviceId: "fake-text",
      success: true,
      textLength: 2,
      submitted: submit === true,
    });
    expect(ime).toHaveBeenCalledTimes(submit ? 1 : 0);
  },
);

test("a failed type step retains its reason and never requests submit", async () => {
  const { handler } = createHandler();
  const { setText, ime } = fakeIosClient();
  setText.mockResolvedValue({ success: false, totalTimeMs: 0, error: "typing failed" });

  await expect(handler.handleInputTypeText(request(true))).rejects.toThrow("typing failed");
  expect(ime).not.toHaveBeenCalled();
});

test("submit budget exhaustion retains its message and append progress", async () => {
  const { handler, timer, device } = createHandler();
  const { setText, ime } = fakeIosClient();
  setText.mockImplementation(async () => {
    timer.advanceTime(1000);
    return { success: true, totalTimeMs: 0 };
  });
  // Exercise the budget primitive directly: the outer request race owns the
  // deadline on the full handler path, as documented by the production method.
  expect(await handler.executeInputTypeText("ios", device, "1\n", "done", 1000)).toEqual({
    success: false,
    error: "input/typeText exceeded 1000ms budget before submit",
  });
  const result = await handler.runImeActionWithinBudget(
    { requestImeAction: ime },
    "done",
    timer.now(),
    1000,
    2,
  );
  expect(result).toEqual({
    success: false,
    error: "input/typeText exceeded 1000ms budget before submit",
    charsSent: 2,
  });
  expect(ime).not.toHaveBeenCalled();
});

test.each([false, true])(
  "runImeActionWithinBudget keeps returned failure channels (append=%s)",
  async (append) => {
    const { handler } = createHandler();
    const ime = mock(async () => ({
      success: false,
      action: "done",
      totalTimeMs: 0,
      error: reason,
    }));
    expect<object>(
      await handler.runImeActionWithinBudget(
        { requestImeAction: ime },
        "done",
        1000,
        1000,
        append ? 2 : undefined,
      ),
    ).toEqual({
      success: false,
      action: "done",
      totalTimeMs: 0,
      error: guidance,
      ...(append ? { charsSent: 2 } : {}),
    });
  },
);

test("runImeActionWithinBudget keeps append rejection as a returned failure", async () => {
  const { handler } = createHandler();
  const ime = mock(async () => {
    throw new Error(reason);
  });
  expect<object>(
    await handler.runImeActionWithinBudget({ requestImeAction: ime }, "done", 1000, 1000, 2),
  ).toEqual({ success: false, error: guidance, charsSent: 2 });
});

test("a non-Error IME rejection remains thrown with its reason and cause", async () => {
  const { handler } = createHandler();
  const ime = mock(async () => {
    throw reason;
  });
  await expect(
    handler.runImeActionWithinBudget({ requestImeAction: ime }, "done", 1000, 1000),
  ).rejects.toMatchObject({ message: guidance, cause: reason });
});

test("an IME failure with no runner reason uses the existing fallback", async () => {
  const { handler } = createHandler();
  const ime = mock(async () => ({ success: false, action: "next", totalTimeMs: 0 }));
  expect<object>(
    await handler.runImeActionWithinBudget({ requestImeAction: ime }, "next", 1000, 1000),
  ).toMatchObject({
    success: false,
    error:
      "IME action 'next' failed after the text was entered: unknown error. Do not retype the text.",
  });
});

test("a successful IME action and an absent submit preserve append progress", async () => {
  const { handler } = createHandler();
  const ime = mock(async () => ({ success: true, action: "done", totalTimeMs: 0 }));
  expect<object>(
    await handler.runImeActionWithinBudget({ requestImeAction: ime }, "done", 1000, 1000, 2),
  ).toEqual({ success: true, action: "done", totalTimeMs: 0, charsSent: 2 });
  expect<object>(
    await handler.runImeActionWithinBudget({ requestImeAction: ime }, undefined, 1000, 1000, 2),
  ).toEqual({ success: true, charsSent: 2 });
  expect(ime).toHaveBeenCalledTimes(1);
});

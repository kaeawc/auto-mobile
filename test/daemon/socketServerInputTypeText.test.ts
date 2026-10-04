import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest } from "../../src/daemon/types";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { DeviceService } from "../../src/features/observe/DeviceService";
import { ActionableError, type BootedDevice, type ImeAction } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

const reason = "No element has keyboard focus -- ensure a text field is focused";
const guidance = `IME action 'done' failed after the text was entered: ${reason}. Do not retype the text.`;
type TextResult = { success: boolean; error?: string; charsSent?: number };

interface TypeTextHandler {
  timer: Timer;
  handleInputTypeText(request: DaemonRequest): Promise<unknown>;
  resolveInputTargetDevice(): Promise<BootedDevice>;
  requireCurrentFrameContext(): void;
  runTrackedKeyedDeviceInput<T>(
    method: string,
    device: BootedDevice,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T>;
  executeAndroidAppendText(): Promise<TextResult>;
  executeInputTypeText(
    platform: "android" | "ios",
    device: BootedDevice,
    text: string,
    action: ImeAction | undefined,
    timeoutMs: number,
  ): Promise<TextResult>;
  runImeActionWithinBudget(
    client: Pick<DeviceService, "requestImeAction">,
    action: ImeAction | undefined,
    deadline: number,
    timeoutMs: number,
    charsSent?: number,
  ): Promise<TextResult>;
}

function createHandler(platform: "android" | "ios" = "ios") {
  // Match socketServerInputKey's prototype harness: no server, DB, or sockets.
  const handler = Object.create(UnixSocketServer.prototype) as TypeTextHandler;
  const timer = new FakeTimer();
  const device: BootedDevice = { platform, deviceId: "fake-text", name: "Fake" };
  handler.timer = timer;
  handler.resolveInputTargetDevice = async () => device;
  handler.requireCurrentFrameContext = () => {};
  handler.runTrackedKeyedDeviceInput = async (_method, _device, operation) => operation();
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
  const client = Object.create(IOSCtrlProxyClient.prototype) as IOSCtrlProxyClient;
  const setText = spyOn(client, "requestSetText").mockResolvedValue({
    success: true,
    totalTimeMs: 0,
  });
  const ime = spyOn(client, "requestImeAction").mockResolvedValue({
    success: true,
    action: "done",
    totalTimeMs: 0,
  });
  spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
  return { setText, ime };
}

afterEach(() => mock.restore());

test("input/typeText submit reports a returned IME failure after successful typing", async () => {
  const { handler } = createHandler();
  const { setText, ime } = fakeIosClient();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  ime.mockResolvedValue({ success: false, action: "done", totalTimeMs: 0, error: reason });

  await expect(handler.handleInputTypeText(request(true))).rejects.toThrow(guidance);
  expect(setText).toHaveBeenCalledWith("1\n", { timeoutMs: 1000, frameContext: undefined });
  expect(ime).toHaveBeenCalledWith("done", 1000);
  expect(warn).toHaveBeenCalled();
});

test("input/typeText submit preserves a rejected IME error's class and metadata", async () => {
  const { handler } = createHandler();
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
});

test.each([false, true])(
  "Android append preserves charsSent for an IME failure (throws=%s)",
  async (throws) => {
    const { handler } = createHandler("android");
    const client = Object.create(AndroidCtrlProxyClient.prototype) as AndroidCtrlProxyClient;
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
    expect(
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
  expect(
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
  expect(
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
  expect(
    await handler.runImeActionWithinBudget({ requestImeAction: ime }, "done", 1000, 1000, 2),
  ).toEqual({ success: true, action: "done", totalTimeMs: 0, charsSent: 2 });
  expect(
    await handler.runImeActionWithinBudget({ requestImeAction: ime }, undefined, 1000, 1000, 2),
  ).toEqual({ success: true, charsSent: 2 });
  expect(ime).toHaveBeenCalledTimes(1);
});

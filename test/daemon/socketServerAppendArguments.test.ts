import { socketServerInputHooks } from "../helpers/socketServerInputHooks";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { type AppendTextInput } from "../../src/daemon/socketServer";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

const device: BootedDevice = { platform: "android", deviceId: "fake-append", name: "Fake" };
afterEach(() => mock.restore());

test.each([false, true])(
  "Android append threads optional signal and frame validation (present=%s)",
  async (present) => {
    const timer = new FakeTimer();
    timer.advanceTime(400);
    const server = socketServerInputHooks(timer);
    const client: AndroidCtrlProxyClient = Object.create(AndroidCtrlProxyClient.prototype);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      timer.advanceTime(70);
      return client;
    });
    const validate = spyOn(client, "validateFrameContext").mockResolvedValue({
      success: true,
      totalTimeMs: 0,
    });
    const calls: Parameters<AppendTextInput["appendText"]>[] = [];
    const input: AppendTextInput = {
      async appendText(...args) {
        calls.push(args);
        expect(args[0]).toBe("AB");
        // Deadline is 1400; client lookup consumed 70ms of the 1000ms budget.
        expect(args[1]?.timeoutMs).toBe(930);
        timer.advanceTime(110);
        const beforeKeyEvents = args[1]?.beforeKeyEvents;
        if (beforeKeyEvents) {
          expect(await beforeKeyEvents()).toMatchObject({ success: true });
        }
        return { success: true, charsSent: 2 };
      },
    };
    server.getAppendTextInput = () => ({ input, fromCache: false });
    const signal = present ? new AbortController().signal : undefined;
    const frameContext = present ? "frame" : undefined;
    expect(
      await server.executeInputTypeText("android", device, "AB", {
        timeoutMs: 1000,
        append: true,
        frameContext,
        signal,
      }),
    ).toEqual({ success: true, charsSent: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBe(2);
    expect(typeof calls[0][1]?.onDispatch).toBe("function");
    expect(calls[0][1]?.signal).toBe(signal);
    expect(validate.mock.calls).toEqual(present ? [["frame", 820]] : []);
  },
);

test.each(["append", "validation"] as const)(
  "Android append reports the original timeout when the %s budget expires",
  async (phase) => {
    const timer = new FakeTimer();
    timer.advanceTime(400);
    const server = socketServerInputHooks(timer);
    const client: AndroidCtrlProxyClient = Object.create(AndroidCtrlProxyClient.prototype);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      timer.advanceTime(phase === "append" ? 1000 : 70);
      return client;
    });
    const validate = spyOn(client, "validateFrameContext").mockResolvedValue({
      success: true,
      totalTimeMs: 0,
    });
    const appendText = mock<AppendTextInput["appendText"]>(
      async (_text, { timeoutMs, beforeKeyEvents: beforeKeyEvent } = {}) => {
        expect(timeoutMs).toBe(930);
        timer.advanceTime(930);
        expect(beforeKeyEvent).toBeDefined();
        return await beforeKeyEvent!();
      },
    );
    server.getAppendTextInput = () => ({ input: { appendText }, fromCache: false });
    expect(
      await server.executeInputTypeText("android", device, "AB", {
        timeoutMs: 1000,
        append: true,
        frameContext: "frame",
      }),
    ).toEqual({
      success: false,
      error: `input/typeText exceeded 1000ms budget before append ${phase === "append" ? "key events" : "frame context validation"}`,
    });
    expect(appendText).toHaveBeenCalledTimes(phase === "append" ? 0 : 1);
    expect(validate).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  "append self-heal and submit share one dispatch mark (first sent=%s)",
  async (firstSent) => {
    const timer = new FakeTimer();
    const server = socketServerInputHooks(timer);
    let marks = 0;
    let attempts = 0;
    const client: AndroidCtrlProxyClient = Object.create(AndroidCtrlProxyClient.prototype);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
    spyOn(client, "requestImeAction").mockImplementation(async (...args) => {
      args[4]?.();
      return { success: true, action: "done", totalTimeMs: 0 };
    });
    server.evictDeviceInputCache = () => {};
    server.getAppendTextInput = () => ({
      fromCache: true,
      input: {
        appendText: async (text, { onDispatch } = {}) => {
          attempts++;
          if (attempts === 1) {
            if (firstSent) {
              onDispatch?.();
            }
            return { success: false, charsSent: firstSent ? 1 : 0, error: "helper failed" };
          }
          expect(text).toBe(firstSent ? "B" : "AB");
          onDispatch?.();
          return { success: true, charsSent: text.length };
        },
      },
    });
    // The declared result omits the IME action fields the append path also returns.
    expect<object>(
      await server.executeInputTypeText("android", device, "AB", {
        imeAction: "done",
        timeoutMs: 1000,
        append: true,
        dispatching: () => marks++,
      }),
    ).toEqual({ success: true, charsSent: 2, action: "done", totalTimeMs: 0 });
    expect(attempts).toBe(2);
    expect(marks).toBe(1);
  },
);

test("submit is the first dispatch when append sends no keyevents", async () => {
  const timer = new FakeTimer();
  const server = socketServerInputHooks(timer);
  let marks = 0;
  const client: AndroidCtrlProxyClient = Object.create(AndroidCtrlProxyClient.prototype);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
  spyOn(client, "requestImeAction").mockImplementation(async (...args) => {
    expect(marks).toBe(0);
    args[4]?.();
    return { success: true, action: "done", totalTimeMs: 0 };
  });
  server.getAppendTextInput = () => ({
    input: { appendText: async () => ({ success: true, charsSent: 0 }) },
    fromCache: false,
  });
  // The declared result omits the IME action fields the append path also returns.
  expect<object>(
    await server.executeInputTypeText("android", device, "", {
      imeAction: "done",
      timeoutMs: 1000,
      append: true,
      dispatching: () => marks++,
    }),
  ).toEqual({ success: true, charsSent: 0, action: "done", totalTimeMs: 0 });
  expect(marks).toBe(1);
});

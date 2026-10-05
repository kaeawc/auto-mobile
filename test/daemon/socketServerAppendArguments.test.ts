import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { UnixSocketServer, type AppendTextInput } from "../../src/daemon/socketServer";
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
    const server: UnixSocketServer = Object.create(UnixSocketServer.prototype);
    Object.assign(server, { timer });
    const client: AndroidCtrlProxyClient = Object.create(AndroidCtrlProxyClient.prototype);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      timer.advanceTime(70);
      return client;
    });
    const validate = spyOn(client, "validateFrameContext").mockResolvedValue({ success: true });
    const calls: Parameters<AppendTextInput["appendText"]>[] = [];
    const input: AppendTextInput = {
      async appendText(...args) {
        calls.push(args);
        expect(args[0]).toBe("AB");
        // Deadline is 1400; client lookup consumed 70ms of the 1000ms budget.
        expect(args[1]).toBe(930);
        timer.advanceTime(110);
        if (args[2]) {
          expect(await args[2]()).toMatchObject({ success: true });
        }
        return { success: true, charsSent: 2 };
      },
    };
    server["getAppendTextInput"] = () => ({ input, fromCache: false });
    const signal = present ? new AbortController().signal : undefined;
    const frameContext = present ? "frame" : undefined;
    expect(
      await server["executeInputTypeText"](
        "android",
        device,
        "AB",
        undefined,
        1000,
        true,
        frameContext,
        undefined,
        signal,
      ),
    ).toEqual({ success: true, charsSent: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0].length).toBe(present ? 4 : 3);
    expect(calls[0][3]).toBe(signal);
    expect(validate.mock.calls).toEqual(present ? [["frame", 820]] : []);
  },
);

test.each(["append", "validation"] as const)(
  "Android append reports the original timeout when the %s budget expires",
  async (phase) => {
    const timer = new FakeTimer();
    timer.advanceTime(400);
    const server: UnixSocketServer = Object.create(UnixSocketServer.prototype);
    Object.assign(server, { timer });
    const client: AndroidCtrlProxyClient = Object.create(AndroidCtrlProxyClient.prototype);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      timer.advanceTime(phase === "append" ? 1000 : 70);
      return client;
    });
    const validate = spyOn(client, "validateFrameContext").mockResolvedValue({ success: true });
    const appendText = mock<AppendTextInput["appendText"]>(
      async (_text, timeoutMs, beforeKeyEvent) => {
        expect(timeoutMs).toBe(930);
        timer.advanceTime(930);
        expect(beforeKeyEvent).toBeDefined();
        return await beforeKeyEvent!();
      },
    );
    server["getAppendTextInput"] = () => ({ input: { appendText }, fromCache: false });
    expect(
      await server["executeInputTypeText"]("android", device, "AB", undefined, 1000, true, "frame"),
    ).toEqual({
      success: false,
      error: `input/typeText exceeded 1000ms budget before append ${phase === "append" ? "key events" : "frame context validation"}`,
    });
    expect(appendText).toHaveBeenCalledTimes(phase === "append" ? 0 : 1);
    expect(validate).not.toHaveBeenCalled();
  },
);

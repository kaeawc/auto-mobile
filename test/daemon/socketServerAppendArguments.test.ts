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
    const server: UnixSocketServer = Object.create(UnixSocketServer.prototype);
    Object.assign(server, { timer });
    const client: AndroidCtrlProxyClient = Object.create(AndroidCtrlProxyClient.prototype);
    spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(client);
    const validate = spyOn(client, "validateFrameContext").mockResolvedValue({ success: true });
    const calls: Parameters<AppendTextInput["appendText"]>[] = [];
    const input: AppendTextInput = {
      async appendText(...args) {
        calls.push(args);
        expect(args[0]).toBe("AB");
        expect(args[1]).toBe(1000);
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
    expect(validate.mock.calls).toEqual(present ? [["frame", 1000]] : []);
  },
);

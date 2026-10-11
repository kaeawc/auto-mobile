import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { BootedDevice } from "../../../../src/models";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";

/** #11667: a storage call cut while connecting must never send its device write. */

const device: BootedDevice = {
  deviceId: "hunt-storage-device",
  platform: "android",
  isEmulator: true,
  name: "Hunt Device",
};

class CapturingWebSocket extends FakeWebSocket {
  readonly sentTypes: string[] = [];
  readonly sentRequests: Array<{ type: string; requestId: string }> = [];
  send(data: unknown): void {
    try {
      const request = JSON.parse(String(data)) as { type: string; requestId: string };
      this.sentTypes.push(request.type);
      this.sentRequests.push(request);
    } catch {
      // Non-JSON control frame: not a device request.
    }
    super.send(data as never);
  }
}

describe("a storage write whose call was cancelled before it was sent", () => {
  let client: AndroidCtrlProxyClient;
  let socket: CapturingWebSocket;

  beforeEach(async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    adb.setScreenState(true);
    adb.setCommandResponse("pidof", { stdout: "4242\n", stderr: "" });
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(
      device,
      new FakeAdbClientFactory(),
    ).clearAvailabilityCache();
    let created: CapturingWebSocket | undefined;
    client = AndroidCtrlProxyClient.createForTesting(
      device,
      adb,
      (url) => (created = new CapturingWebSocket(url, "none", 0, timer)),
      timer,
    );
    await client.ensureConnected();
    socket = created!;
    if (socket.readyState !== WebSocketState.OPEN) {
      await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    }
    socket.sentTypes.length = 0;
    socket.sentRequests.length = 0;
  });

  /** Run `write` under a call signal that is cancelled before the write's first await settles. */
  async function writeUnderCutCall(write: () => Promise<unknown>): Promise<void> {
    const call = new AbortController();
    const pending = runWithAbortSignal(call.signal, write).catch(() => undefined);
    call.abort(new Error("session released during the call"));
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    await client.close();
    await pending;
  }

  test("clearPreferenceStore of a cancelled call is not sent to the device", async () => {
    await writeUnderCutCall(() => client.clearPreferenceStore("com.example", "prefs"));

    expect(socket.sentTypes).toEqual([]);
  });

  test("setPreference of a cancelled call is not sent to the device", async () => {
    await writeUnderCutCall(() =>
      client.setPreference("com.example", "prefs", "key", "value", "STRING"),
    );

    expect(socket.sentTypes).toEqual([]);
  });

  test("removePreference of a cancelled call is not sent to the device", async () => {
    await writeUnderCutCall(() => client.removePreference("com.example", "prefs", "key"));
    expect(socket.sentTypes).toEqual([]);
  });

  for (const method of ["setPreference", "removePreference", "clearPreferenceStore"] as const) {
    test(`${method} with no call signal is still sent and succeeds`, async () => {
      try {
        const pending =
          method === "setPreference"
            ? client.setPreference("com.example", "prefs", "k", "v", "STRING")
            : method === "removePreference"
              ? client.removePreference("com.example", "prefs", "k")
              : client.clearPreferenceStore("com.example", "prefs");
        for (let i = 0; i < 20; i++) {
          await Promise.resolve();
        }
        const type =
          method === "setPreference"
            ? "set_preference"
            : method === "removePreference"
              ? "remove_preference"
              : "clear_preferences";
        expect(socket.sentTypes).toEqual([type]);
        socket.simulateMessage(
          JSON.stringify({
            type: `${type}_result`,
            requestId: socket.sentRequests[0].requestId,
            success: true,
          }),
        );
        await pending;
      } finally {
        await client.close();
      }
    });
  }
});

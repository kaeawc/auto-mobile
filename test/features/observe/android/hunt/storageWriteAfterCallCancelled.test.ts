import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../../../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../../../../src/features/observe/android";
import type { BootedDevice } from "../../../../../src/models";
import { runWithAbortSignal } from "../../../../../src/utils/AbortContext";
import { FakeAdbClientFactory } from "../../../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../../../fakes/FakeWebSocket";

/**
 * Hunt (socket-frames-4): a storage mutation whose call was cut before the write left the host.
 *
 * A mutating `ide/*` frame (and the `setKeyValue` family of tools) is a control call on the
 * holder's session: a release that lands while it runs cancels its execution, and
 * `runTrackedIdeMutation` runs the route's device work under that signal so the frame answers
 * `session_ownership_lost` (#11486). The device work is `CtrlProxyStorage.setPreference` /
 * `removePreference` / `clearPreferenceStore`, which await the device connection and then send,
 * and never read the call's abort signal. So a write cut while its connection was still being
 * (re)established is sent to a device the session no longer holds, after the caller was refused.
 * Only the adb legs of these routes (the direct-file fallback, `ide/updateService`) read the
 * ambient signal; the SDK write, the common path, does not.
 */

const device: BootedDevice = {
  deviceId: "hunt-storage-device",
  platform: "android",
  isEmulator: true,
  name: "Hunt Device",
};

class CapturingWebSocket extends FakeWebSocket {
  readonly sentTypes: string[] = [];
  send(data: unknown): void {
    try {
      this.sentTypes.push((JSON.parse(String(data)) as { type: string }).type);
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
});

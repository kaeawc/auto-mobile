import { beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyManager } from "../../../../src/ctrlProxy/CtrlProxyManager";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { BootedDevice } from "../../../../src/models";
import { adbTransportRecoveredSignal } from "../../../../src/utils/android-cmdline-tools/adbTransportRecoveredSignal";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";

/** #17168: a CtrlProxy (re)connect tells transport-scoped state (adb reverse) to re-apply itself. */
describe("AndroidCtrlProxyClient - transport recovered on connect", () => {
  const device: BootedDevice = {
    deviceId: "test-device-transport-recovered",
    platform: "android",
    name: "Test Device",
  };
  let fakeAdb: FakeAdbExecutor;
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", createExecResult("8765", ""));
    fakeAdb.setScreenState(true);
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(
      device,
      new FakeAdbClientFactory(),
    ).clearAvailabilityCache();
  });

  test("an established connection reports ctrl_proxy_reconnect for its device", async () => {
    let socket: FakeWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(device, fakeAdb, {
      webSocketFactory: (url: string) => {
        socket = new FakeWebSocket(url, "none", 0, timer);
        return socket;
      },
      timer,
    });
    const recovered: string[] = [];
    const stop = adbTransportRecoveredSignal.subscribe((deviceId, reason) =>
      recovered.push(`${deviceId} ${reason}`),
    );
    try {
      await client.ensureConnected();
      for (let i = 0; i < 10 && recovered.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect((socket as FakeWebSocket | null)?.readyState).toBe(WebSocketState.OPEN);
      expect(recovered).toEqual([`${device.deviceId} ctrl_proxy_reconnect`]);
    } finally {
      stop();
      await client.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { BootedDevice } from "../../../../src/models";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

describe("AndroidCtrlProxyClient node action selector capabilities", function () {
  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let testDevice: BootedDevice;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    fakeAdb.setScreenState(true);
    testDevice = {
      deviceId: "test-device-capabilities",
      platform: "android",
      isEmulator: true,
      name: "Test Device",
    };
    AndroidCtrlProxyManager.resetInstances();
    AndroidCtrlProxyClient.resetInstances();
    AndroidCtrlProxyManager.getInstance(
      testDevice,
      new FakeAdbClientFactory(),
    ).clearAvailabilityCache();
  });

  afterEach(async function () {
    AndroidCtrlProxyClient.resetInstances();
  });

  test("waits for the connected handshake before reading node selector support", async function () {
    let socket: FakeWebSocket | null = null;
    const client = AndroidCtrlProxyClient.createForTesting(
      testDevice,
      fakeAdb,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, fakeTimer);
        return socket as unknown as WebSocket;
      },
      fakeTimer,
    );

    try {
      await client.ensureConnected();
      const supported = client.supportsNodeActionSelectors();
      let resolved = false;
      void supported.then(() => {
        resolved = true;
      });

      await waitForPendingSleep(fakeTimer);
      expect(resolved).toBe(false);
      socket!.simulateMessage(
        JSON.stringify({
          type: "connected",
          supportedCommands: ["node_selector_actions"],
        }),
      );
      fakeTimer.resolveAll();

      await expect(supported).resolves.toBe(true);
    } finally {
      await client.close();
    }
  });
});

async function waitForPendingSleep(timer: FakeTimer): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (timer.getPendingSleepCount() > 0) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Expected the capability probe to wait for the connected handshake");
}

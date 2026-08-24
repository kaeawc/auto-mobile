import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { AndroidCtrlProxyManager } from "../../../../src/utils/CtrlProxyManager";
import { serverConfig } from "../../../../src/utils/ServerConfig";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { BootedDevice } from "../../../../src/models";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

/**
 * Regression coverage (issue occlusion-flag): the daemon computed occlusionEnabled=false
 * correctly, but the on-device push only ever fired from onConnectionEstablished() — which
 * connectWebSocket() skips entirely when a connection is already open and reused. This left
 * a window where a client that connected before the flag flipped (or reused a connection
 * across multiple observe calls) never received the updated accessibility flags. ensureConnected()
 * now re-syncs unconditionally on every call, not just on a fresh connect.
 */
describe("AndroidCtrlProxyClient - accessibility flags re-sync on ensureConnected", function () {
  let fakeAdb: FakeAdbExecutor;
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort: number = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    fakeAdb = new FakeAdbExecutor();
    fakeAdb.setCommandResponse("forward", { stdout: `${serverPort}`, stderr: "" });
    fakeAdb.setScreenState(true);

    testDevice = {
      deviceId: "test-device-a11y-flags-sync",
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

  afterEach(function () {
    // ServerConfig is a process-wide singleton; restore the default so this test
    // does not leak occlusionEnabled=false into other test files.
    serverConfig.setOcclusionEnabled(true);
  });

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];
    send(data: any): void {
      this.sentMessages.push(data.toString());
      super.send(data);
    }
  }

  const createCapturingFactory = (
    timer?: FakeTimer,
  ): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      getSocket: () => socket,
    };
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  };

  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null,
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i++) {
      const s = getSocket();
      if (s) {
        return s;
      }
      await new Promise((r) => setImmediate(r));
    }
    return getSocket();
  };

  const waitForSentMessages = async (
    socket: CapturingWebSocket | null,
    minCount: number,
  ): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let i = 0; i < 10; i++) {
      if (socket.sentMessages.length >= minCount) {
        return;
      }
      await new Promise((r) => setImmediate(r));
    }
  };

  const findSentMessages = (socket: CapturingWebSocket, type: string): any[] =>
    socket.sentMessages
      .map((raw) => {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      })
      .filter((parsed) => parsed?.type === type);

  test("pushes set_accessibility_flags with occlusionEnabled=false on the first connect", async function () {
    serverConfig.setOcclusionEnabled(false);
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket, 1);

      const flagMessages = findSentMessages(socket!, "set_accessibility_flags");
      expect(flagMessages.length).toBeGreaterThanOrEqual(1);
      expect(flagMessages[0].occlusionEnabled).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("re-syncs set_accessibility_flags on ensureConnected even when reusing an already-open connection", async function () {
    serverConfig.setOcclusionEnabled(false);
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await waitForSentMessages(socket, 1);

      const afterFirstConnect = findSentMessages(socket!, "set_accessibility_flags").length;
      expect(afterFirstConnect).toBeGreaterThanOrEqual(1);

      // Second ensureConnected() call reuses the already-open socket (connectWebSocket's
      // "already connected, reusing" early-return skips onConnectionEstablished entirely),
      // so this only re-sends if ensureConnected's own re-sync fires independently of that.
      await client.ensureConnected();
      await waitForSentMessages(socket, afterFirstConnect + 1);

      const afterSecondCall = findSentMessages(socket!, "set_accessibility_flags").length;
      expect(afterSecondCall).toBeGreaterThan(afterFirstConnect);
    } finally {
      await client.close();
    }
  });

  test("does not push set_accessibility_flags when every flag is already at its default", async function () {
    // occlusionEnabled defaults to true and is left untouched here — matches
    // reportViewIds/includeNotImportantViews/retrieveInteractiveWindows all being
    // default-enabled, so the allEnabled early-return should skip the push entirely.
    const { factory, getSocket } = createCapturingFactory(fakeTimer);
    const client = AndroidCtrlProxyClient.createForTesting(testDevice, fakeAdb, factory, fakeTimer);
    try {
      await client.ensureConnected();
      const socket = await waitForSocket(getSocket);
      await waitForSocketOpen(socket);
      await new Promise((r) => setImmediate(r));

      expect(findSentMessages(socket!, "set_accessibility_flags").length).toBe(0);
    } finally {
      await client.close();
    }
  });
});

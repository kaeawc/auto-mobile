import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { BootedDevice } from "../../../../src/models";
import { FakeWebSocket, WebSocketState } from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { DeviceConnectionLostNotifier } from "../../../../src/features/observe/DeviceConnectionLostNotifier";

/**
 * Pins single-cycle onConnectionClosed() semantics for issue #5657:
 *
 * - An explicit close() must drive exactly ONE onConnectionClosed() cycle, not
 *   two (the synchronous call inside close() PLUS the socket's async `close`
 *   event whose listeners were never detached).
 * - An unsolicited socket drop (only the `close` event, no close() call) must
 *   still drive exactly one cycle — no regression to the real-drop path.
 *
 * onDeviceConnectionLost fan-out is the public-observable side-effect of the
 * cycle (it and consecutiveConnectionFailures++ live in the same
 * onConnectionClosed() body), so its call count pins the cycle count.
 */

const testDevice: BootedDevice = {
  deviceId: "test-sim-id",
  platform: "ios",
  name: "Test iPhone",
};

function createCountingNotifier(): DeviceConnectionLostNotifier & { count: number } {
  const notifier = {
    count: 0,
    onDeviceConnectionLost(_deviceId: string): void {
      notifier.count++;
    },
  };
  return notifier;
}

/** Flush the FakeWebSocket's real-setImmediate close-handshake emit. */
function flushSetImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("DeviceServiceClient close() single onConnectionClosed cycle (#5657)", () => {
  let client: IOSCtrlProxyClient | null = null;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    // A connected iOS client polls the runner's /sdk-events endpoint on
    // onConnectionEstablished(). Stub fetch so the unit test makes no real
    // network call and leaks no polling handles into sibling suites.
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => [],
    })) as unknown as typeof fetch;
  });

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    globalThis.fetch = originalFetch;
    IOSCtrlProxyClient.resetInstances();
  });

  test("explicit close() fires onDeviceConnectionLost exactly once", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const notifier = createCountingNotifier();

    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => new FakeWebSocket(url, "none", 0, fakeTimer),
      fakeTimer,
      undefined,
      undefined,
      notifier,
    );

    // Establish a real (fake) socket so close() has a live socket to tear down.
    const connected = await client.ensureConnected();
    expect(connected).toBe(true);

    await client.close();
    // Let the socket's async close-handshake emit fire; without the fix its
    // still-attached `close` listener would drive a SECOND onConnectionClosed().
    await flushSetImmediate();
    await flushSetImmediate();

    expect(notifier.count).toBe(1);
    // afterEach's close() on an already-closed client must not re-fire the hook.
    client = null;
  });

  test("unsolicited socket drop fires onDeviceConnectionLost exactly once", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const notifier = createCountingNotifier();

    let socket: FakeWebSocket | null = null;
    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, fakeTimer);
        return socket;
      },
      fakeTimer,
      undefined,
      undefined,
      notifier,
    );

    const connected = await client.ensureConnected();
    expect(connected).toBe(true);
    expect(socket).not.toBeNull();

    // Simulate a genuine network drop: the socket emits `close` on its own,
    // no close() call. This must route through the ws.on("close") handler once.
    socket!.emit("close");
    await flushSetImmediate();

    expect(notifier.count).toBe(1);
  });

  test("a stale socket close cannot tear down its live replacement", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const sockets: FakeWebSocket[] = [];

    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, fakeTimer);
        sockets.push(socket);
        return socket;
      },
      fakeTimer,
    );

    expect(await client.ensureConnected()).toBe(true);
    const oldSocket = sockets[0];
    oldSocket.readyState = WebSocketState.CLOSING;

    expect(await client.ensureConnected()).toBe(true);
    expect(sockets).toHaveLength(2);
    expect(client.isConnected()).toBe(true);

    oldSocket.emit("close");
    await flushSetImmediate();

    expect(sockets[1].readyState).toBe(WebSocketState.OPEN);
    expect(client.isConnected()).toBe(true);
  });

  test("unsolicited socket drop immediately rejects in-flight requests", async () => {
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    let socket: FakeWebSocket | null = null;

    client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      (url) => {
        socket = new FakeWebSocket(url, "none", 0, fakeTimer);
        return socket;
      },
      fakeTimer,
    );

    expect(await client.ensureConnected()).toBe(true);
    const request = client.requestSwipe(0, 0, 10, 10, 300, 60_000);
    await flushSetImmediate();
    const requestManager = (
      client as unknown as {
        requestManager: { getPendingCount(): number };
      }
    ).requestManager;
    expect(requestManager.getPendingCount()).toBe(1);

    socket!.emit("close");

    expect(requestManager.getPendingCount()).toBe(0);
    await expect(request).rejects.toThrow("WebSocket connection closed");
  });
});

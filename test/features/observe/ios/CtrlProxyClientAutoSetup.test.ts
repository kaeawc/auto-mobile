import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { BootedDevice } from "../../../../src/models";
import {
  createInstantFailureWebSocketFactory,
  createSuccessWebSocketFactory,
  FakeWebSocket,
  WebSocketState,
} from "../../../fakes/FakeWebSocket";
import type WebSocket from "ws";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";
import type {
  ServiceManagerFactory,
  BootedDeviceLister,
} from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { IOSCtrlProxyManager } from "../../../../src/utils/IOSCtrlProxyManager";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(iterations: number = 5): Promise<void> {
  for (let i = 0; i < iterations; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * A FakeWebSocket whose close() does not auto-emit "close". The test emits the
 * close event manually, so a discarded socket's delayed close-handshake can be
 * made to land AFTER a replacement connection is already live — the race the
 * generation guard must survive.
 */
class ManualCloseWebSocket extends FakeWebSocket {
  override close(): void {
    this.readyState = WebSocketState.CLOSING;
  }
}

describe("IOSCtrlProxyClient auto-setup", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  let fakeManager: FakeIOSCtrlProxyManager;
  const serverPort = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };

    fakeManager = new FakeIOSCtrlProxyManager();

    IOSCtrlProxyClient.resetInstances();
  });

  afterEach(async function () {
    IOSCtrlProxyClient.resetInstances();
  });

  const createManagerFactory = (): ServiceManagerFactory => {
    return () => fakeManager;
  };

  test("auto-setup triggered when WebSocket fails", async function () {
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
    );

    await client.ensureConnected();

    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });

  test("connect succeeds after auto-setup starts service", async function () {
    let callCount = 0;
    const wsFactory = (url: string) => {
      callCount++;
      if (callCount <= 1) {
        // First call fails (before auto-setup)
        return createInstantFailureWebSocketFactory(fakeTimer)(url);
      }
      // After auto-setup, connection succeeds
      return createSuccessWebSocketFactory(fakeTimer)(url);
    };

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      wsFactory,
      fakeTimer,
      createManagerFactory(),
    );

    const result = await client.ensureConnected();

    expect(result).toBe(true);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });

  test("retries on manager port when already-running service moved ports", async function () {
    fakeManager.setRunning(true);
    fakeManager.setServicePort(8767);
    const urls: string[] = [];
    let callCount = 0;
    const wsFactory = (url: string) => {
      urls.push(url);
      callCount++;
      if (callCount === 1) {
        return createInstantFailureWebSocketFactory(fakeTimer)(url);
      }
      return createSuccessWebSocketFactory(fakeTimer)(url);
    };

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      wsFactory,
      fakeTimer,
      createManagerFactory(),
    );

    const result = await client.ensureConnected();

    expect(result).toBe(true);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(false);
    expect(urls).toEqual(["ws://localhost:8765/ws", "ws://localhost:8767/ws"]);

    await client.close();
  });

  test("getInstance reuses the device singleton when the service port changes", async function () {
    const client = IOSCtrlProxyClient.getInstance(testDevice, 8765);
    const sameClient = IOSCtrlProxyClient.getInstance(testDevice, 8767);

    expect(sameClient).toBe(client);
    expect((sameClient as unknown as { getWebSocketUrl: () => string }).getWebSocketUrl()).toBe(
      "ws://localhost:8767/ws",
    );

    await client.close();
  });

  test("port changes force the next connection to use the new WebSocket URL", async function () {
    const urls: string[] = [];
    const wsFactory = (url: string) => {
      urls.push(url);
      return createSuccessWebSocketFactory(fakeTimer)(url);
    };
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      wsFactory,
      fakeTimer,
      createManagerFactory(),
    );

    expect(await client.ensureConnected()).toBe(true);

    (client as unknown as { updatePort: (port: number) => void }).updatePort(8767);

    expect(await client.ensureConnected()).toBe(true);
    expect(urls).toEqual(["ws://localhost:8765/ws", "ws://localhost:8767/ws"]);

    await client.close();
  });

  test("updatePort during an in-flight connect discards a socket that opens on the old port (#5645)", async function () {
    // Manual (non-auto-advancing) timer so the in-flight handshake stays pending
    // until we fire `open` ourselves, and the connection timeout never fires.
    const manualTimer = new FakeTimer();
    const sockets: { url: string; socket: ManualCloseWebSocket }[] = [];
    const wsFactory = (url: string): WebSocket => {
      // "timeout" mode keeps the socket CONNECTING (the timer is never advanced);
      // ManualCloseWebSocket also defers the "close" event to our control.
      const socket = new ManualCloseWebSocket(url, "timeout", 60_000, manualTimer);
      sockets.push({ url, socket });
      return socket as unknown as WebSocket;
    };
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      wsFactory,
      manualTimer,
      createManagerFactory(),
    );
    // Exercise the base-class connect directly so the assertion targets the
    // generation guard without the iOS auto-setup wrapper reacting to a failed
    // handshake.
    const connect = (client as unknown as { connectWebSocket: () => Promise<boolean> })
      .connectWebSocket;
    const updatePort = (
      client as unknown as { updatePort: (port: number) => void }
    ).updatePort.bind(client);
    try {
      // Start a connect and let it reach the in-flight state: socket CONNECTING,
      // this.ws still null, isConnecting true. The URL was built from the old port.
      const connectPromise = connect.call(client);
      await flushPromises(8);
      expect(sockets.length).toBe(1);
      expect(sockets[0].url).toBe("ws://localhost:8765/ws");
      expect(client.isConnected()).toBe(false);

      // A port reallocation races the in-flight connect.
      updatePort(8767);

      // The old-port handshake now completes — `open` fires AFTER the port change.
      sockets[0].socket.readyState = WebSocketState.OPEN;
      sockets[0].socket.emit("open");
      await flushPromises(8);

      // AC1: the old-port socket is discarded, not installed as this.ws.
      expect(client.isConnected()).toBe(false);
      await expect(connectPromise).resolves.toBe(false);

      // AC2: a fresh connect targets the NEW port and succeeds — no wedged
      // isConnecting / stale-port state left behind.
      const secondPromise = connect.call(client);
      await flushPromises(8);
      const latest = sockets[sockets.length - 1];
      expect(sockets.length).toBe(2);
      expect(latest.url).toBe("ws://localhost:8767/ws");
      latest.socket.readyState = WebSocketState.OPEN;
      latest.socket.emit("open");
      await flushPromises(8);
      expect(await secondPromise).toBe(true);
      expect(client.isConnected()).toBe(true);

      // The discarded old-port socket's close-handshake finally completes — AFTER
      // the replacement is live. Its stale, unconditional close/error handlers
      // must not run: otherwise the close handler nulls out this.ws, stops the
      // replacement's health check, and schedules a spurious reconnect. The
      // generation guard detaches the invalidated socket's listeners, so this
      // delayed close is a no-op and the replacement stays up. A delayed "error"
      // must not throw either: the guard keeps a lone swallowing error listener,
      // so the discarded socket cannot crash the daemon or disturb the replacement.
      sockets[0].socket.emit("close");
      sockets[0].socket.emit("error", new Error("stale old-port socket reset"));
      await flushPromises(8);
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("late close from a timed-out socket does not disrupt a replacement handshake", async function () {
    const manualTimer = new FakeTimer();
    const sockets: ManualCloseWebSocket[] = [];
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      (url: string): WebSocket => {
        const socket = new ManualCloseWebSocket(url, "timeout", 60_000, manualTimer);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      manualTimer,
      createManagerFactory(),
    );
    const connect = (client as unknown as { connectWebSocket: () => Promise<boolean> })
      .connectWebSocket;
    try {
      const first = connect.call(client);
      await flushPromises(8);
      manualTimer.advanceTime(5_000);
      await expect(first).resolves.toBe(false);

      const replacement = connect.call(client);
      await flushPromises(8);
      expect(sockets).toHaveLength(2);
      sockets[1].readyState = WebSocketState.OPEN;
      sockets[1].emit("open");
      await expect(replacement).resolves.toBe(true);

      sockets[0].emit("close");
      await flushPromises(8);
      expect(client.isConnected()).toBe(true);
      expect(sockets).toHaveLength(2);
    } finally {
      await client.close();
    }
  });

  test("updatePort eagerly aborts a hung in-flight handshake so the new-port connect proceeds immediately (#5656)", async function () {
    // Frozen manual timer: it is NEVER advanced, so neither the 5s connection
    // timeout nor the "connection already in progress" poll interval can fire.
    // The new-port connect can therefore only proceed if updatePort() eagerly
    // aborts the hung handshake and clears isConnecting — not by waiting out the
    // connectionTimeoutMs.
    const manualTimer = new FakeTimer();
    const sockets: { url: string; socket: ManualCloseWebSocket }[] = [];
    const wsFactory = (url: string): WebSocket => {
      // "timeout" mode + a never-advanced timer keeps the socket in CONNECTING
      // forever, emitting NEITHER "open" NOR "error" — a wedged handshake.
      const socket = new ManualCloseWebSocket(url, "timeout", 60_000, manualTimer);
      sockets.push({ url, socket });
      return socket as unknown as WebSocket;
    };
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      wsFactory,
      manualTimer,
      createManagerFactory(),
    );
    const connect = (client as unknown as { connectWebSocket: () => Promise<boolean> })
      .connectWebSocket;
    const updatePort = (
      client as unknown as { updatePort: (port: number) => void }
    ).updatePort.bind(client);
    try {
      // Start a connect and let it reach the in-flight state: socket CONNECTING,
      // this.ws still null, isConnecting true, emitting nothing.
      const connectPromise = connect.call(client);
      await flushPromises(8);
      expect(sockets.length).toBe(1);
      expect(sockets[0].url).toBe("ws://localhost:8765/ws");
      expect(client.isConnected()).toBe(false);

      // A port reallocation races the wedged handshake.
      updatePort(8767);
      await flushPromises(8);

      // AC1: the hung handshake is aborted eagerly — its connect resolves as a
      // failure instead of hanging until connectionTimeoutMs (which never fires
      // here because the timer is frozen).
      await expect(connectPromise).resolves.toBe(false);

      // AC2: a fresh connect dials the NEW port IMMEDIATELY, without waiting out
      // any 5s stall. Before the fix, isConnecting stayed true, so this connect
      // took the "connection already in progress, waiting…" branch and polled a
      // frozen timer forever — no second socket would ever be created.
      const secondPromise = connect.call(client);
      await flushPromises(8);
      expect(sockets.length).toBe(2);
      const latest = sockets[sockets.length - 1];
      expect(latest.url).toBe("ws://localhost:8767/ws");

      latest.socket.readyState = WebSocketState.OPEN;
      latest.socket.emit("open");
      await flushPromises(8);
      expect(await secondPromise).toBe(true);
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("a port change resets the per-endpoint attempt budget so the new port is not cooldown-blocked (#5645)", async function () {
    // Frozen manual timer: the cooldown window never elapses on its own, so only a
    // budget reset (not the passage of time) can let the new-port connect through.
    const manualTimer = new FakeTimer();
    const wsFactory = (url: string): WebSocket => {
      // The old port fails instantly (exhausting the budget); the new port connects.
      const mode: "none" | "instant" = url.includes(":8767") ? "none" : "instant";
      return new FakeWebSocket(url, mode, 0, manualTimer) as unknown as WebSocket;
    };
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      8765,
      wsFactory,
      manualTimer,
      createManagerFactory(),
    );
    const connect = (client as unknown as { connectWebSocket: () => Promise<boolean> })
      .connectWebSocket;
    const updatePort = (
      client as unknown as { updatePort: (port: number) => void }
    ).updatePort.bind(client);
    try {
      // Exhaust the attempt budget against the old port (default max is 3).
      for (let i = 0; i < 3; i += 1) {
        expect(await connect.call(client)).toBe(false);
      }
      // Now cooled down: another old-port connect is refused without dialing.
      expect(await connect.call(client)).toBe(false);
      expect(client.getReconnectStatus()).not.toBeNull();

      // A real port change resets the per-endpoint budget...
      updatePort(8767);
      expect(client.getReconnectStatus()).toBeNull();

      // ...so a fresh connect to the new port succeeds immediately — no waiting out
      // the old port's cooldown.
      expect(await connect.call(client)).toBe(true);
      expect(client.isConnected()).toBe(true);
    } finally {
      await client.close();
    }
  });

  test("no auto-setup when already connected", async function () {
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createSuccessWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
    );

    const result = await client.ensureConnected();

    expect(result).toBe(true);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(false);

    await client.close();
  });

  test("waits for startup reaping before connecting directly to an existing runner", async function () {
    const reaping = deferred();
    const reapSpy = spyOn(
      IOSCtrlProxyManager,
      "reapOrphanedRunnerProcessesOnStartup",
    ).mockImplementation(() => reaping.promise);
    const urls: string[] = [];
    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      (url) => {
        urls.push(url);
        return createSuccessWebSocketFactory(fakeTimer)(url);
      },
      fakeTimer,
      createManagerFactory(),
    );

    try {
      IOSCtrlProxyManager.startOrphanRunnerReapOnStartup();
      const connecting = client.ensureConnected();
      await Promise.resolve();

      expect(urls).toEqual([]);

      reaping.resolve();
      await expect(connecting).resolves.toBe(true);
      expect(urls).toEqual(["ws://localhost:8765/ws"]);
    } finally {
      reaping.resolve();
      await client.close();
      reapSpy.mockRestore();
      IOSCtrlProxyManager.resetInstances();
    }
  });

  test("setup failure handled gracefully", async function () {
    fakeManager.setSetupShouldFail(true);

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
    );

    const result = await client.ensureConnected();

    expect(result).toBe(false);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });

  test("guard prevents re-entry during auto-setup", async function () {
    // Create a manager where setup triggers another ensureConnected call
    let reentrantCallResult: boolean | null = null;
    // Use a ref object so the closure captures a mutable reference
    const clientRef: { current: IOSCtrlProxyClient | null } = { current: null };

    const reentrantManager = new FakeIOSCtrlProxyManager();
    const originalSetup = reentrantManager.setup.bind(reentrantManager);
    reentrantManager.setup = async (force, perf) => {
      // During setup, try calling ensureConnected again (simulates re-entry)
      reentrantCallResult = await clientRef.current!.ensureConnected();
      return originalSetup(force, perf);
    };

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      () => reentrantManager,
    );
    clientRef.current = client;

    await client.ensureConnected();

    // The re-entrant call should have returned false immediately
    expect(reentrantCallResult).toBe(false);

    await client.close();
  });

  test("skips auto-setup when target simulator is no longer booted", async function () {
    // Device lister returns empty — simulator has been shut down
    const lister: BootedDeviceLister = async () => [];

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
      lister,
    );

    const result = await client.ensureConnected();

    expect(result).toBe(false);
    // setup should NOT have been called since the simulator is not booted
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(false);

    await client.close();
  });

  test("skips auto-setup when a different simulator is booted", async function () {
    // A different simulator is booted, but not our target
    const otherDevice: BootedDevice = {
      deviceId: "FFFFFFFF-0000-1111-2222-333333333333",
      platform: "ios",
      name: "iPhone 15 Simulator",
    };
    const lister: BootedDeviceLister = async () => [otherDevice];

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
      lister,
    );

    const result = await client.ensureConnected();

    expect(result).toBe(false);
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(false);

    await client.close();
  });

  test("proceeds with auto-setup when target simulator is still booted", async function () {
    // Device lister returns our target simulator as booted
    const lister: BootedDeviceLister = async () => [testDevice];

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
      lister,
    );

    await client.ensureConnected();

    // setup should have been called since the simulator is booted
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });

  test("proceeds with auto-setup when boot check fails", async function () {
    // Device lister throws — should not prevent auto-setup
    const lister: BootedDeviceLister = async () => {
      throw new Error("simctl not available");
    };

    const client = IOSCtrlProxyClient.createForTesting(
      testDevice,
      serverPort,
      createInstantFailureWebSocketFactory(fakeTimer),
      fakeTimer,
      createManagerFactory(),
      lister,
    );

    await client.ensureConnected();

    // setup should still proceed when boot check fails
    expect(fakeManager.wasMethodCalled("setup:force=true")).toBe(true);

    await client.close();
  });
});

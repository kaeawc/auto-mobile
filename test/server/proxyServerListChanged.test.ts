import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeTimer } from "../fakes/FakeTimer";

// Issue #3223: the proxy MCP server re-emits daemon-forwarded list-changed
// notifications to its own (external) client.

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

function createHarness() {
  isAvailableSpy ??= spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const fakeClient = new FakeDaemonClient({
    daemonMethodResults: new Map<string, any>([["tools/list", { tools: [] }]]),
  });
  const fakeManager = new FakeDaemonManager();
  fakeManager.statusResult = {
    running: true,
    pid: 1234,
    port: 3000,
    socketPath: "/tmp/test.sock",
    version: DAEMON_VERSION,
  };
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      timer: new FakeTimer(),
      clientFactory: () => fakeClient,
      daemonManager: fakeManager,
      autoStartDaemon: false,
    },
  });
  return { server, proxy, fakeClient };
}

beforeAll(async () => {
  // Warm one-off SDK handler/schema initialization without sharing a measured harness.
  const { server, proxy } = createHarness();
  try {
    await proxy.listTools();
  } finally {
    await server.close();
    await proxy.close();
    isAvailableSpy?.mockRestore();
    isAvailableSpy = null;
  }
});

describe("createProxyMcpServer list-changed forwarding", () => {
  test("daemon tools/list_changed is re-emitted as sendToolListChanged", async () => {
    const { server, proxy, fakeClient } = createHarness();
    const sendToolsSpy = spyOn(server, "sendToolListChanged").mockImplementation(() => {});
    const sendResourcesSpy = spyOn(server, "sendResourceListChanged").mockImplementation(() => {});

    await proxy.listTools();
    fakeClient.emitNotification("notifications/tools/list_changed");

    expect(sendToolsSpy).toHaveBeenCalledTimes(1);
    expect(sendResourcesSpy).not.toHaveBeenCalled();
  });

  test("daemon resources/list_changed is re-emitted as sendResourceListChanged", async () => {
    const { server, proxy, fakeClient } = createHarness();
    const sendToolsSpy = spyOn(server, "sendToolListChanged").mockImplementation(() => {});
    const sendResourcesSpy = spyOn(server, "sendResourceListChanged").mockImplementation(() => {});

    await proxy.listTools();
    fakeClient.emitNotification("notifications/resources/list_changed");

    expect(sendResourcesSpy).toHaveBeenCalledTimes(1);
    expect(sendToolsSpy).not.toHaveBeenCalled();
  });

  test("a throwing send is swallowed (dead transport never breaks the proxy)", async () => {
    const { server, proxy, fakeClient } = createHarness();
    spyOn(server, "sendToolListChanged").mockImplementation(() => {
      throw new Error("transport torn down");
    });

    await proxy.listTools();

    expect(() => fakeClient.emitNotification("notifications/tools/list_changed")).not.toThrow();
  });

  test("without a connected transport the real send helpers are safe no-ops", async () => {
    const { proxy, fakeClient } = createHarness();

    await proxy.listTools();

    // No transport is connected in this test, so the SDK's isConnected() guard
    // makes the un-mocked send helpers no-ops — the emit must not throw.
    expect(() => fakeClient.emitNotification("notifications/tools/list_changed")).not.toThrow();
  });
});

describe("proxy resource subscriptions", () => {
  async function wireHarness() {
    const harness = createHarness();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscriptions", version: "1" });
    const received: string[] = [];
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      received.push(notification.params.uri);
    });
    await harness.server.connect(serverTransport);
    await client.connect(clientTransport);
    return { ...harness, client, received };
  }

  function update(fakeClient: FakeDaemonClient, uri: string) {
    fakeClient.emitNotification(
      "notifications/resources/updated",
      undefined,
      undefined,
      undefined,
      uri,
    );
  }

  async function close(harness: Awaited<ReturnType<typeof wireHarness>>) {
    await harness.client.close();
    await harness.server.close();
    await harness.proxy.close();
  }

  test("initialize advertises subscribe and listChanged", async () => {
    const harness = await wireHarness();
    try {
      expect(harness.client.getServerCapabilities()?.resources).toEqual({
        subscribe: true,
        listChanged: true,
      });
    } finally {
      await close(harness);
    }
  });

  test("a cold subscribe is answered while the daemon connect is still pending", async () => {
    const harness = await wireHarness();
    const connectGate = Promise.withResolvers<void>();
    const connect = harness.fakeClient.connect.bind(harness.fakeClient);
    const connectSpy = spyOn(harness.fakeClient, "connect").mockImplementation(async () => {
      await connectGate.promise;
      await connect();
    });
    try {
      expect(await harness.client.subscribeResource({ uri: "automobile:one" })).toEqual({});
      // The reply arrived while the background connect it started is still gated.
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(harness.proxy.isConnected()).toBe(false);
      expect(harness.fakeClient.callDaemonMethodCalls).toEqual([]);

      connectGate.resolve();
      await harness.proxy.ensureConnected();
      expect(harness.fakeClient.callDaemonMethodCalls).toEqual([
        { method: "resources/subscribe", params: { uri: "automobile:one" } },
      ]);
    } finally {
      connectGate.resolve();
      connectSpy.mockRestore();
      await close(harness);
    }
  });

  test("subscribe/unsubscribe return empty results and filter updates per connection", async () => {
    const first = await wireHarness();
    const second = await wireHarness();
    try {
      expect(await first.client.subscribeResource({ uri: "automobile:one" })).toEqual({});
      expect(await second.client.subscribeResource({ uri: "automobile:two" })).toEqual({});
      // A cold subscription is answered without waiting for the daemon; the background
      // connect it starts replays it exactly once (no duplicate subscribe). Whether that
      // connect lands before or after the client reads the reply is microtask timing,
      // which the SDK v2 handler wrapper shifts (issue #4678), so it is not asserted here.
      await first.proxy.ensureConnected();
      await second.proxy.ensureConnected();
      for (const uri of ["automobile:one", "automobile:two", "automobile:other"]) {
        update(first.fakeClient, uri);
        update(second.fakeClient, uri);
      }
      await first.client.ping();
      await second.client.ping();
      expect(first.received).toEqual(["automobile:one"]);
      expect(second.received).toEqual(["automobile:two"]);
      expect(await first.client.unsubscribeResource({ uri: "automobile:one" })).toEqual({});
      update(first.fakeClient, "automobile:one");
      await first.client.ping();
      expect(first.received).toEqual(["automobile:one"]);
      expect(first.fakeClient.callDaemonMethodCalls).toEqual([
        { method: "resources/subscribe", params: { uri: "automobile:one" } },
        { method: "resources/unsubscribe", params: { uri: "automobile:one" } },
      ]);
    } finally {
      await close(first);
      await close(second);
    }
  });

  test("external transport close clears the proxy's subscriptions and daemon connection", async () => {
    const harness = await wireHarness();
    try {
      await harness.client.subscribeResource({ uri: "automobile:one" });
      await harness.proxy.ensureConnected();
      await harness.client.close();
      update(harness.fakeClient, "automobile:one");
      expect(harness.proxy.isConnected()).toBe(false);
      expect(harness.received).toEqual([]);
    } finally {
      await close(harness);
    }
  });
});

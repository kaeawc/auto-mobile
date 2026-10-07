import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
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
  beforeAll(() => {
    require("@modelcontextprotocol/sdk/types.js");
  });

  async function wireHarness() {
    const harness = createHarness();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-subscriptions", version: "1" });
    const received: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
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

  test("subscribe/unsubscribe return empty results and filter updates per connection", async () => {
    const first = await wireHarness();
    const second = await wireHarness();
    try {
      expect(await first.client.subscribeResource({ uri: "automobile:one" })).toEqual({});
      expect(await second.client.subscribeResource({ uri: "automobile:two" })).toEqual({});
      // A cold subscription is remembered without starting the daemon.
      expect(first.fakeClient.callDaemonMethodCalls).toEqual([]);
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

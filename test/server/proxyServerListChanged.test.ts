import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";

// Issue #3223: the proxy MCP server re-emits daemon-forwarded list-changed
// notifications to its own (external) client.

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

function createHarness() {
  isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
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
      clientFactory: () => fakeClient,
      daemonManager: fakeManager,
      autoStartDaemon: false,
    },
  });
  return { server, proxy, fakeClient };
}

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

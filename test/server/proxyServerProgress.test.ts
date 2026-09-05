import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

/**
 * Proves the fix for issue #6205 (the proxy-mode half of #6118): the DEFAULT
 * deployment forwards `tools/call` through `createProxyMcpServer` /
 * `DaemonMcpProxy`, not the direct server, so it needs its own echo of the
 * client's `_meta.progressToken` across the daemon round trip.
 */
describe("Proxy tools/call relays progress tagged with the client's own token (issue #6205)", () => {
  let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    isAvailableSpy?.mockRestore();
    isAvailableSpy = null;
  });

  async function setup(fakeClient: FakeDaemonClient) {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => fakeClient,
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "progress-test-client", version: "0.0.1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { server, proxy, client };
  }

  test("client onprogress receives a tick carrying the client's own token", async () => {
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      onCallTool: () => {
        // Simulate the daemon relaying one progress tick WHILE the call is in
        // flight, tagged with whatever token this exact call forwarded —
        // mirrors the real socket server echoing the SAME token end to end.
        const token = fakeClient.callToolProgressTokens.at(-1);
        if (token !== undefined) {
          fakeClient.emitProgress(token, 1, 2, "halfway");
        }
      },
    });
    const { proxy, client } = await setup(fakeClient);

    const received: Array<{ progress: number; total?: number }> = [];
    const errors: string[] = [];
    client.onerror = (error) => {
      errors.push(String(error));
    };

    try {
      await client.callTool({ name: "someTool", arguments: {} }, undefined, {
        onprogress: (notification) => {
          received.push(notification as unknown as { progress: number; total?: number });
        },
      });

      expect(received).toHaveLength(1);
      expect(received[0].progress).toBe(1);
      expect(received[0].total).toBe(2);
      // No "unknown token" client error is the proof the proxy echoed the same
      // token the client's SDK registered, rather than a daemon/proxy-fabricated
      // one going astray.
      expect(errors).toHaveLength(0);
    } finally {
      await client.close();
      await proxy.close();
    }
  });

  test("no progress notification reaches the client when it did not request one", async () => {
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    });
    const { proxy, client } = await setup(fakeClient);

    const errors: string[] = [];
    client.onerror = (error) => {
      errors.push(String(error));
    };

    try {
      const result = await client.callTool({ name: "someTool", arguments: {} });

      expect(result).toBeDefined();
      // No client-supplied token: the proxy must forward `undefined`, never a
      // fabricated one, so the daemon relays nothing back.
      expect(fakeClient.callToolProgressTokens).toEqual([undefined]);
      expect(errors).toHaveLength(0);
    } finally {
      await client.close();
      await proxy.close();
    }
  });
});

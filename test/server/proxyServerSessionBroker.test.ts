import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { SESSION_EXPERIMENTAL_CAPABILITY } from "../../src/devices/sessionConfig";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

const pending: SessionBrokerResult = {
  contractVersion: 1,
  requestId: "request-1",
  outcome: "pending",
  sessionUuid: null,
  profile: null,
  cleanupPending: true,
};
const ready: SessionBrokerResult = {
  ...pending,
  outcome: "ready",
  sessionUuid: "session-1",
  profile: {
    platform: "ios",
    metadataState: "current",
    simulatorDeviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
    osVersion: "18.0",
  },
  cleanupPending: false,
};

const servers: Array<{ client: Client; close(): Promise<void> }> = [];
beforeAll(async () => {
  const warm = await serve(pending);
  servers.splice(servers.indexOf(warm), 1);
  await warm.close();
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(result: SessionBrokerResult, fake = new FakeDaemonClient()) {
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  const harness = createProxyMcpServer({
    session: result,
    proxyConfig: {
      timer: new FakeTimer(),
      clientFactory: () => fake,
      daemonManager,
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "session-broker-test", version: "1" });
  await harness.server.connect(serverTransport);
  await client.connect(clientTransport);
  const served = {
    client,
    close: async () => {
      await client.close();
      await harness.server.close();
      await harness.proxy.close();
    },
  };
  servers.push(served);
  return { ...served, fake };
}

describe("session broker MCP exposure", () => {
  test("initialize exposes the flat result while pending serves no tools", async () => {
    const { client, fake } = await serve(pending);

    expect(client.getServerCapabilities()?.experimental?.[SESSION_EXPERIMENTAL_CAPABILITY]).toEqual(
      pending,
    );
    expect((await client.listResources()).resources).toEqual([]);
    expect((await client.listTools()).tools).toEqual([]);
    const call = await client.callTool({ name: "getAndroid", arguments: {} });
    expect(call.isError).toBe(true);
    const payload = JSON.parse(String((call.content as Array<{ text: string }>)[0]!.text));
    expect(payload.error).toMatchObject({
      code: "session_unavailable",
      requestId: "request-1",
      outcome: "pending",
    });
    expect(fake.callToolCalls).toEqual([]);
  });

  test.each(["failed", "released"] as const)(
    "%s requests cannot fall back to generic acquisition",
    async (outcome) => {
      const { client, fake } = await serve({
        ...pending,
        outcome,
        cleanupPending: outcome === "failed",
      });

      expect((await client.listTools()).tools).toEqual([]);
      await client.callTool({ name: "getApple", arguments: {} });
      expect(fake.callToolCalls).toEqual([]);
    },
  );

  test("a terminal daemon result is rewritten without generic acquisition guidance", async () => {
    const fake = new FakeDaemonClient({
      toolResult: {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "session_ownership_lost",
                sessionUuid: "session-1",
                reason: "heartbeat-timeout",
                nextAction: "acquire_new_session",
              },
            }),
          },
        ],
      },
    });
    const { client } = await serve(ready, fake);

    const call = await client.callTool({
      name: "observe",
      arguments: { sessionUuid: "session-1" },
    });
    const payload = JSON.parse(String((call.content as Array<{ text: string }>)[0]!.text));
    expect(payload.error).toMatchObject({
      code: "broker_session_ended",
      requestId: "request-1",
      sessionUuid: "session-1",
      nextAction: "relaunch_session_request",
    });
    expect(payload.error.message).not.toContain("getAndroid");
    expect((await client.listTools()).tools).toEqual([]);
  });
});

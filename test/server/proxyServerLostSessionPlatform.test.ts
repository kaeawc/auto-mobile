import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import {
  DaemonBoundSessionExpiredError,
  DaemonConnectionSessionReleasedError,
} from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client/client";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

// CI's per-test time excludes only beforeAll: pay the SDK's one-off client/server setup here (#14473).
beforeAll(async () => {
  await lostSessionErrorData("android", "listAdvertisedTools", (client) => client.listTools());
});

const discovery = [
  ["tools/list", "listAdvertisedTools", (client: Client) => client.listTools()],
  ["resources/list", "listAdvertisedResources", (client: Client) => client.listResources()],
  [
    "resources/templates/list",
    "listAdvertisedResourceTemplates",
    (client: Client) => client.listResourceTemplates(),
  ],
  [
    "resources/read",
    "readResource",
    (client: Client) => client.readResource({ uri: "automobile:devices/booted" }),
  ],
] as const;

async function lostSessionErrorData(
  platform: string,
  delegate: (typeof discovery)[number][1],
  request: (typeof discovery)[number][2],
  lost: () => Error = () => new DaemonBoundSessionExpiredError("lost-session", "device-killed"),
): Promise<{ message: string; recovery: unknown }> {
  const isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const fakeClient = new FakeDaemonClient({
    daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    toolResultFor: (toolName) =>
      toolName === "startDevice"
        ? {
            content: [],
            structuredContent: {
              platform,
              runtime: { deviceId: "device", session: { sessionUuid: "lost-session" } },
            },
          }
        : undefined,
  });
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      timer: new FakeTimer(),
      clientFactory: () => fakeClient,
      daemonManager,
      autoStartDaemon: false,
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lost-session-platform-client", version: "0.0.1" });
  const forwarding = spyOn(proxy, delegate).mockRejectedValue(lost());
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "startDevice", arguments: { platform } });
    const caught = await request(client).then(
      () => undefined,
      (error: unknown) => error,
    );
    const data = (caught as { data?: { error?: { message: string; recovery: unknown } } }).data;
    if (!data?.error) {
      throw new Error(`expected a terminal-session refusal, got ${String(caught)}`);
    }
    return data.error;
  } finally {
    forwarding.mockRestore();
    isAvailableSpy.mockRestore();
    await client.close();
    await server.close();
    await proxy.close();
  }
}

describe("discovery handlers name a lost session's platform (#19211)", () => {
  test.each(discovery)(
    "%s tells a lost watchOS session to call startDevice",
    async (_method, delegate, request) => {
      const error = await lostSessionErrorData("watchos", delegate, request);
      expect(error.message).toContain('Call startDevice with platform: "watchos"');
      expect(error.recovery).toEqual({
        action: "acquire_replacement_session",
        tools: ["startDevice"],
        platform: "watchos",
      });
    },
  );

  test.each(discovery)(
    "%s keeps getAndroid and getApple for a lost Android session",
    async (_method, delegate, request) => {
      const error = await lostSessionErrorData("android", delegate, request);
      expect(error.recovery).toEqual({
        action: "acquire_replacement_session",
        tools: ["getAndroid", "getApple"],
      });
    },
  );
});

describe("discovery handlers name a released session's platform on no_active_device_session (#19234)", () => {
  const released = () => new DaemonConnectionSessionReleasedError("device-killed", "lost-session");

  test.each(discovery)(
    "%s tells a released watchOS session's connection to call startDevice",
    async (_method, delegate, request) => {
      const error = await lostSessionErrorData("watchos", delegate, request, released);
      expect(error.message).toContain('Call startDevice with platform: "watchos"');
      expect(error.recovery).toEqual({
        action: "acquire_replacement_session",
        tools: ["startDevice"],
        platform: "watchos",
      });
    },
  );
});

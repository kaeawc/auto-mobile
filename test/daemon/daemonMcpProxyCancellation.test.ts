import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient, DaemonRequestNotDeliveredError } from "../../src/daemon/client";
import { DAEMON_CANCEL_REQUEST_METHOD, DAEMON_VERSION } from "../../src/daemon/constants";
import type { DaemonRequest } from "../../src/daemon/types";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function config(clientFactory: () => FakeDaemonClient, timer = new FakeTimer()) {
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  return {
    clientFactory,
    daemonManager,
    timer,
    autoStartDaemon: false,
    daemonAvailabilityProbe: async () => true,
  };
}

async function setup() {
  const timer = new FakeTimer();
  const socket = new FakeSocket();
  const daemonClient = new DaemonClient(
    "/fake/socket",
    1000,
    timer,
    {},
    null,
    new FakeIdGenerator(),
  );
  daemonClient.attachSocketForTesting(socket);
  const fake = new FakeDaemonClient();
  fake.callTool = daemonClient.callTool.bind(daemonClient);
  const { server, proxy } = createProxyMcpServer({ proxyConfig: config(() => fake, timer) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const messages: JSONRPCMessage[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message) => {
    messages.push(message);
    await send(message);
  };
  const client = new Client({ name: "cancel-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  messages.length = 0;
  const respond = (id: string) =>
    daemonClient.simulateIncomingDataForTesting(
      Buffer.from(
        JSON.stringify({
          id,
          type: "mcp_response",
          success: true,
          result: { content: [{ type: "text", text: "ok" }] },
        }) + "\n",
      ),
    );
  const close = async () => {
    await client.close();
    await proxy.close();
    await daemonClient.close();
  };
  return { client, proxy, socket, messages, respond, close, timer, daemonClient };
}

describe("MCP proxy cancellation", () => {
  beforeAll(() => {
    require("@modelcontextprotocol/sdk/types.js");
  });

  test("SDK cancellation forwards exactly one mapped cancel frame and no response; siblings finish", async () => {
    const { client, proxy, socket, messages, respond, close } = await setup();
    const call = spyOn(proxy, "callTool");
    const controller = new AbortController();
    try {
      const cancelled = client
        .callTool({ name: "tapOn", arguments: {} }, undefined, { signal: controller.signal })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      const siblings = [
        client.callTool({ name: "tapOn", arguments: {} }),
        client.callTool({ name: "tapOn", arguments: {} }),
      ];
      await flush();
      const requests = socket.getWrittenMessages<DaemonRequest>();
      expect(requests).toHaveLength(3);
      controller.abort(new Error("cancel requested"));
      await cancelled;
      await flush();
      const frames = socket.getWrittenMessages<DaemonRequest>();
      expect(frames).toHaveLength(4);
      expect(frames[3]).toMatchObject({
        method: DAEMON_CANCEL_REQUEST_METHOD,
        params: { requestId: requests[0].id },
      });
      const signal = call.mock.calls[0][4];
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(true);
      respond(requests[0].id);
      respond(frames[3].id);
      for (const request of requests.slice(1)) {
        respond(request.id);
      }
      await Promise.all(siblings);
      await flush();
      expect(messages.filter((message) => "id" in message)).toHaveLength(2);
    } finally {
      call.mockRestore();
      await close();
    }
  });

  test("unknown and completed MCP request ids are ignored without errors or extra responses", async () => {
    const { client, socket, messages, respond, close } = await setup();
    const errors: Error[] = [];
    client.onerror = (error) => errors.push(error);
    try {
      await client.notification({
        method: "notifications/cancelled",
        params: { requestId: "unknown" },
      });
      await flush();
      expect(socket.getWrittenMessages()).toHaveLength(0);
      const result = client.callTool({ name: "tapOn", arguments: {} });
      await flush();
      respond(socket.getWrittenMessages<DaemonRequest>()[0].id);
      await result;
      const response = messages.find((message) => "id" in message);
      if (!response || !("id" in response)) {
        throw new Error("Missing MCP response");
      }
      await client.notification({
        method: "notifications/cancelled",
        params: { requestId: response.id },
      });
      await flush();
      expect(socket.getWrittenMessages()).toHaveLength(1);
      expect(messages.filter((message) => "id" in message)).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  });

  test("completion racing cancellation produces no late response or completed-request cancel frame", async () => {
    const { client, socket, messages, respond, close } = await setup();
    const controller = new AbortController();
    try {
      const result = client
        .callTool({ name: "tapOn", arguments: {} }, undefined, { signal: controller.signal })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await flush();
      respond(socket.getWrittenMessages<DaemonRequest>()[0].id);
      controller.abort();
      await result;
      await flush();
      expect(socket.getWrittenMessages()).toHaveLength(1);
      expect(messages.filter((message) => "id" in message)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  test("abort while waiting on reconnect settles immediately and prevents replay", async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const stale = new FakeDaemonClient({
      onCallTool: () => {
        throw new DaemonRequestNotDeliveredError("not delivered");
      },
    });
    const fresh = new FakeDaemonClient();
    fresh.connect = async () => {
      started.resolve();
      await gate.promise;
    };
    const clients = [stale, fresh];
    const proxy = new DaemonMcpProxy(config(() => clients.shift()!));
    const controller = new AbortController();
    try {
      const result = proxy.callTool("tapOn", {}, undefined, undefined, controller.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      await started.promise;
      controller.abort(new Error("cancel reconnect"));
      expect(await result).toEqual(controller.signal.reason);
      gate.resolve();
      await flush();
      expect(stale.callToolCalls).toHaveLength(1);
      expect(fresh.callToolCalls).toHaveLength(0);
    } finally {
      gate.resolve();
      await proxy.close();
    }
  });
});

test("stdio MCP caller receives the daemon queue marker at its deadline", async () => {
  const { client, socket, timer, daemonClient, close } = await setup();
  try {
    const result = client.callTool({ name: "tapOn", arguments: {} });
    await flush();
    const request = socket.getWrittenMessages<DaemonRequest>()[0];
    timer.advanceTime(request.timeoutMs!);
    const message = "timed out in queue before admission";
    daemonClient.simulateIncomingDataForTesting(
      Buffer.from(
        JSON.stringify({
          id: request.id,
          type: "mcp_response",
          success: false,
          error: message,
          code: "daemon_queue_timeout",
        }) + "\n",
      ),
    );
    const response = await result;
    expect(response.isError).toBe(true);
    const content = response.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text)).toEqual({
      success: false,
      error: message,
      code: "daemon_queue_timeout",
      retryable: true,
    });
    expect(socket.getWrittenMessages()).toHaveLength(1);
  } finally {
    await close();
  }
});

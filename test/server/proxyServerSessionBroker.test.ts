import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, spyOn } from "bun:test";
import type { SessionBrokerResult } from "../../src/devices/sessionBrokerResult";
import { SESSION_EXPERIMENTAL_CAPABILITY } from "../../src/devices/sessionConfig";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DAEMON_VERSION } from "../../src/daemon/wire/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  DaemonBoundSessionExpiredError,
  DaemonSessionStalledError,
} from "../../src/daemon/daemonMcpProxy";
import {
  livenessHandoverPayload,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { toolJson, toolText } from "../helpers/toolResponse";
import { warmedTests } from "../helpers/warmedTests";

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
const stalled: LivenessHandover = {
  code: "daemon_stalled",
  sessions: [
    { sessionUuid: "session-1", deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 10 },
  ],
  attempts: 3,
  lastAcknowledgedHeartbeatAt: 10,
  action: "restart_daemon_then_resume_by_session_uuid",
};

const servers: Array<{ client: Client; close(): Promise<void> }> = [];
const test = warmedTests(async () => {
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
  return { ...served, fake, proxy: harness.proxy };
}

describe("session broker MCP exposure", () => {
  test("a local daemon stall preserves its retryable handover on a ready broker connection", async () => {
    const { client, proxy } = await serve(ready);
    const error = new DaemonSessionStalledError("session-1", stalled);
    const call = spyOn(proxy, "callTool").mockRejectedValue(error);
    try {
      const result = await client.callTool({
        name: "observe",
        arguments: { sessionUuid: "session-1" },
      });
      expect(result.isError).toBe(true);
      expect(toolJson(result)).toMatchObject({
        error: { code: "daemon_stalled", retryable: true },
      });
      expect(toolText(result)).toBe(JSON.stringify(error.toPayload()));
    } finally {
      call.mockRestore();
    }
  });

  test.each(["proxy_stalled", "heartbeat-timeout", "session-not-found", "daemon_stalled"])(
    "a terminal %s error still ends the broker session",
    async (reason) => {
      const { client, proxy } = await serve(ready);
      const error =
        reason === "proxy_stalled"
          ? new DaemonSessionStalledError("session-1", {
              ...stalled,
              code: "proxy_stalled",
              action: "reacquire_lost_sessions",
            })
          : new DaemonBoundSessionExpiredError("session-1", reason);
      const call = spyOn(proxy, "callTool").mockRejectedValue(error);
      try {
        const result = await client.callTool({
          name: "observe",
          arguments: { sessionUuid: "session-1" },
        });
        expect(result.isError).toBe(true);
        expect(toolJson(result)).toEqual({
          success: false,
          error: {
            code: "broker_session_ended",
            message: `Broker session session-1 for request request-1 ended (${reason}). Device tools cannot acquire a generic replacement on this connection; the launcher must start a new broker request.`,
            requestId: "request-1",
            sessionUuid: "session-1",
            reason,
            retryable: false,
            nextAction: "relaunch_session_request",
          },
        });
      } finally {
        call.mockRestore();
      }
    },
  );

  test("a relayed daemon stall preserves its retryable handover", async () => {
    const payload = livenessHandoverPayload(stalled);
    const fake = new FakeDaemonClient({
      toolResult: { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] },
    });
    const { client } = await serve(ready, fake);
    const result = await client.callTool({
      name: "observe",
      arguments: { sessionUuid: "session-1" },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toBe(JSON.stringify(payload));
  });

  test.each([
    "readResource",
    "listAdvertisedResources",
    "listAdvertisedResourceTemplates",
    "listAdvertisedTools",
  ] as const)("a broker %s refusal preserves its retryable handover", async (method) => {
    const { client, proxy } = await serve(ready);
    const requests = {
      readResource: () => client.readResource({ uri: "automobile:hierarchy" }),
      listAdvertisedResources: () => client.listResources(),
      listAdvertisedResourceTemplates: () => client.listResourceTemplates(),
      listAdvertisedTools: () => client.listTools(),
    };
    const call = spyOn(proxy, method).mockRejectedValue(
      new DaemonSessionStalledError("session-1", stalled),
    );
    try {
      await expect(requests[method]()).rejects.toMatchObject({
        code: -32603,
        data: livenessHandoverPayload(stalled),
      });
    } finally {
      call.mockRestore();
    }
  });

  test("initialize exposes the flat result while pending serves no tools", async () => {
    const { client, fake } = await serve(pending);

    expect<unknown>(
      client.getServerCapabilities()?.experimental?.[SESSION_EXPERIMENTAL_CAPABILITY],
    ).toEqual(pending);
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

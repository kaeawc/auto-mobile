import { toolText } from "../helpers/toolResponse";
import { Client, ProtocolError } from "@modelcontextprotocol/client";
import { type LoggingLevel, InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonSessionStalledError } from "../../src/daemon/daemonMcpProxy";
import {
  livenessHandoverPayload,
  type LivenessHandover,
} from "../../src/daemon/proxyLivenessRecovery";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// #10053: the daemon_stalled handover reaches an MCP harness twice, as the structured error on its
// next tool call and, so an idle harness is told, as an MCP logging notification.

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

const SESSION = "11111111-2222-4333-8444-555555555555";
const stalled: LivenessHandover = {
  code: "daemon_stalled",
  sessions: [{ sessionUuid: SESSION, deviceId: "emulator-5554", lastAcknowledgedHeartbeatAt: 10 }],
  attempts: 3,
  lastAcknowledgedHeartbeatAt: 10,
  action: "restart_daemon_then_resume_by_session_uuid",
};

/** Exercise the registered handlers over an in-memory MCP link, without a daemon or host process. */
async function stalledHandlerAnswer(
  surface: "tool" | "resource",
  handover = stalled,
  sessionUuid = SESSION,
) {
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      timer: new FakeTimer(),
      clientFactory: () => new FakeDaemonClient(),
      daemonManager: new FakeDaemonManager(),
      daemonAvailabilityProbe: async () => true,
      autoStartDaemon: false,
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "stalled-answer-client", version: "0.0.1" });
  const refused = new DaemonSessionStalledError(sessionUuid, handover);
  const call = spyOn(proxy, surface === "tool" ? "callTool" : "readResource").mockRejectedValue(
    refused,
  );
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    if (surface === "tool") {
      const result = await client.callTool({ name: "tapOn" });
      expect(result.isError).toBe(true);
      const first: unknown = result.content[0];
      return toolText({ content: [first] });
    }
    const error: unknown = await client
      .readResource({ uri: "automobile:hierarchy" })
      .catch((caught: unknown) => caught);
    if (!(error instanceof ProtocolError)) {
      throw new Error("Expected resource refusal");
    }
    expect(error.code).toBe(-32603);
    return JSON.stringify(error.data);
  } finally {
    call.mockRestore();
    await client.close();
    await server.close();
    await proxy.close();
  }
}

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

/**
 * Advance the clock until `pending` settles: a call that names a handed-over session first asks
 * the daemon to resume it and waits up to one heartbeat timeout for the answer (#10989).
 */
async function settle<T>(timer: FakeTimer, pending: Promise<T>): Promise<T> {
  let done = false;
  const tracked = pending.finally(() => {
    done = true;
  });
  tracked.catch(() => {});
  for (let elapsed = 0; elapsed < 20_000 && !done; elapsed += 250) {
    await timer.advanceTimeAsync(250);
  }
  return tracked;
}

/** A proxy server behind an MCP client, with a daemon that stops answering heartbeats on demand. */
async function connectStallingHarness(loggingLevel?: LoggingLevel) {
  isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
  const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
  const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
  const timer = new FakeTimer();
  let hang = false;
  const fakeClient = new FakeDaemonClient({
    daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    toolResultFor: (name) =>
      name === "getAndroid"
        ? {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  runtime: { deviceId: "emulator-5554", session: { sessionUuid: "session-1" } },
                }),
              },
            ],
          }
        : undefined,
    onCallDaemonMethod: (method) =>
      method === "daemon/heartbeat" && hang ? new Promise<void>(() => {}) : undefined,
  });
  const daemonManager = new FakeDaemonManager();
  daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
  const { server, proxy } = createProxyMcpServer({
    proxyConfig: {
      timer,
      clientFactory: () => fakeClient,
      daemonManager,
      autoStartDaemon: false,
      heartbeatTimeoutMs: 10_000,
      heartbeatIntervalMs: 2_000,
    },
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "liveness-stall-client", version: "0.0.1" });
  const notifications: unknown[] = [];
  client.setNotificationHandler("notifications/message", (notification) => {
    notifications.push(notification.params);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  if (loggingLevel) {
    await client.setLoggingLevel(loggingLevel);
  }
  return {
    client,
    daemonManager,
    notifications,
    timer,
    stall: () => {
      hang = true;
    },
    async close() {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await client.close();
      await server.close();
      await proxy.close();
    },
  };
}

describe("proxy server liveness stall reporting", () => {
  beforeAll(async () => {
    // Pay the SDK's one-off connection/schema compilation outside per-test timing.
    // The throwaway harness is closed; every test creates its own client, proxy and fakes.
    const harness = await connectStallingHarness();
    try {
      await harness.client.callTool({ name: "getAndroid", arguments: {} });
    } finally {
      await harness.close();
      isAvailableSpy?.mockRestore();
      isAvailableSpy = null;
    }
  });

  test.each(["tool", "resource"] as const)(
    "generic and non-binding daemon stalls keep their %s refusal byte for byte",
    async (surface) => {
      const text = await stalledHandlerAnswer(surface);
      expect(JSON.parse(text)).toEqual(livenessHandoverPayload(stalled));
      expect(text).toBe(JSON.stringify(livenessHandoverPayload(stalled)));
    },
  );

  test("an unresponsive daemon is reported by notification and on the next tool call", async () => {
    const harness = await connectStallingHarness();
    const { client, notifications, timer, daemonManager } = harness;

    try {
      expect(client.getServerCapabilities()?.logging).toEqual({});
      await client.callTool({ name: "getAndroid", arguments: {} });

      harness.stall();
      // FakeTimer yields after each due event, including delivery of the final notification.
      await timer.advanceTimeAsync(19_000);

      // The idle harness was told without making a call.
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({
        level: "error",
        logger: "auto-mobile.liveness",
        data: {
          error: {
            code: "daemon_stalled",
            attempts: 3,
            maxAttempts: 3,
            sessions: [{ sessionUuid: "session-1", deviceId: "emulator-5554" }],
            recovery: { action: "restart_daemon_then_resume_by_session_uuid" },
          },
        },
      });

      // The next tool call for the session asks the daemon, which still does not answer, and
      // returns the same structured error.
      const result = await settle(
        timer,
        client.callTool({
          name: "observe",
          arguments: { sessionUuid: "session-1" },
        }),
      );
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text)).toEqual(
        (notifications[0] as { data: unknown }).data as Record<string, unknown>,
      );
      expect(JSON.parse(text).error.message).toContain("restart the daemon yourself");
      expect(daemonManager.startCallCount).toBe(0);
      expect(daemonManager.restartCallCount).toBe(0);
    } finally {
      await harness.close();
    }
  });

  test("a client that set a logging level above error is not sent the notification but still gets the error", async () => {
    const harness = await connectStallingHarness("critical");
    const { client, notifications, timer } = harness;

    try {
      await client.callTool({ name: "getAndroid", arguments: {} });

      harness.stall();
      await timer.advanceTimeAsync(19_000);

      expect(notifications).toEqual([]);
      const result = await settle(
        timer,
        client.callTool({
          name: "observe",
          arguments: { sessionUuid: "session-1" },
        }),
      );
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text).error.code).toBe("daemon_stalled");
    } finally {
      await harness.close();
    }
  });

  test("a client that set the error level still receives it", async () => {
    const harness = await connectStallingHarness("error");
    const { client, notifications, timer } = harness;

    try {
      await client.callTool({ name: "getAndroid", arguments: {} });

      harness.stall();
      await timer.advanceTimeAsync(19_000);

      expect(notifications).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});

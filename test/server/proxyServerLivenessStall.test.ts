import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

// #10053: the daemon_stalled handover reaches an MCP harness twice, as the structured error on its
// next tool call and, so an idle harness is told, as an MCP logging notification.

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

describe("proxy server liveness stall reporting", () => {
  test("an unresponsive daemon is reported by notification and on the next tool call", async () => {
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
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      notifications.push(notification.params);
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(client.getServerCapabilities()?.logging).toEqual({});
      await client.callTool({ name: "getAndroid", arguments: {} });

      hang = true;
      await timer.advanceTimeAsync(19_000);
      for (let turn = 0; turn < 5; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

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

      // The next tool call for the session returns the same structured error.
      const result = await client.callTool({
        name: "observe",
        arguments: { sessionUuid: "session-1" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0].text;
      expect(JSON.parse(text)).toEqual(
        (notifications[0] as { data: unknown }).data as Record<string, unknown>,
      );
      expect(JSON.parse(text).error.message).toContain("restart the daemon yourself");
      expect(daemonManager.restartCallCount).toBe(0);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
      await client.close();
      await server.close();
      await proxy.close();
    }
  });
});

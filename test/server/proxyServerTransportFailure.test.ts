import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DeviceControlTransportError,
  type DeviceControlTransportFailure,
} from "../../src/daemon/deviceControlTransportFailure";
import {
  daemonRestartDeferredResult,
  deviceControlTransportFailureResult,
  createProxyMcpServer,
  mcpOverloadError,
  mcpOverloadResult,
} from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { DaemonRestartDeferredError } from "../../src/daemon/daemonMcpProxy";
import { McpOverloadError } from "../../src/daemon/McpTimeoutError";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

describe("proxy server device-control transport errors", () => {
  test("returns safe machine-readable transport failure details", () => {
    const failure: DeviceControlTransportFailure = {
      code: "device_control_transport_failure",
      transport: "daemon_loopback_http",
      toolName: "launchApp",
      deviceId: "emulator-5554",
      deviceSessionUuid: "device-epoch-a",
      sessionUuid: "session-a",
      routingSessionUuid: "session-a",
      sessionValid: true,
      deviceSessionValid: true,
      phase: "response",
      retryable: false,
      reconnectAttempted: true,
      replayAttempted: false,
    };
    const unsafeFailure = {
      ...failure,
      endpoint: "https://secret.invalid?token=hidden",
    } as DeviceControlTransportFailure;
    const result = deviceControlTransportFailureResult(
      new DeviceControlTransportError(
        "Device-control transport closed while handling launchApp",
        unsafeFailure,
      ),
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              message: "Device-control transport closed while handling launchApp",
              ...failure,
            },
          }),
        },
      ],
      isError: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret.invalid");
  });

  test("returns a retryable structured result when active provisioning defers restart", () => {
    const result = daemonRestartDeferredResult(new DaemonRestartDeferredError("version mismatch"));

    expect(result.structuredContent).toMatchObject({
      error: {
        code: "daemon_restart_deferred",
        retryable: true,
        retryAfterMs: 1_000,
      },
    });
    expect(result.isError).toBe(true);
  });

  test("returns a retryable structured result when the daemon is overloaded", () => {
    const result = mcpOverloadResult(
      new McpOverloadError("overloaded", {
        code: "daemon_overloaded",
        retryable: true,
        retryAfterMs: 250,
        reason: "insufficient_forward_budget",
        queueWaitMs: 100,
        remainingTimeoutMs: 500,
      }),
    );

    expect(result.structuredContent).toMatchObject({
      error: {
        code: "daemon_overloaded",
        retryable: true,
        retryAfterMs: 250,
      },
    });
    expect(result.isError).toBe(true);
  });

  test("returns a structured McpError when a resource read hits daemon overload", () => {
    const error = mcpOverloadError(
      new McpOverloadError("overloaded", {
        code: "daemon_overloaded",
        retryable: true,
        retryAfterMs: 250,
        reason: "insufficient_forward_budget",
        queueWaitMs: 100,
        remainingTimeoutMs: 500,
      }),
    );

    expect(error).toBeInstanceOf(McpError);
    expect(error.data).toMatchObject({
      error: {
        code: "daemon_overloaded",
        retryable: true,
        retryAfterMs: 250,
      },
    });
    expect(JSON.parse(error.message.replace("MCP error -32603: ", ""))).toMatchObject({
      error: {
        code: "daemon_overloaded",
        retryable: true,
        retryAfterMs: 250,
      },
    });
  });

  test("preserves daemon overload details for all list handlers", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const fakeClient = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (
          method === "tools/list" ||
          method === "resources/list" ||
          method === "resources/templates/list" ||
          method === "resources/list-templates"
        ) {
          throw new McpOverloadError("overloaded", {
            code: "daemon_overloaded",
            retryable: true,
            retryAfterMs: 250,
            reason: "insufficient_forward_budget",
            queueWaitMs: 100,
            remainingTimeoutMs: 500,
          });
        }
      },
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => fakeClient,
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "transport-failure-test-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.callTool("observe", {});

      for (const request of [
        client.listTools(),
        client.listResources(),
        client.listResourceTemplates(),
      ]) {
        try {
          await request;
          throw new Error("expected list request to reject");
        } catch (error) {
          expect(error).toBeInstanceOf(McpError);
          expect((error as McpError).data).toMatchObject({
            error: {
              code: "daemon_overloaded",
              retryable: true,
              retryAfterMs: 250,
            },
          });
        }
      }
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });
});

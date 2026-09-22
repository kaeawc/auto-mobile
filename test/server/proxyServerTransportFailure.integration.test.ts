import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DaemonClient,
  DaemonShuttingDownError,
  DaemonUnavailableError,
} from "../../src/daemon/client";
import {
  DAEMON_SHUTTING_DOWN_ERROR_CODE,
  DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
  DAEMON_VERSION,
} from "../../src/daemon/constants";
import {
  DeviceControlTransportError,
  type DeviceControlTransportFailure,
} from "../../src/daemon/deviceControlTransportFailure";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { McpOverloadError, McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
  serverConfig.setToolResultsNoStructuredContentEnabled(false);
});

describe("proxy server device-control transport errors", () => {
  test("dispatches safe machine-readable transport failure details", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
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
    const fakeClient = new FakeDaemonClient({
      onCallTool: () => {
        throw new DeviceControlTransportError(
          "Device-control transport closed while handling launchApp",
          unsafeFailure,
        );
      },
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        initialSessionUuid: "session-a",
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

      const result = await client.callTool({
        name: "launchApp",
        arguments: { sessionUuid: "session-a", appId: "dev.example" },
      });

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
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });
});

describe("proxy server daemon-shutdown errors", () => {
  for (const {
    toolName,
    daemonHasOutputSchema,
    localSuppressStructuredContent,
    fetchLiveDefinitions,
    expectsStructuredContent,
    reason,
  } of [
    {
      toolName: "__proxy_shutdown_no_schema__",
      daemonHasOutputSchema: false,
      localSuppressStructuredContent: false,
      fetchLiveDefinitions: true,
      expectsStructuredContent: false,
      reason: "the daemon does not advertise an output schema",
    },
    {
      toolName: "__proxy_shutdown_schema__",
      daemonHasOutputSchema: true,
      localSuppressStructuredContent: true,
      fetchLiveDefinitions: true,
      expectsStructuredContent: true,
      reason: "the frontend flag disagrees with the daemon-advertised schema",
    },
    {
      toolName: "__proxy_shutdown_cold_schema__",
      daemonHasOutputSchema: true,
      localSuppressStructuredContent: false,
      fetchLiveDefinitions: false,
      expectsStructuredContent: false,
      reason: "the client has only the cold no-schema tool surface",
    },
  ]) {
    test(`uses daemon-advertised output schema when ${reason}`, async () => {
      isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      serverConfig.setToolResultsNoStructuredContentEnabled(localSuppressStructuredContent);
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          [
            "tools/list",
            {
              tools: [
                {
                  name: toolName,
                  inputSchema: { type: "object" },
                  ...(daemonHasOutputSchema ? { outputSchema: { type: "object" } } : {}),
                },
              ],
            },
          ],
        ]),
        onCallTool: () => {
          throw new DaemonShuttingDownError();
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
      const client = new Client({ name: "daemon-shutdown-test-client", version: "0.0.1" });

      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        if (fetchLiveDefinitions) {
          await proxy.listTools();
          const advertised = await client.listTools();
          const tool = advertised.tools.find((candidate) => candidate.name === toolName);
          expect(tool?.outputSchema !== undefined).toBe(daemonHasOutputSchema);
        }

        const result = await client.callTool({ name: toolName, arguments: {} });
        const expected = {
          error: {
            code: DAEMON_SHUTTING_DOWN_ERROR_CODE,
            message: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
            retryable: true,
          },
        };

        expect(result).toMatchObject({
          content: [{ type: "text", text: JSON.stringify(expected) }],
          isError: true,
        });
        expect("structuredContent" in result).toBe(expectsStructuredContent);
      } finally {
        await client.close();
        await server.close();
        await proxy.close();
      }
    });
  }
});

describe("proxy server daemon-overload errors", () => {
  for (const { localSuppressStructuredContent, reason } of [
    {
      localSuppressStructuredContent: false,
      reason: "the live tool contract has no output schema",
    },
    {
      localSuppressStructuredContent: true,
      reason: "the live daemon policy suppresses structured tool results",
    },
  ]) {
    test(`omits structuredContent when ${reason}`, async () => {
      isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      serverConfig.setToolResultsNoStructuredContentEnabled(localSuppressStructuredContent);
      const toolName = "__proxy_overload_no_schema__";
      const overload = new McpOverloadError("overloaded", {
        code: "daemon_overloaded",
        retryable: true,
        retryAfterMs: 250,
        reason: "insufficient_forward_budget",
        queueWaitMs: 100,
        remainingTimeoutMs: 500,
      });
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([
          ["tools/list", { tools: [{ name: toolName, inputSchema: { type: "object" } }] }],
        ]),
        onCallTool: () => {
          throw overload;
        },
      });
      const daemonManager = new FakeDaemonManager();
      daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
      const { server, proxy } = createProxyMcpServer({
        proxyConfig: { clientFactory: () => fakeClient, daemonManager, autoStartDaemon: false },
      });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "overload-no-schema-client", version: "0.0.1" });

      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        await proxy.listTools();
        await client.listTools();

        const result = await client.callTool({ name: toolName, arguments: {} });
        expect(result).toMatchObject({ isError: true });
        expect("structuredContent" in result).toBe(false);
      } finally {
        await client.close();
        await server.close();
        await proxy.close();
      }
    });
  }
});

describe("proxy server socket-close diagnostics", () => {
  test("surfaces only safe preserved timeout context for tool, resource, and list requests", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const disconnectError = (toolName: string) =>
      new DaemonUnavailableError("Socket connection closed", {
        cause: new McpTimeoutError({
          toolName,
          timeoutMs: 15_000,
          origin: "internal socket detail must not reach the client",
        }),
      });
    const fakeClient = new FakeDaemonClient({
      resourceResult: Promise.reject(disconnectError("resources/read")),
      onCallTool: (toolName) => {
        if (toolName !== "bootstrap") {
          throw disconnectError(toolName);
        }
      },
      onCallDaemonMethod: (method) => {
        throw disconnectError(method);
      },
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: { clientFactory: () => fakeClient, daemonManager, autoStartDaemon: false },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "socket-close-diagnostic-client", version: "0.0.1" });
    const timeoutDiagnostic = /request timed out after 15000ms while handling/;

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.callTool("bootstrap", {});

      const toolResult = await client.callTool({ name: "observe", arguments: {} });
      expect(toolResult.content).toMatchObject([
        { type: "text", text: expect.stringMatching(timeoutDiagnostic) },
      ]);
      expect(JSON.stringify(toolResult)).not.toContain("internal socket detail");

      await expect(client.readResource({ uri: "automobile:devices/booted" })).rejects.toThrow(
        timeoutDiagnostic,
      );
      for (const request of [() => client.listResources(), () => client.listResourceTemplates()]) {
        await expect(request()).rejects.toThrow(timeoutDiagnostic);
      }
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });
});

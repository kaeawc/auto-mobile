import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DaemonClient, DaemonShuttingDownError } from "../../src/daemon/client";
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

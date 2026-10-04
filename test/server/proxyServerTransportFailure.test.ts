import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
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
import { McpError, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ActionableError } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

describe("proxy server device-control transport errors", () => {
  beforeAll(async () => {
    const availabilitySpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        clientFactory: () => new FakeDaemonClient(),
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "transport-failure-warmup-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.callTool("observe", {});
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
      availabilitySpy.mockRestore();
    }
  });

  test.each([
    ["cancelled", new Error("client cancelled resource read"), true],
    ["AbortError", new DOMException("client cancelled resource read", "AbortError"), true],
    ["daemon failure", new Error("daemon read failed"), false],
  ] as const)("resources/read preserves %s error handling", async (_name, failure, aborted) => {
    // Invoke the registered handler directly: the SDK suppresses responses for
    // aborted requests, so a transport round trip cannot expose the thrown value.
    const registration = spyOn(Server.prototype, "setRequestHandler");
    const fakeClient = new FakeDaemonClient();
    const daemonManager = new FakeDaemonManager();
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        clientFactory: () => fakeClient,
        daemonManager,
        daemonAvailabilityProbe: async () => true,
        autoStartDaemon: false,
      },
    });
    const handler = registration.mock.calls.find(
      ([schema]) => schema === ReadResourceRequestSchema,
    )?.[1];
    registration.mockRestore();
    const daemonRead = spyOn(fakeClient, "readResource").mockRejectedValue(failure);
    // Isolate the server catch from the proxy's own pre-abort check while
    // retaining the existing fake daemon client's rejection seam.
    const proxyRead = spyOn(proxy, "readResource").mockImplementation((uri, options) =>
      fakeClient.readResource(uri, {}, options),
    );
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    const controller = new AbortController();
    if (aborted) {
      controller.abort(failure);
    }
    const uri = "automobile:devices/booted";
    try {
      expect(handler).toBeDefined();
      if (!handler) {
        throw new Error("resources/read handler was not registered");
      }
      const result = Promise.resolve(
        handler(
          { method: "resources/read", params: { uri } },
          {
            signal: controller.signal,
            requestId: 1,
            sendNotification: async () => {},
            sendRequest: async () => {
              throw new Error("unexpected server request");
            },
          },
        ),
      );
      const error: unknown = await result.catch((caught: unknown) => caught);
      expect(daemonRead).toHaveBeenCalledWith(uri, {}, { signal: controller.signal });
      if (aborted) {
        expect(errorLog).not.toHaveBeenCalled();
        expect(error).toBe(failure);
        expect(error).not.toBeInstanceOf(ActionableError);
      } else {
        expect(error).toBeInstanceOf(ActionableError);
        expect(error).toMatchObject({
          message: "Failed to read resource from daemon: daemon read failed",
          cause: failure,
        });
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(errorLog).toHaveBeenCalledWith(
          `[ProxyServer] Resource read failed: ${uri} - ${failure}`,
        );
      }
    } finally {
      errorLog.mockRestore();
      proxyRead.mockRestore();
      daemonRead.mockRestore();
      await server.close();
      await proxy.close();
    }
  });

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

  test.each([
    ["tools/list", (client: Client) => client.listTools()],
    ["resources/list", (client: Client) => client.listResources()],
    ["resources/templates/list", (client: Client) => client.listResourceTemplates()],
  ] as const)("preserves daemon overload details for %s", async (_handler, request) => {
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

      try {
        await request(client);
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
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });
});

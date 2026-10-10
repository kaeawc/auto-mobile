import { afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProxyMcpServer } from "../../src/server/proxyServer";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION } from "../../src/daemon/constants";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../../src/server/sessionReleaseBroadcast";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { appendHeartbeatExpiryMessage } from "../../src/server/deviceSessionResult";
import { SUSPECT_GRACE_MS } from "../../src/daemon/sessionLivenessWindows";
import { SessionManager, type SessionReleaseSnapshot } from "../../src/daemon/sessionManager";

import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

describe("appendHeartbeatExpiryMessage", () => {
  const release: SessionReleaseSnapshot = {
    sessionId: "session-123",
    deviceId: "emulator-5554",
    releaseReason: "heartbeat-timeout",
    releasedAtMs: 20_000,
    terminal: true,
    heartbeat: {
      lastHeartbeatMs: 9_000,
      hasReceivedHeartbeat: true,
      timeoutMs: 20_000,
      ageMs: 21_001,
    },
  };

  test.each([
    ["heartbeat-timeout", 20_000 + SUSPECT_GRACE_MS],
    ["missing-first-heartbeat", 20_000],
  ])("formats the release threshold and age for %s", (releaseReason, limitMs) => {
    expect(appendHeartbeatExpiryMessage("Ownership lost.", { ...release, releaseReason })).toBe(
      `Ownership lost. No heartbeat for 21001 ms (limit ${limitMs} ms; set AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS to change).`,
    );
  });

  test("preserves the message without a release snapshot", () => {
    expect(appendHeartbeatExpiryMessage("Ownership lost.")).toBe("Ownership lost.");
  });

  test.each(["device-killed", "rehydration-owner-timeout", "cli-idle-timeout"])(
    "preserves the message for %s despite heartbeat diagnostics",
    (releaseReason) => {
      expect(appendHeartbeatExpiryMessage("Ownership lost.", { ...release, releaseReason })).toBe(
        "Ownership lost.",
      );
    },
  );
});

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

describe("proxy server session ownership errors", () => {
  beforeAll(async () => {
    const availabilitySpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        initialSessionUuid: "warmup-session",
        clientFactory: () => new FakeDaemonClient(),
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ownership-warmup-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await proxy.callTool("observe", {});
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
      availabilitySpy.mockRestore();
    }
  });

  test("resources/read passes the MCP request signal to the proxy and daemon client", async () => {
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const fakeClient = new FakeDaemonClient();
    const read = fakeClient.readResource.bind(fakeClient);
    fakeClient.readResource = async (...args) => {
      const result = await read(...args);
      started.resolve();
      await gate.promise;
      return result;
    };
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        clientFactory: () => fakeClient,
        daemonManager,
        daemonAvailabilityProbe: async () => true,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "resource-cancel-client", version: "0.0.1" });
    const call = spyOn(proxy, "readResource");
    const controller = new AbortController();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = client
        .readResource({ uri: "automobile:devices/booted" }, { signal: controller.signal })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      await started.promise;
      const signal = call.mock.calls[0][1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(fakeClient.readResourceSignals[0]).toBe(signal);
      controller.abort(new Error("cancel MCP resource read"));
      expect(await result).toMatchObject({
        message: expect.stringContaining("cancel MCP resource read"),
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(signal?.aborted).toBe(true);
    } finally {
      controller.abort();
      gate.resolve();
      call.mockRestore();
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test.each(["heartbeat-timeout", "missing-first-heartbeat"])(
    "returns machine-readable %s ownership loss as an error CallToolResult",
    async (releaseReason) => {
      isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
      const fakeClient = new FakeDaemonClient({
        daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      });
      const daemonManager = new FakeDaemonManager();
      daemonManager.statusResult = {
        ...daemonManager.statusResult,
        version: DAEMON_VERSION,
      };
      const { server, proxy } = createProxyMcpServer({
        proxyConfig: {
          timer: new FakeTimer(),
          initialSessionUuid: "session-123",
          clientFactory: () => fakeClient,
          daemonManager,
          autoStartDaemon: false,
        },
      });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "ownership-test-client", version: "0.0.1" });

      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        await proxy.listTools();
        fakeClient.emitNotification(
          SESSION_RELEASED_NOTIFICATION_METHOD,
          "session-123",
          releaseReason,
          {
            sessionId: "session-123",
            deviceId: "emulator-5554",
            releaseReason,
            releasedAtMs: 20_000,
            terminal: true,
            heartbeat: {
              lastHeartbeatMs: 9_000,
              hasReceivedHeartbeat: releaseReason === "heartbeat-timeout",
              timeoutMs: 10_000,
              ageMs: 11_000,
            },
          },
        );

        const result = await client.callTool({
          name: "observe",
          arguments: { deviceId: "emulator-5554" },
        });

        expect(result).toEqual({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "session_ownership_lost",
                  message:
                    `Session ownership lost for session-123: ${releaseReason}. ` +
                    "Call getAndroid or getApple to acquire a new device session. " +
                    `No heartbeat for 11000 ms (limit ${releaseReason === "heartbeat-timeout" ? 10_000 + SUSPECT_GRACE_MS : 10_000} ms; set AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS to change).`,
                  sessionUuid: "session-123",
                  reason: releaseReason,
                  retryable: false,
                  nextAction: "acquire_new_session",
                  recovery: {
                    action: "acquire_replacement_session",
                    tools: ["getAndroid", "getApple"],
                  },
                  release: {
                    sessionId: "session-123",
                    deviceId: "emulator-5554",
                    releaseReason,
                    releasedAtMs: 20_000,
                    terminal: true,
                    heartbeat: {
                      lastHeartbeatMs: 9_000,
                      hasReceivedHeartbeat: releaseReason === "heartbeat-timeout",
                      timeoutMs: 10_000,
                      ageMs: 11_000,
                    },
                  },
                },
              }),
            },
          ],
          isError: true,
        });
        expect(fakeClient.callToolCalls).toEqual([]);
      } finally {
        await client.close();
        await server.close();
        await proxy.close();
      }
    },
  );

  test("explicit-release regression returns ownership loss from a real release snapshot", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const timer = new FakeTimer();
    const manager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = { ...daemonManager.statusResult, version: DAEMON_VERSION };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer,
        initialSessionUuid: "released-uuid",
        clientFactory: () => fakeClient,
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "explicit-release-client", version: "0.0.1" });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await manager.createSession("released-uuid", "handset", "android");
      await manager.releaseSession("released-uuid");
      const release = manager.getTerminalReleaseSnapshot("released-uuid");
      expect(release).toMatchObject({ releaseReason: "explicit-release", terminal: true });
      fakeClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "released-uuid",
        "explicit-release",
        release,
      );
      const result = await client.callTool({
        name: "observe",
        arguments: { sessionUuid: "released-uuid" },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "session_ownership_lost",
              message:
                "Session ownership lost for released-uuid: explicit-release. " +
                "Call getAndroid or getApple to acquire a new device session.",
              sessionUuid: "released-uuid",
              reason: "explicit-release",
              retryable: false,
              nextAction: "acquire_new_session",
              recovery: {
                action: "acquire_replacement_session",
                tools: ["getAndroid", "getApple"],
              },
              release,
            },
          }),
        },
      ]);
      expect(fakeClient.callToolCalls).toEqual([]);
    } finally {
      manager.stopCleanupTimer();
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test("preserves machine-readable ownership loss across discovery errors", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
    });
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        initialSessionUuid: "session-123",
        clientFactory: () => fakeClient,
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ownership-test-client", version: "0.0.1" });
    const ownershipLoss = /session_ownership_lost.*session-123.*heartbeat-timeout/;

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      fakeClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "session-123",
        "heartbeat-timeout",
      );

      await Promise.all([
        expect(client.listTools()).rejects.toThrow(ownershipLoss),
        expect(client.listResources()).rejects.toThrow(ownershipLoss),
        expect(client.listResourceTemplates()).rejects.toThrow(ownershipLoss),
        expect(client.readResource({ uri: "automobile:devices/booted" })).rejects.toThrow(
          ownershipLoss,
        ),
      ]);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test("returns iOS device-killed loss and requires an in-band replacement session (#6724)", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const originalClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      toolResultFor: (toolName) =>
        toolName === "getApple"
          ? {
              content: [{ type: "text", text: JSON.stringify({ sessionId: "shutdown-session" }) }],
            }
          : undefined,
    });
    const replacementClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      toolResultFor: (toolName) =>
        toolName === "getApple"
          ? {
              content: [
                { type: "text", text: JSON.stringify({ sessionId: "replacement-session" }) },
              ],
            }
          : undefined,
    });
    let clientFactoryCalls = 0;
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        clientFactory: () => {
          clientFactoryCalls += 1;
          return clientFactoryCalls === 1 ? originalClient : replacementClient;
        },
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "shutdown-recovery-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await client.callTool({ name: "getApple", arguments: {} });
      originalClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "shutdown-session",
        "device-killed",
      );

      const loss = await client.callTool({
        name: "observe",
        arguments: { deviceId: "ios-simulator-1" },
      });
      expect(loss).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: {
                code: "no_active_device_session",
                message:
                  "This MCP connection has no active device session " +
                  "(the previous session was released: device-killed). " +
                  "Call getAndroid or getApple to acquire a new device session.",
                reason: "device-killed",
                retryable: false,
                nextAction: "acquire_new_session",
                recovery: {
                  action: "acquire_replacement_session",
                  tools: ["getAndroid", "getApple"],
                },
              },
            }),
          },
        ],
      });

      originalClient.emitConnectionClosed();
      await client.callTool({ name: "getApple", arguments: {} });
      await client.callTool({
        name: "observe",
        arguments: {},
      });

      expect(originalClient.callToolCalls).toEqual([{ toolName: "getApple", params: {} }]);
      expect(replacementClient.callToolCalls).toEqual([
        { toolName: "getApple", params: {} },
        {
          toolName: "observe",
          params: { sessionUuid: "replacement-session" },
        },
      ]);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test("keeps discovery working, unbound, after a result-minted session is released (#9997)", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map<string, unknown>([
        ["tools/list", { tools: [{ name: "getApple", inputSchema: { type: "object" } }] }],
        ["resources/list", { resources: [{ uri: "automobile:devices/booted", name: "booted" }] }],
        ["resources/list-templates", { resourceTemplates: [] }],
      ]),
      toolResultFor: (toolName) =>
        toolName === "getApple"
          ? { content: [{ type: "text", text: JSON.stringify({ sessionId: "minted-session" }) }] }
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
    const listChanged: string[] = [];
    proxy.onListChanged((kind) => listChanged.push(kind));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "result-mint-discovery-client", version: "0.0.1" });
    const listCalls = () =>
      fakeClient.callDaemonMethodCalls.filter((call) => call.method.includes("list"));

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await client.callTool({ name: "getApple", arguments: {} });
      listChanged.length = 0;
      fakeClient.callDaemonMethodCalls.length = 0;

      fakeClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "minted-session",
        "device-killed",
      );
      // The connection is unbound now, so the client is prompted to re-list.
      expect(listChanged).toEqual(["tools"]);

      const tools = await client.listTools();
      const resources = await client.listResources();
      const templates = await client.listResourceTemplates();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["getApple"]);
      expect(resources.resources.map((resource) => resource.uri)).toEqual([
        "automobile:devices/booted",
      ]);
      expect(templates.resourceTemplates).toEqual([]);
      // Forwarded without a session, so the daemon serves the unbound surface.
      expect(listCalls()).toEqual([
        { method: "tools/list", params: {} },
        { method: "resources/list", params: {} },
        { method: "resources/list-templates", params: {} },
      ]);

      // Recovery stays in-band: re-acquiring binds again and discovery is scoped.
      await client.callTool({ name: "getApple", arguments: {} });
      fakeClient.callDaemonMethodCalls.length = 0;
      await client.listTools();
      await client.listResources();
      expect(listCalls()).toEqual([
        { method: "tools/list", params: { sessionUuid: "minted-session" } },
        { method: "resources/list", params: { sessionUuid: "minted-session" } },
      ]);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });

  test("reconnects and reclaims the same iOS session across a daemon-shutdown handoff (#6724)", async () => {
    isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
    const originalClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      toolResultFor: (toolName) =>
        toolName === "getApple"
          ? {
              content: [{ type: "text", text: JSON.stringify({ sessionId: "shutdown-session" }) }],
            }
          : undefined,
    });
    const replacementClient = new FakeDaemonClient({
      daemonMethodResults: new Map([["tools/list", { tools: [] }]]),
      toolResult: { content: [{ type: "text", text: "reclaimed" }] },
    });
    let clientFactoryCalls = 0;
    const daemonManager = new FakeDaemonManager();
    daemonManager.statusResult = {
      ...daemonManager.statusResult,
      version: DAEMON_VERSION,
    };
    const { server, proxy } = createProxyMcpServer({
      proxyConfig: {
        timer: new FakeTimer(),
        clientFactory: () => {
          clientFactoryCalls += 1;
          return clientFactoryCalls === 1 ? originalClient : replacementClient;
        },
        daemonManager,
        autoStartDaemon: false,
      },
    });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "shutdown-recovery-client", version: "0.0.1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await proxy.listTools();
      await client.callTool({ name: "getApple", arguments: {} });
      originalClient.emitNotification(
        SESSION_RELEASED_NOTIFICATION_METHOD,
        "shutdown-session",
        "daemon-shutdown",
      );
      originalClient.emitConnectionClosed();

      const result = await client.callTool({
        name: "observe",
        arguments: {},
      });

      expect(result).toEqual({
        content: [{ type: "text", text: "reclaimed" }],
      });
      expect(originalClient.callToolCalls).toEqual([{ toolName: "getApple", params: {} }]);
      expect(replacementClient.callToolCalls).toEqual([
        {
          toolName: "observe",
          params: { sessionUuid: "shutdown-session" },
        },
      ]);
    } finally {
      await client.close();
      await server.close();
      await proxy.close();
    }
  });
});

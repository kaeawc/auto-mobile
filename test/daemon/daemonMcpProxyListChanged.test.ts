import { afterEach, describe, expect, test, spyOn } from "bun:test";
import { DaemonMcpProxy } from "../../src/daemon/daemonMcpProxy";
import { DaemonClient } from "../../src/daemon/client";
import { DAEMON_VERSION, DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD } from "../../src/daemon/constants";
import { FakeDaemonManager } from "../fakes/FakeDaemonManager";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";

// Issue #3223: the proxy must honor daemon-pushed list-changed notifications —
// invalidate the matching cache and re-emit to its own listeners — so proxy-mode
// clients observe flag-driven tool/resource changes without a daemon restart.

const TOOLS_V1 = { tools: [{ name: "toolA", inputSchema: {} }] };
const RESOURCES_V1 = { resources: [{ uri: "automobile:one", name: "one" }] };
const TEMPLATES_V1 = { resourceTemplates: [{ uriTemplate: "automobile:{x}", name: "x" }] };

function runningManager(): FakeDaemonManager {
  const manager = new FakeDaemonManager();
  manager.statusResult = {
    running: true,
    pid: 1234,
    port: 3000,
    socketPath: "/tmp/test.sock",
    version: DAEMON_VERSION,
  };
  return manager;
}

function createProxy(fakeClient: FakeDaemonClient): DaemonMcpProxy {
  return new DaemonMcpProxy({
    clientFactory: () => fakeClient,
    daemonManager: runningManager(),
    autoStartDaemon: false,
  });
}

function createFakeClient(): FakeDaemonClient {
  return new FakeDaemonClient({
    daemonMethodResults: new Map<string, any>([
      ["tools/list", TOOLS_V1],
      ["resources/list", RESOURCES_V1],
      ["resources/list-templates", TEMPLATES_V1],
    ]),
  });
}

let isAvailableSpy: ReturnType<typeof spyOn> | null = null;

function mockDaemonAvailable(): void {
  isAvailableSpy = spyOn(DaemonClient, "isAvailable").mockResolvedValue(true);
}

afterEach(() => {
  isAvailableSpy?.mockRestore();
  isAvailableSpy = null;
});

describe("DaemonMcpProxy list-changed forwarding", () => {
  test("subscribes to daemon notifications on connect", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);

    await proxy.listTools();

    expect(fakeClient.subscribeToNotificationsCalls).toBe(1);
  });

  test("subscription failure is best-effort: connect still succeeds", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    fakeClient.shouldFailSubscribe = true;
    const proxy = createProxy(fakeClient);

    const tools = await proxy.listTools();

    expect(tools).toEqual(TOOLS_V1.tools as any);
    expect(proxy.isConnected()).toBe(true);
  });

  test("tools/list_changed invalidates the tool cache and re-fetches", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);

    await proxy.listTools();
    // Second call is served from cache: no extra tools/list round-trip.
    await proxy.listTools();
    const listCallsBefore = fakeClient.callDaemonMethodCalls.filter(
      (call) => call.method === "tools/list",
    ).length;
    expect(listCallsBefore).toBe(1);

    fakeClient.emitNotification("notifications/tools/list_changed");
    await proxy.listTools();

    const listCallsAfter = fakeClient.callDaemonMethodCalls.filter(
      (call) => call.method === "tools/list",
    ).length;
    expect(listCallsAfter).toBe(2);
  });

  test("tools/list_changed leaves resource caches intact", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);

    await proxy.listResources();
    fakeClient.emitNotification("notifications/tools/list_changed");
    await proxy.listResources();

    const resourceListCalls = fakeClient.callDaemonMethodCalls.filter(
      (call) => call.method === "resources/list",
    ).length;
    expect(resourceListCalls).toBe(1);
  });

  test("resources/list_changed invalidates resources AND templates caches", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);

    await proxy.listResources();
    await proxy.listResourceTemplates();
    fakeClient.emitNotification("notifications/resources/list_changed");
    await proxy.listResources();
    await proxy.listResourceTemplates();

    const resourceListCalls = fakeClient.callDaemonMethodCalls.filter(
      (call) => call.method === "resources/list",
    ).length;
    const templateListCalls = fakeClient.callDaemonMethodCalls.filter(
      (call) => call.method === "resources/list-templates",
    ).length;
    expect(resourceListCalls).toBe(2);
    expect(templateListCalls).toBe(2);
  });

  test("re-emits list-changed to registered listeners with the right kind", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);
    const kinds: string[] = [];
    proxy.onListChanged((kind) => {
      kinds.push(kind);
    });

    await proxy.listTools();
    fakeClient.emitNotification("notifications/tools/list_changed");
    fakeClient.emitNotification("notifications/resources/list_changed");

    expect(kinds).toEqual(["tools", "resources"]);
  });

  test("a throwing listener does not break cache invalidation or siblings", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);
    const kinds: string[] = [];
    proxy.onListChanged(() => {
      throw new Error("listener boom");
    });
    proxy.onListChanged((kind) => {
      kinds.push(kind);
    });

    await proxy.listTools();
    expect(() => fakeClient.emitNotification("notifications/tools/list_changed")).not.toThrow();
    await proxy.listTools();

    expect(kinds).toEqual(["tools"]);
    const listCalls = fakeClient.callDaemonMethodCalls.filter(
      (call) => call.method === "tools/list",
    ).length;
    expect(listCalls).toBe(2);
  });

  test("unknown pushed notification methods are ignored", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);
    const kinds: string[] = [];
    proxy.onListChanged((kind) => {
      kinds.push(kind);
    });

    await proxy.listTools();
    fakeClient.emitNotification("notifications/some/future_thing");
    await proxy.listTools();

    expect(kinds).toEqual([]);
    const listCalls = fakeClient.callDaemonMethodCalls.filter(
      (call) => call.method === "tools/list",
    ).length;
    expect(listCalls).toBe(1);
  });

  test("failed device acquisition preserves the advertised tool set", async () => {
    mockDaemonAvailable();
    const fakeClient = new FakeDaemonClient({
      daemonMethodResults: new Map<string, any>([["tools/list", TOOLS_V1]]),
      onCallTool: (toolName) => {
        if (toolName === "getAndroid") {
          throw new Error(
            "Freshly started device 'emulator-5554' was assigned before its owner could reserve it.",
          );
        }
      },
    });
    const proxy = createProxy(fakeClient);
    const kinds: string[] = [];
    proxy.onListChanged((kind) => {
      kinds.push(kind);
    });

    const before = await proxy.listTools();
    await expect(proxy.callTool("getAndroid", { deviceId: "emulator-5554" })).rejects.toThrow(
      "Freshly started device",
    );
    const after = await proxy.listTools();

    expect(after).toEqual(before);
    expect(after.map((tool) => tool.name)).toContain("toolA");
    expect(kinds).toEqual([]);
    expect(
      fakeClient.callDaemonMethodCalls.filter((call) => call.method === "tools/list"),
    ).toHaveLength(1);
  });

  test("unsubscribed onListChanged listener stops receiving events", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);
    const kinds: string[] = [];
    const unsubscribe = proxy.onListChanged((kind) => {
      kinds.push(kind);
    });

    await proxy.listTools();
    unsubscribe();
    fakeClient.emitNotification("notifications/tools/list_changed");

    expect(kinds).toEqual([]);
  });

  test("reconnect with a reused client does not stack duplicate handlers", async () => {
    mockDaemonAvailable();
    const fakeClient = createFakeClient();
    const proxy = createProxy(fakeClient);
    const kinds: string[] = [];
    proxy.onListChanged((kind) => {
      kinds.push(kind);
    });

    await proxy.listTools();
    // Simulate the stale-session recovery path: reset then reconnect. The
    // factory returns the SAME fake client, so a leaked handler would double
    // every subsequent notification.
    await (proxy as unknown as { resetConnection(): Promise<void> }).resetConnection();
    await proxy.listTools();

    fakeClient.emitNotification("notifications/tools/list_changed");

    expect(kinds).toEqual(["tools"]);
    expect(fakeClient.subscribeToNotificationsCalls).toBe(2);
  });

  // #6886 review: acquisition changes the SESSION SCOPE discovery is fetched
  // under, but the proxy only publishes the result-minted binding after the
  // daemon's `tools/list_changed` has already been relayed. An eager client
  // that re-lists on that notification therefore caches a list scoped to the
  // OLD binding, and nothing invalidates it afterwards — a tool enabled by
  // `enableTools` stays absent from discovery indefinitely while being
  // callable. Binding must itself invalidate and re-notify.
  describe("result-minted session binding", () => {
    const mintingClient = () =>
      new FakeDaemonClient({
        daemonMethodResults: new Map<string, any>([["tools/list", TOOLS_V1]]),
        toolResultFor: () => ({
          content: [{ type: "text", text: JSON.stringify({ sessionId: "session-1" }) }],
        }),
      });

    test("invalidates the tool cache so the next list is fetched under the new session", async () => {
      mockDaemonAvailable();
      const fakeClient = mintingClient();
      const proxy = createProxy(fakeClient);

      await proxy.listTools();
      await proxy.callTool("getAndroid", {});
      await proxy.listTools();

      const listCalls = fakeClient.callDaemonMethodCalls.filter(
        (call) => call.method === "tools/list",
      );
      expect(listCalls.length).toBe(2);
      expect(listCalls[1]!.params.sessionUuid).toBe("session-1");
    });

    test("re-emits tools/list_changed after the binding is published", async () => {
      mockDaemonAvailable();
      const fakeClient = mintingClient();
      const proxy = createProxy(fakeClient);
      const kinds: string[] = [];

      await proxy.listTools();
      proxy.onListChanged((kind) => {
        kinds.push(kind);
      });
      await proxy.callTool("getAndroid", {});

      expect(kinds).toEqual(["tools"]);
    });

    test("does not re-notify when the acquisition re-binds the SAME session", async () => {
      mockDaemonAvailable();
      const fakeClient = mintingClient();
      const proxy = createProxy(fakeClient);

      await proxy.callTool("getAndroid", {});
      const kinds: string[] = [];
      proxy.onListChanged((kind) => {
        kinds.push(kind);
      });
      await proxy.callTool("getAndroid", {});

      expect(kinds).toEqual([]);
    });
  });

  test("clients without notification support skip subscription entirely", async () => {
    mockDaemonAvailable();
    // Legacy-shaped client: only the five required DaemonClientLike members.
    const calls: string[] = [];
    const legacyClient = {
      connect: async () => {},
      close: async () => {},
      callTool: async () => ({}),
      readResource: async () => ({}),
      callDaemonMethod: async (method: string) => {
        calls.push(method);
        return { tools: [] };
      },
    };
    const proxy = new DaemonMcpProxy({
      clientFactory: () => legacyClient,
      daemonManager: runningManager(),
      autoStartDaemon: false,
    });

    await proxy.listTools();

    expect(calls).toEqual(["tools/list"]);
    expect(calls).not.toContain(DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD);
  });
});

describe("DaemonMcpProxy resource subscriptions", () => {
  test("replays only surviving subscriptions after daemon reconnect and clears them on close", async () => {
    mockDaemonAvailable();
    const first = createFakeClient();
    const second = createFakeClient();
    let next = first;
    const proxy = new DaemonMcpProxy({
      clientFactory: () => next,
      daemonManager: runningManager(),
      autoStartDaemon: false,
    });
    const received: string[] = [];
    const stop = proxy.onResourceUpdated((uri) => {
      received.push(uri);
    });
    try {
      await proxy.subscribeResource("automobile:one");
      await proxy.subscribeResource("automobile:two");
      await proxy.ensureConnected();
      first.emitConnectionClosed();
      await proxy.unsubscribeResource("automobile:two");
      next = second;
      await proxy.ensureConnected();
      expect(second.callDaemonMethodCalls).toEqual([
        { method: "resources/subscribe", params: { uri: "automobile:one" } },
      ]);
      second.emitNotification(
        "notifications/resources/updated",
        undefined,
        undefined,
        undefined,
        "automobile:two",
      );
      second.emitNotification("notifications/resources/updated");
      second.emitNotification(
        "notifications/resources/updated",
        undefined,
        undefined,
        undefined,
        "automobile:one",
      );
      expect(received).toEqual(["automobile:one"]);
      stop();
      second.emitNotification(
        "notifications/resources/updated",
        undefined,
        undefined,
        undefined,
        "automobile:one",
      );
      expect(received).toEqual(["automobile:one"]);
      await proxy.close();
      expect(
        (proxy as unknown as { resourceSubscriptions: Set<string> }).resourceSubscriptions.size,
      ).toBe(0);
    } finally {
      stop();
      await proxy.close();
    }
  });

  test("throwing update listener does not block siblings", async () => {
    mockDaemonAvailable();
    const client = createFakeClient();
    const proxy = createProxy(client);
    const received: string[] = [];
    proxy.onResourceUpdated(() => {
      throw new Error("closed transport");
    });
    proxy.onResourceUpdated((uri) => {
      received.push(uri);
    });
    try {
      await proxy.ensureConnected();
      await proxy.subscribeResource("automobile:one");
      client.emitNotification(
        "notifications/resources/updated",
        undefined,
        undefined,
        undefined,
        "automobile:one",
      );
      expect(received).toEqual(["automobile:one"]);
    } finally {
      await proxy.close();
    }
  });
});

describe("DaemonMcpProxy resource subscription synchronization", () => {
  test("unsubscribe during reconnect replay is sent after the in-flight subscribe", async () => {
    mockDaemonAvailable();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client = new FakeDaemonClient({
      onCallDaemonMethod: async (method) => {
        if (method === "resources/subscribe") {
          started.resolve();
          await release.promise;
        }
      },
    });
    const proxy = createProxy(client);
    try {
      await proxy.subscribeResource("automobile:one");
      const connecting = proxy.ensureConnected();
      await started.promise;
      const unsubscribing = proxy.unsubscribeResource("automobile:one");
      release.resolve();
      await connecting;
      await unsubscribing;
      expect(client.callDaemonMethodCalls).toEqual([
        { method: "resources/subscribe", params: { uri: "automobile:one" } },
        { method: "resources/unsubscribe", params: { uri: "automobile:one" } },
      ]);
    } finally {
      release.resolve();
      await proxy.close();
    }
  });

  test("a rejected replay fails connection establishment and permits a later replay", async () => {
    mockDaemonAvailable();
    let rejectSubscription = true;
    const client = new FakeDaemonClient({
      onCallDaemonMethod: (method) => {
        if (rejectSubscription && method === "resources/subscribe") {
          throw new Error("subscription rejected");
        }
      },
    });
    const proxy = createProxy(client);
    try {
      await proxy.subscribeResource("automobile:one");
      await expect(proxy.ensureConnected()).rejects.toThrow("subscription rejected");
      expect(proxy.isConnected()).toBe(false);
      rejectSubscription = false;
      await proxy.ensureConnected();
      expect(proxy.isConnected()).toBe(true);
      expect(client.callDaemonMethodCalls).toEqual([
        { method: "resources/subscribe", params: { uri: "automobile:one" } },
        { method: "resources/subscribe", params: { uri: "automobile:one" } },
      ]);
    } finally {
      await proxy.close();
    }
  });
});

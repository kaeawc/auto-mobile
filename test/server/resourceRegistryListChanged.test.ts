import { beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ListChangedBroadcaster } from "../../src/server/listChangedBroadcast";

// Minimal MCP-server stand-in for ResourceRegistry: registerWithServer installs
// request handlers on `server.server` and tracks the wrapper for notification
// fan-out; notifyResourceListChanged sends via `server.server.notification`.
class FakeUnderlyingServer {
  notifications: Array<{ method: string; params?: unknown }> = [];
  handlersBySchema = new Map<unknown, (request: unknown) => Promise<unknown>>();
  shouldThrow = false;
  onclose?: () => void;
  setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<unknown>): void {
    this.handlersBySchema.set(schema, handler);
  }
  async notification(payload: { method: string; params?: unknown }): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("Not connected");
    }
    this.notifications.push(payload);
  }
}

class FakeMcpServer {
  server = new FakeUnderlyingServer();
}

function methodsSent(server: FakeMcpServer): string[] {
  return server.server.notifications.map(n => n.method);
}

describe("ResourceRegistry list-changed fan-out (issue #3223)", () => {
  beforeEach(() => {
    // The registry singleton is shared across suites; drop servers registered
    // by other tests so counts here are hermetic.
    ResourceRegistry.clearServersForTesting();
  });

  test("notifyResourceListChanged reaches every registered server", async () => {
    const first = new FakeMcpServer();
    const second = new FakeMcpServer();
    ResourceRegistry.registerWithServer(first as unknown as McpServer);
    ResourceRegistry.registerWithServer(second as unknown as McpServer);

    await ResourceRegistry.notifyResourceListChanged();

    expect(methodsSent(first)).toEqual(["notifications/resources/list_changed"]);
    expect(methodsSent(second)).toEqual(["notifications/resources/list_changed"]);
  });

  test("one failing server does not block sibling sessions and never throws", async () => {
    const failing = new FakeMcpServer();
    failing.server.shouldThrow = true;
    const healthy = new FakeMcpServer();
    ResourceRegistry.registerWithServer(failing as unknown as McpServer);
    ResourceRegistry.registerWithServer(healthy as unknown as McpServer);

    await ResourceRegistry.notifyResourceListChanged();

    expect(methodsSent(healthy)).toEqual(["notifications/resources/list_changed"]);
  });

  test("prunes a server when its underlying transport closes", async () => {
    const closing = new FakeMcpServer();
    const surviving = new FakeMcpServer();
    ResourceRegistry.registerWithServer(closing as unknown as McpServer);
    ResourceRegistry.registerWithServer(surviving as unknown as McpServer);

    closing.server.onclose?.();
    await ResourceRegistry.notifyResourceListChanged();

    expect(methodsSent(closing)).toEqual([]);
    expect(methodsSent(surviving)).toEqual(["notifications/resources/list_changed"]);
  });

  test("emits on the ListChangedBroadcaster even with zero servers", async () => {
    const kinds: string[] = [];
    const unsubscribe = ListChangedBroadcaster.subscribe(kind => {
      kinds.push(kind);
    });
    try {
      await ResourceRegistry.notifyResourceListChanged();
      expect(kinds).toEqual(["resources"]);
    } finally {
      unsubscribe();
    }
  });

  test("notifyResourceUpdated reaches every registered server for a subscribed URI", async () => {
    const first = new FakeMcpServer();
    const second = new FakeMcpServer();
    ResourceRegistry.registerWithServer(first as unknown as McpServer);
    ResourceRegistry.registerWithServer(second as unknown as McpServer);
    ResourceRegistry.register(
      "automobile:test/updated-resource",
      "test",
      "test resource",
      "text/plain",
      async () => ({ uri: "automobile:test/updated-resource", text: "x" })
    );
    // Subscribe the same way a client would: through the registered handler.
    const subscribeHandler = first.server.handlersBySchema.get(SubscribeRequestSchema);
    expect(subscribeHandler).toBeDefined();
    await subscribeHandler!({ params: { uri: "automobile:test/updated-resource" } });

    try {
      await ResourceRegistry.notifyResourceUpdated("automobile:test/updated-resource");

      expect(methodsSent(first)).toEqual(["notifications/resources/updated"]);
      expect(methodsSent(second)).toEqual(["notifications/resources/updated"]);
    } finally {
      ResourceRegistry.unregister("automobile:test/updated-resource");
      const unsubscribeHandler = first.server.handlersBySchema.get(UnsubscribeRequestSchema);
      await unsubscribeHandler?.({ params: { uri: "automobile:test/updated-resource" } });
    }
  });
});

describe("ResourceRegistry URI-template matching", () => {
  beforeEach(() => {
    ResourceRegistry.clearResources();
  });

  test("captures a raw query-string template with multiple query parameters", () => {
    ResourceRegistry.registerTemplate(
      "automobile:test?{params}",
      "Test",
      "Test raw query template",
      "application/json",
      async () => ({ uri: "automobile:test", text: "{}" })
    );

    expect(ResourceRegistry.matchTemplate("automobile:test?first=one&second=two")).toMatchObject({
      params: { params: "first=one&second=two" }
    });
  });
});

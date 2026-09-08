import { beforeEach, describe, expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getRequestedResourceUri, ResourceRegistry } from "../../src/server/resourceRegistry";
import { ListChangedBroadcaster } from "../../src/server/listChangedBroadcast";

// Minimal MCP-server stand-in for ResourceRegistry: registerWithServer installs
// request handlers on `server.server` and tracks the wrapper for notification
// fan-out; notifyResourceListChanged sends via `server.server.notification`.
class FakeUnderlyingServer {
  notifications: Array<{ method: string; params?: unknown }> = [];
  handlersBySchema = new Map<unknown, (request: unknown, extra?: unknown) => Promise<unknown>>();
  shouldThrow = false;
  onclose?: () => void;
  setRequestHandler(
    schema: unknown,
    handler: (request: unknown, extra?: unknown) => Promise<unknown>,
  ): void {
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
  return server.server.notifications.map((n) => n.method);
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
    const unsubscribe = ListChangedBroadcaster.subscribe((kind) => {
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
      async () => ({ uri: "automobile:test/updated-resource", text: "x" }),
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

describe("ResourceRegistry per-page subscription identities (issue #6198)", () => {
  const PAGINATED_TEMPLATE = "automobile:pages/{id}/data{?appId,limit,offset}";
  const CANONICAL_URI = "automobile:pages/one/data?appId=x";
  const PAGE_A = "automobile:pages/one/data?appId=x&limit=10&offset=0";
  const PAGE_B = "automobile:pages/one/data?appId=x&limit=10&offset=10";

  function urisNotified(server: FakeMcpServer): string[] {
    return server.server.notifications
      .filter((n) => n.method === "notifications/resources/updated")
      .map((n) => (n.params as { uri: string }).uri);
  }

  async function subscribe(server: FakeMcpServer, uri: string): Promise<void> {
    const handler = server.server.handlersBySchema.get(SubscribeRequestSchema);
    await handler!({ params: { uri } });
  }

  beforeEach(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
    ResourceRegistry.registerTemplate(
      PAGINATED_TEMPLATE,
      "Paginated",
      "Paginated test resource",
      "application/json",
      async (params) => ({ uri: getRequestedResourceUri(params) ?? "", text: "{}" }),
      ["limit", "offset"],
    );
  });

  test("distinct per-page URIs are tracked as distinct subscription identities", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    await subscribe(server, PAGE_A);
    await subscribe(server, PAGE_B);

    const subscriptions = ResourceRegistry.getSubscriptions();
    expect(subscriptions.has(PAGE_A)).toBe(true);
    expect(subscriptions.has(PAGE_B)).toBe(true);
    expect(subscriptions.size).toBe(2);
  });

  test("a canonical-URI update fans out to every per-page subscriber, each with its own page URI", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    await subscribe(server, PAGE_A);
    await subscribe(server, PAGE_B);

    await ResourceRegistry.notifyResourceUpdated(CANONICAL_URI);

    expect(urisNotified(server).sort()).toEqual([PAGE_A, PAGE_B]);
  });

  test("the whole-table subscriber and per-page subscribers are all notified", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    await subscribe(server, CANONICAL_URI);
    await subscribe(server, PAGE_A);

    await ResourceRegistry.notifyResourceUpdated(CANONICAL_URI);

    expect(urisNotified(server).sort()).toEqual([CANONICAL_URI, PAGE_A].sort());
  });

  test("pagination-only difference is order-independent between subscription and canonical URI", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    // offset before limit, still the same page-independent identity as CANONICAL_URI.
    const reordered = "automobile:pages/one/data?offset=10&appId=x&limit=10";
    await subscribe(server, reordered);

    await ResourceRegistry.notifyResourceUpdated(CANONICAL_URI);

    expect(urisNotified(server)).toEqual([reordered]);
  });

  test("does not fan out to a page of a different identity (differing non-pagination query)", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    const otherApp = "automobile:pages/one/data?appId=y&limit=10&offset=0";
    await subscribe(server, PAGE_A);
    await subscribe(server, otherApp);

    await ResourceRegistry.notifyResourceUpdated(CANONICAL_URI);

    expect(urisNotified(server)).toEqual([PAGE_A]);
  });

  test("does not fan out to a page of a different path", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    const otherRow = "automobile:pages/two/data?appId=x&limit=10&offset=0";
    await subscribe(server, PAGE_A);
    await subscribe(server, otherRow);

    await ResourceRegistry.notifyResourceUpdated(CANONICAL_URI);

    expect(urisNotified(server)).toEqual([PAGE_A]);
  });

  test("no subscribers means no notification even for a paginated template", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);

    await ResourceRegistry.notifyResourceUpdated(CANONICAL_URI);

    expect(urisNotified(server)).toEqual([]);
  });

  test("non-paginated resources keep exact-match notify semantics", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    // A non-paginated template (no pagination params declared).
    ResourceRegistry.registerTemplate(
      "automobile:plain/{id}{?appId}",
      "Plain",
      "Non-paginated test resource",
      "application/json",
      async (params) => ({ uri: getRequestedResourceUri(params) ?? "", text: "{}" }),
    );
    // A subscription that differs only by a would-be pagination query key.
    await subscribe(server, "automobile:plain/one?appId=x&limit=10");

    // Firing against the canonical URI must NOT fan out — exact match only.
    await ResourceRegistry.notifyResourceUpdated("automobile:plain/one?appId=x");

    expect(urisNotified(server)).toEqual([]);

    // The exact subscribed URI is still notified.
    await ResourceRegistry.notifyResourceUpdated("automobile:plain/one?appId=x&limit=10");
    expect(urisNotified(server)).toEqual(["automobile:plain/one?appId=x&limit=10"]);
  });

  test("fan-out reaches every registered server (issue #3223)", async () => {
    const first = new FakeMcpServer();
    const second = new FakeMcpServer();
    ResourceRegistry.registerWithServer(first as unknown as McpServer);
    ResourceRegistry.registerWithServer(second as unknown as McpServer);
    await subscribe(first, PAGE_A);

    await ResourceRegistry.notifyResourceUpdated(CANONICAL_URI);

    expect(urisNotified(first)).toEqual([PAGE_A]);
    expect(urisNotified(second)).toEqual([PAGE_A]);
  });
});

describe("ResourceRegistry URI-template matching", () => {
  beforeEach(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
  });

  test("captures a raw query-string template with multiple query parameters", () => {
    ResourceRegistry.registerTemplate(
      "automobile:test?{params}",
      "Test",
      "Test raw query template",
      "application/json",
      async () => ({ uri: "automobile:test", text: "{}" }),
    );

    expect(ResourceRegistry.matchTemplate("automobile:test?first=one&second=two")).toMatchObject({
      params: { params: "first=one&second=two" },
    });
  });

  test("passes the registered server's read context to template handlers", async () => {
    const server = new FakeMcpServer();
    ResourceRegistry.registerTemplateWithReadContext(
      "automobile:test/{id}",
      "Test",
      "Test contextual template",
      "application/json",
      async (params, context) => ({
        uri: `automobile:test/${params.id}`,
        text: JSON.stringify({
          sessionUuid: context.sessionUuid,
          hasSignal: context.signal === controller.signal,
        }),
      }),
    );
    const controller = new AbortController();
    ResourceRegistry.registerWithServer(server as unknown as McpServer, (signal) => ({
      sessionUuid: "session-bound",
      signal,
    }));

    const readHandler = server.server.handlersBySchema.get(ReadResourceRequestSchema);
    expect(readHandler).toBeDefined();
    const response = (await readHandler!(
      { params: { uri: "automobile:test/one" } },
      { signal: controller.signal },
    )) as {
      contents: Array<{ text?: string }>;
    };

    expect(JSON.parse(response.contents[0].text!)).toEqual({
      sessionUuid: "session-bound",
      hasSignal: true,
    });
  });

  test("matches an RFC 6570 query expansion in any parameter order", () => {
    ResourceRegistry.registerTemplate(
      "automobile:test{?first,second}",
      "Test",
      "Test query template",
      "application/json",
      async () => ({ uri: "automobile:test", text: "{}" }),
    );

    expect(ResourceRegistry.matchTemplate("automobile:test?second=two&first=one")).toMatchObject({
      params: { first: "one", second: "two" },
    });
  });

  test("ignores an undeclared query key instead of overwriting a path-captured param (issue #6188)", () => {
    ResourceRegistry.registerTemplate(
      "automobile:test/{id}/data{?first}",
      "Test",
      "Test path/query collision",
      "application/json",
      async () => ({ uri: "automobile:test", text: "{}" }),
    );

    const match = ResourceRegistry.matchTemplate("automobile:test/one/data?first=a&id=two");

    expect(match).toMatchObject({ params: { id: "one", first: "a" } });
  });

  test("forwards an undeclared query key that does not collide with a path param, for handler-side validation (issue #6188)", () => {
    ResourceRegistry.registerTemplate(
      "automobile:test{?first}",
      "Test",
      "Test unknown-key passthrough",
      "application/json",
      async () => ({ uri: "automobile:test", text: "{}" }),
    );

    // e.g. a typo'd `limt=10` — sibling handlers (parsePerformanceParams,
    // parseTrafficParams, parseAppsQueryParams) reject unknown keys
    // themselves and need to see them in `params` to do so.
    const match = ResourceRegistry.matchTemplate("automobile:test?first=a&limt=10");

    expect(match).toMatchObject({ params: { first: "a", limt: "10" } });
  });

  test("retains the requested URI for an RFC 6570 template handler", async () => {
    const server = new FakeMcpServer();
    let handlerUri = "";
    ResourceRegistry.registerTemplate(
      "automobile:test{?first,second}",
      "Test",
      "Test query template",
      "application/json",
      async (params) => {
        handlerUri = getRequestedResourceUri(params) ?? "";
        return { uri: handlerUri, text: "{}" };
      },
    );
    ResourceRegistry.registerWithServer(server as unknown as McpServer);

    const readHandler = server.server.handlersBySchema.get(ReadResourceRequestSchema);
    const requestedUri = "automobile:test?second=two&first=one";
    const response = (await readHandler!({ params: { uri: requestedUri } })) as {
      contents: Array<{ uri: string }>;
    };

    expect(handlerUri).toBe(requestedUri);
    expect(response.contents[0].uri).toBe(requestedUri);
  });
});

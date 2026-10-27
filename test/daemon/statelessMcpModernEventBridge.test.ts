import { expect, mock, test } from "bun:test";
import type { ServerEvent } from "@modelcontextprotocol/server";
import { ModernMcpEventBridge } from "../../src/daemon/ModernMcpEventBridge";
import type { ResourceUpdateTargets } from "../../src/daemon/ResourceUpdatedBroadcasterClass";
import type { ListChangedListener } from "../../src/daemon/listChangedBroadcast";

function listen(uris: string[]) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "subscriptions/listen",
    params: { notifications: { resourceSubscriptions: uris } },
  };
}

function harness(maxUrisPerStream = 256, maxUriMemberships = 4096) {
  const updateListeners = new Set<(resolve: ResourceUpdateTargets) => void>();
  const listListeners = new Set<ListChangedListener>();
  const updates = {
    subscribe: mock((listener: (resolve: ResourceUpdateTargets) => void) => {
      updateListeners.add(listener);
      return () => {
        updateListeners.delete(listener);
      };
    }),
  };
  const lists = {
    subscribe: mock((listener: ListChangedListener) => {
      listListeners.add(listener);
      return () => {
        listListeners.delete(listener);
      };
    }),
  };
  const bus = { publish: mock((_event: ServerEvent) => {}) };
  const log = { warn: mock((_message: string, _error?: unknown) => {}) };
  const bridge = new ModernMcpEventBridge(bus, {
    updates,
    lists,
    log,
    maxUrisPerStream,
    maxUriMemberships,
  });
  const emit = (resolve: ResourceUpdateTargets) => {
    for (const listener of updateListeners) {
      listener(resolve);
    }
  };
  return { bridge, bus, log, emit, updateListeners, listListeners };
}

test("resolves the union of exact subscriptions, including pages, and publishes only affected URIs", () => {
  const h = harness();
  h.bridge.track(listen(["resource://table?offset=0", "resource://table?offset=10"]));
  h.bridge.track(listen(["resource://other"]));
  const resolve = mock((subscriptions: Set<string>) => {
    expect([...subscriptions]).toEqual([
      "resource://table?offset=0",
      "resource://table?offset=10",
      "resource://other",
    ]);
    return [...subscriptions].filter((uri) => uri.startsWith("resource://table"));
  });
  h.emit(resolve);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(h.bus.publish.mock.calls).toEqual([
    [{ kind: "resource_updated", uri: "resource://table?offset=0" }],
    [{ kind: "resource_updated", uri: "resource://table?offset=10" }],
  ]);
});

test("deduplicates targets and excludes unsubscribed URIs even if returned by a resolver", () => {
  const h = harness();
  h.bridge.track(listen(["resource://a", "resource://a"]));
  h.emit(() => ["resource://a", "resource://a", "resource://unsubscribed"]);
  expect(h.bus.publish.mock.calls).toEqual([[{ kind: "resource_updated", uri: "resource://a" }]]);
});

test("stream close releases only its references and is idempotent", () => {
  const h = harness();
  const first = h.bridge.track(listen(["resource://shared", "resource://first"]));
  const second = h.bridge.track(listen(["resource://shared"]));
  first?.();
  first?.();
  h.emit((uris) => [...uris]);
  expect(h.bus.publish.mock.calls).toEqual([
    [{ kind: "resource_updated", uri: "resource://shared" }],
  ]);
  second?.();
  const resolve = mock((_uris: Set<string>) => ["resource://shared"]);
  h.emit(resolve);
  expect(resolve).not.toHaveBeenCalled();
});

test("idle disposal unsubscribes both bridges and clears pending stream reservations", () => {
  const h = harness();
  const release = h.bridge.track(listen(["resource://a"]));
  expect(h.updateListeners.size).toBe(1);
  expect(h.listListeners.size).toBe(1);
  h.bridge.close();
  h.bridge.close();
  release?.();
  expect(h.updateListeners.size).toBe(0);
  expect(h.listListeners.size).toBe(0);
  h.emit((uris) => [...uris]);
  expect(h.bus.publish).not.toHaveBeenCalled();
});

test("refuses per-stream URI overflow atomically and logs the limit once", () => {
  const h = harness(1, 5);
  expect(h.bridge.track(listen(["resource://a", "resource://b"]))).toBeNull();
  expect(h.bridge.track(listen(["resource://c", "resource://d"]))).toBeNull();
  h.emit((uris) => [...uris]);
  expect(h.bus.publish).not.toHaveBeenCalled();
  expect(h.log.warn).toHaveBeenCalledTimes(1);
  expect(h.bridge.track(listen(["resource://a", "resource://a"]))).toBeFunction();
});

test("caps total memberships including shared URIs, and reclaims capacity on close", () => {
  const h = harness(2, 2);
  const release = h.bridge.track(listen(["resource://shared"]));
  h.bridge.track(listen(["resource://shared"]));
  expect(h.bridge.track(listen(["resource://shared"]))).toBeNull();
  expect(h.bridge.track(listen(["resource://other"]))).toBeNull();
  release?.();
  release?.();
  expect(h.bridge.track(listen(["resource://other"]))).toBeFunction();
  h.emit((uris) => [...uris]);
  expect(h.bus.publish.mock.calls).toEqual([
    [{ kind: "resource_updated", uri: "resource://shared" }],
    [{ kind: "resource_updated", uri: "resource://other" }],
  ]);
});

test("invalid requests, other methods and absent URI filters never reserve subscriptions", () => {
  const h = harness(0, 0);
  for (const body of [
    null,
    [],
    { ...listen(["resource://a"]), method: "resources/read" },
    { ...listen([]), params: { notifications: { resourceSubscriptions: [123] } } },
    { ...listen([]), params: { notifications: { toolsListChanged: true } } },
  ]) {
    expect(h.bridge.track(body)).toBeFunction();
  }
  const resolve = mock((_uris: Set<string>) => []);
  h.emit(resolve);
  expect(resolve).not.toHaveBeenCalled();
  expect(h.log.warn).not.toHaveBeenCalled();
});

test("resolver mutation cannot corrupt tracked subscriptions", () => {
  const h = harness();
  h.bridge.track(listen(["resource://a"]));
  h.emit((uris) => {
    uris.clear();
    return [];
  });
  h.emit((uris) => [...uris]);
  expect(h.bus.publish.mock.calls).toEqual([[{ kind: "resource_updated", uri: "resource://a" }]]);
});

test("resolver failures are logged and later updates still publish", () => {
  const h = harness();
  h.bridge.track(listen(["resource://a"]));
  const error = new Error("resolver failure");
  h.emit(() => {
    throw error;
  });
  expect(h.log.warn).toHaveBeenCalledWith("Modern MCP resource update resolution failed", error);
  h.emit((uris) => [...uris]);
  expect(h.bus.publish).toHaveBeenCalledTimes(1);
});

test("publish failures are logged without dropping remaining targets", () => {
  const h = harness();
  h.bridge.track(listen(["resource://a", "resource://b"]));
  const error = new Error("bus failure");
  h.bus.publish.mockImplementationOnce(() => {
    throw error;
  });
  h.emit((uris) => [...uris]);
  expect(h.log.warn).toHaveBeenCalledWith("Modern MCP resource update publication failed", error);
  expect(h.bus.publish).toHaveBeenLastCalledWith({ kind: "resource_updated", uri: "resource://b" });
});

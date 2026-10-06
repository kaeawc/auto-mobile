import { describe, it, expect } from "bun:test";
import { buildNetworkGraph, type GraphLeaf, type GraphBranch } from "../../src/server/networkGraph";
import type { NetworkEventWithId } from "../../src/db/networkEventRepository";

function makeEvent(overrides: Partial<NetworkEventWithId> = {}): NetworkEventWithId {
  return {
    id: 1,
    deviceId: "device-1",
    timestamp: 1000,
    applicationId: "com.example",
    sessionId: "session-1",
    url: "https://api.example.com/data",
    method: "GET",
    statusCode: 200,
    durationMs: 100,
    requestBodySize: 0,
    responseBodySize: 50,
    protocol: "h2",
    host: "api.example.com",
    path: "/data",
    error: null,
    requestHeaders: null,
    responseHeaders: null,
    requestBody: null,
    responseBody: null,
    contentType: "application/json",
    ...overrides,
  };
}

describe("buildNetworkGraph", () => {
  it("counts the Playground timeout as an error without changing latency", () => {
    const { graph } = buildNetworkGraph([
      makeEvent({
        path: "/timeout",
        statusCode: 0,
        error: "The request timed out",
        durationMs: 30000,
      }),
      makeEvent({ path: "/posts", method: "POST", durationMs: 250 }),
      makeEvent({ path: "/users", durationMs: 150 }),
    ]);
    expect(graph[0].paths["timeout[GET]"]).toMatchObject({
      success: 0,
      errors: 1,
      p50: 30000,
      p95: 30000,
    });
    expect(graph[0].paths["posts[POST]"]).toMatchObject({
      success: 1,
      errors: 0,
      p50: 250,
      p95: 250,
    });
    expect(graph[0].paths["users[GET]"]).toMatchObject({
      success: 1,
      errors: 0,
      p50: 150,
      p95: 150,
    });
  });

  it("returns empty graph for no events", () => {
    const result = buildNetworkGraph([]);
    expect(result.graph).toHaveLength(0);
  });

  it("groups by host", () => {
    const events = [
      makeEvent({ url: "https://api.example.com/a", host: "api.example.com", path: "/a" }),
      makeEvent({ url: "https://cdn.example.com/b", host: "cdn.example.com", path: "/b" }),
    ];

    const result = buildNetworkGraph(events);
    expect(result.graph).toHaveLength(2);

    const hosts = result.graph.map((g) => g.host).sort();
    expect(hosts).toEqual(["api.example.com", "cdn.example.com"]);
  });

  it("builds path tree", () => {
    const events = [
      makeEvent({ url: "https://api.example.com/v1/users", path: "/v1/users" }),
      makeEvent({ url: "https://api.example.com/v1/posts", path: "/v1/posts" }),
    ];

    const result = buildNetworkGraph(events);
    expect(result.graph).toHaveLength(1);

    const hostEntry = result.graph[0];
    expect(hostEntry.paths["v1"]).toBeDefined();

    const v1 = hostEntry.paths["v1"] as GraphBranch;
    expect(v1.paths["users[GET]"]).toBeDefined();
    expect(v1.paths["posts[GET]"]).toBeDefined();
  });

  it("computes stats correctly", () => {
    const events = [
      makeEvent({ path: "/data", durationMs: 100, statusCode: 200 }),
      makeEvent({ path: "/data", durationMs: 200, statusCode: 200 }),
      makeEvent({ path: "/data", durationMs: 300, statusCode: 500 }),
    ];

    const result = buildNetworkGraph(events);
    const leaf = result.graph[0].paths["data[GET]"] as GraphLeaf;

    expect(leaf.success).toBe(2);
    expect(leaf.errors).toBe(1);
    expect(leaf.p50).toBe(200);
    expect(leaf.p95).toBe(290);
  });

  it("detects numeric IDs as parameterized", () => {
    const events = [
      makeEvent({ url: "https://api.example.com/users/123/posts", path: "/users/123/posts" }),
      makeEvent({ url: "https://api.example.com/users/456/posts", path: "/users/456/posts" }),
    ];

    const result = buildNetworkGraph(events);
    const users = result.graph[0].paths["users"] as GraphBranch;

    // Both 123 and 456 should collapse into {id}
    expect(users.paths["{id}"]).toBeDefined();
    const idNode = users.paths["{id}"] as GraphBranch;
    expect((idNode as any).parameterized).toBe(true);
    expect(idNode.paths["posts[GET]"]).toBeDefined();
  });

  it("detects UUID segments as parameterized", () => {
    const events = [
      makeEvent({
        url: "https://api.example.com/items/550e8400-e29b-41d4-a716-446655440000",
        path: "/items/550e8400-e29b-41d4-a716-446655440000",
      }),
    ];

    const result = buildNetworkGraph(events);
    const items = result.graph[0].paths["items"] as GraphBranch;
    expect(items.paths["{id}[GET]"]).toBeDefined();
  });

  it("recomputes percentiles when merging parameterized paths", () => {
    const events = [
      makeEvent({ url: "https://api.example.com/users/123", path: "/users/123", durationMs: 100 }),
      makeEvent({ url: "https://api.example.com/users/456", path: "/users/456", durationMs: 300 }),
    ];

    const result = buildNetworkGraph(events);
    const users = result.graph[0].paths["users"] as GraphBranch;
    const idNode = users.paths["{id}[GET]"] as GraphLeaf;

    // Both durations (100, 300) merged — p50 should be 200 (midpoint), not 100 or 300
    expect(idNode.success).toBe(2);
    expect(idNode.p50).toBe(200);
    expect(idNode.p95).toBe(290);
  });

  it("filters by minRequests", () => {
    const events = [
      makeEvent({ path: "/popular", id: 1 }),
      makeEvent({ path: "/popular", id: 2 }),
      makeEvent({ path: "/popular", id: 3 }),
      makeEvent({ path: "/rare", id: 4 }),
    ];

    const result = buildNetworkGraph(events, { minRequests: 2 });
    const paths = result.graph[0].paths;

    expect(paths["popular[GET]"]).toBeDefined();
    expect(paths["rare[GET]"]).toBeUndefined();
  });

  // Issue #9917: minRequests was applied per raw URL before `{id}` collapse.
  it("applies minRequests to the collapsed parameterized endpoint", () => {
    const events = [1, 2, 3].map((n) =>
      makeEvent({
        id: n,
        url: `https://api.example.com/users/${n}`,
        path: `/users/${n}`,
        durationMs: 100 * n,
      }),
    );

    const result = buildNetworkGraph(events, { minRequests: 2 });
    const users = result.graph[0].paths["users"] as GraphBranch;
    const idNode = users.paths["{id}[GET]"] as GraphLeaf;

    expect(idNode.success).toBe(3);
    expect(idNode.p50).toBe(200);
    expect(users.parameterized).toBeUndefined();
    expect(Object.keys(idNode)).not.toContain("_durations");
  });

  it("still drops a collapsed endpoint that stays under minRequests and prunes empty branches", () => {
    const events = [
      makeEvent({ id: 1, url: "https://api.example.com/users/1", path: "/users/1" }),
      makeEvent({ id: 2, url: "https://api.example.com/users/2", path: "/users/2" }),
      makeEvent({ id: 3, path: "/popular" }),
      makeEvent({ id: 4, path: "/popular" }),
    ];

    const { graph } = buildNetworkGraph(events, { minRequests: 3 });
    expect(graph).toHaveLength(0);

    const kept = buildNetworkGraph(events, { minRequests: 2 }).graph[0].paths;
    expect(Object.keys(kept).sort()).toEqual(["popular[GET]", "users"]);
  });

  it("keeps deeper collapsed endpoints when a sibling leaf on the parent path is under minRequests", () => {
    const events = [
      makeEvent({ id: 1, path: "/users" }),
      ...[1, 2].map((n) =>
        makeEvent({
          id: 10 + n,
          url: `https://api.example.com/users/${n}/posts`,
          path: `/users/${n}/posts`,
        }),
      ),
    ];

    const users = buildNetworkGraph(events, { minRequests: 2 }).graph[0].paths;
    expect(users["users[GET]"]).toBeUndefined();
    const idBranch = (users["users"] as GraphBranch).paths["{id}"] as GraphBranch;
    expect((idBranch.paths["posts[GET]"] as GraphLeaf).success).toBe(2);
  });

  it("separates schemes", () => {
    const events = [
      makeEvent({ url: "https://api.example.com/a", host: "api.example.com", path: "/a" }),
      makeEvent({ url: "http://api.example.com/b", host: "api.example.com", path: "/b" }),
    ];

    const result = buildNetworkGraph(events);
    expect(result.graph).toHaveLength(2);

    const schemes = result.graph.map((g) => g.scheme).sort();
    expect(schemes).toEqual(["http", "https"]);
  });

  it("separates GET and POST on the same path", () => {
    const events = [
      makeEvent({ path: "/users", method: "GET", durationMs: 50, statusCode: 200 }),
      makeEvent({ path: "/users", method: "POST", durationMs: 150, statusCode: 201 }),
      makeEvent({ path: "/users", method: "GET", durationMs: 100, statusCode: 200 }),
    ];

    const result = buildNetworkGraph(events);
    const paths = result.graph[0].paths;

    const getLeaf = paths["users[GET]"] as GraphLeaf;
    const postLeaf = paths["users[POST]"] as GraphLeaf;

    expect(getLeaf).toBeDefined();
    expect(postLeaf).toBeDefined();
    expect(getLeaf.method).toBe("GET");
    expect(postLeaf.method).toBe("POST");
    expect(getLeaf.success).toBe(2);
    expect(postLeaf.success).toBe(1);
    expect(getLeaf.p50).toBe(75);
    expect(postLeaf.p50).toBe(150);
  });
});

// Issue #4187: the tree used `{}` nodes guarded by `!node[key]`, so a path segment
// named after an `Object.prototype` member read back as the inherited member
// (truthy), the branch was never created, and `branch.paths = {}` was written onto
// the global `Object` constructor instead.
describe("buildNetworkGraph prototype-named path segments (issue #4187)", () => {
  const PROTOTYPE_SEGMENTS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it.each([...PROTOTYPE_SEGMENTS, "normalSegment"])(
    "builds a branch for the %s segment without touching Object",
    (segment) => {
      const events = [
        makeEvent({ url: `https://api.example.com/${segment}/items`, path: `/${segment}/items` }),
      ];

      const result = buildNetworkGraph(events);

      expect(result.graph).toHaveLength(1);
      const root = result.graph[0].paths;
      expect(Object.prototype.hasOwnProperty.call(root, segment)).toBe(true);
      const branch = root[segment] as GraphBranch;
      expect(Object.keys(branch.paths)).toEqual(["items[GET]"]);
      expect((branch.paths["items[GET]"] as GraphLeaf).success).toBe(1);
      expect((Object as unknown as { paths?: unknown }).paths).toBeUndefined();
    },
  );

  it.each([...PROTOTYPE_SEGMENTS, "normalSegment"])("records a leaf named %s", (segment) => {
    const events = [makeEvent({ url: `https://api.example.com/${segment}`, path: `/${segment}` })];

    const result = buildNetworkGraph(events);
    const root = result.graph[0].paths;
    expect(Object.prototype.hasOwnProperty.call(root, `${segment}[GET]`)).toBe(true);
    expect((root[`${segment}[GET]`] as GraphLeaf).success).toBe(1);
  });
});

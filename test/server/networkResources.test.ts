import { afterEach, describe, it, expect } from "bun:test";
import { aggregateStatsByHost, bucketEvents } from "../../src/server/networkResources";
import { registerNetworkResources } from "../../src/server/networkResources";
import type { NetworkEventWithId } from "../../src/db/networkEventRepository";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { NetworkState } from "../../src/server/NetworkState";

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

describe("bucketEvents", () => {
  it("counts missing responses and recorded transport errors", () => {
    const events = [
      makeEvent({ statusCode: 0 }),
      makeEvent({ error: "timed out" }),
      makeEvent({ statusCode: 301 }),
    ];
    expect(bucketEvents(events, 60)[0]).toMatchObject({ requests: 3, errors: 2 });
  });

  it("returns empty array for no events", () => {
    expect(bucketEvents([], 60)).toEqual([]);
  });

  it("places all events in one bucket when within range", () => {
    const events = [
      makeEvent({ timestamp: 10_000, durationMs: 100 }),
      makeEvent({ timestamp: 20_000, durationMs: 200 }),
      makeEvent({ timestamp: 30_000, durationMs: 300 }),
    ];

    const buckets = bucketEvents(events, 60);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].requests).toBe(3);
    expect(buckets[0].errors).toBe(0);
    expect(buckets[0].avgDurationMs).toBe(200);
    expect(buckets[0].p50).toBe(200);
  });

  it("splits events across multiple buckets", () => {
    const events = [
      makeEvent({ timestamp: 0, durationMs: 100, statusCode: 200 }),
      makeEvent({ timestamp: 30_000, durationMs: 200, statusCode: 200 }),
      makeEvent({ timestamp: 60_000, durationMs: 300, statusCode: 500 }),
      makeEvent({ timestamp: 90_000, durationMs: 400, statusCode: 200 }),
    ];

    const buckets = bucketEvents(events, 60);
    expect(buckets).toHaveLength(2);

    // First bucket: 0-60s
    expect(buckets[0].requests).toBe(2);
    expect(buckets[0].errors).toBe(0);

    // Second bucket: 60-120s
    expect(buckets[1].requests).toBe(2);
    expect(buckets[1].errors).toBe(1);
  });

  it("includes empty buckets in gaps", () => {
    const events = [
      makeEvent({ timestamp: 0, durationMs: 100 }),
      makeEvent({ timestamp: 120_000, durationMs: 200 }),
    ];

    const buckets = bucketEvents(events, 60);
    expect(buckets).toHaveLength(3);
    expect(buckets[0].requests).toBe(1);
    expect(buckets[1].requests).toBe(0);
    expect(buckets[2].requests).toBe(1);
  });

  it("computes p95 correctly", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ timestamp: 0, durationMs: i + 1 }),
    );

    const buckets = bucketEvents(events, 60);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].p50).toBe(51);
    expect(buckets[0].p95).toBe(95);
  });

  it("counts errors per bucket", () => {
    const events = [
      makeEvent({ timestamp: 0, statusCode: 200 }),
      makeEvent({ timestamp: 1000, statusCode: 404 }),
      makeEvent({ timestamp: 2000, statusCode: 500 }),
    ];

    const buckets = bucketEvents(events, 60);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].errors).toBe(2);
  });

  it("buckets are sorted by time", () => {
    const events = [
      makeEvent({ timestamp: 120_000 }),
      makeEvent({ timestamp: 0 }),
      makeEvent({ timestamp: 60_000 }),
    ];

    const buckets = bucketEvents(events, 60);
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].bucketStart).toBeGreaterThan(buckets[i - 1].bucketStart);
    }
  });

  it("caps bucket count for sparse time ranges", () => {
    // Two events 10M seconds apart with 1s buckets would create 10M buckets without the cap
    const events = [makeEvent({ timestamp: 0 }), makeEvent({ timestamp: 10_000_000_000 })];

    const buckets = bucketEvents(events, 1);
    expect(buckets.length).toBeLessThanOrEqual(1000);
    // The later event should still land in a bucket
    expect(buckets[buckets.length - 1].requests).toBe(1);
  });
});

// Issue #4187: `byHost` was a `{}` map guarded by `!byHost[host]`, so a host named
// after an `Object.prototype` member read back as the inherited member (truthy),
// initialization was skipped, and the host vanished from the emitted stats.
describe("aggregateStatsByHost", () => {
  it("counts missing responses and recorded transport errors per host", () => {
    expect(
      aggregateStatsByHost([
        makeEvent({ statusCode: 0 }),
        makeEvent({ error: "cancelled" }),
        makeEvent({ statusCode: 301 }),
      ])["api.example.com"],
    ).toMatchObject({ requests: 3, errors: 2 });
  });

  const PROTOTYPE_HOSTS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it.each([...PROTOTYPE_HOSTS, "api.example.com"])("aggregates the %s host", (host) => {
    const stats = aggregateStatsByHost([
      makeEvent({ host, durationMs: 100, statusCode: 200 }),
      makeEvent({ host, durationMs: 300, statusCode: 500 }),
    ]);

    expect(Object.prototype.hasOwnProperty.call(stats, host)).toBe(true);
    expect(stats[host]).toEqual({ requests: 2, errors: 1, p50: 200, p95: 290 });
  });

  it("keeps separate hosts separate", () => {
    const stats = aggregateStatsByHost([
      makeEvent({ host: "constructor", statusCode: 200 }),
      makeEvent({ host: "api.example.com", statusCode: 404 }),
    ]);

    expect(Object.keys(stats).sort()).toEqual(["api.example.com", "constructor"]);
    expect(stats["constructor"].errors).toBe(0);
    expect(stats["api.example.com"].errors).toBe(1);
  });
});

describe("network resource registration", () => {
  it("reads live events with the stream limit and summary shape", async () => {
    registerNetworkResources({
      getNetworkEvents: async (query) => {
        expect(query).toEqual({ limit: 20 });
        return [makeEvent()];
      },
      getNetworkEventById: async () => null,
    });
    const content = await ResourceRegistry.getResource(
      "automobile:network/traffic/live",
    )!.handler();
    expect(content.uri).toBe("automobile:network/traffic/live");
    expect(JSON.parse(content.text!)).toEqual({
      events: [
        {
          id: 1,
          timestamp: 1000,
          method: "GET",
          url: "https://api.example.com/data",
          host: "api.example.com",
          path: "/data",
          statusCode: 200,
          durationMs: 100,
          protocol: "h2",
          contentType: "application/json",
          error: null,
        },
      ],
    });
  });

  it("returns zero aggregate statistics for an empty capture", async () => {
    registerNetworkResources({
      getNetworkEvents: async (query) => {
        expect(query).toEqual({ limit: 200 });
        return [];
      },
      getNetworkEventById: async () => null,
    });
    const content = await ResourceRegistry.getResource("automobile:network/stats")!.handler();
    expect(JSON.parse(content.text!)).toEqual({
      totalRequests: 0,
      errorCount: 0,
      errorRate: 0,
      avgDurationMs: 0,
      p50: 0,
      p95: 0,
      byHost: {},
    });
  });
  it("includes transport failures in the stats error count and rate", async () => {
    registerNetworkResources({
      getNetworkEvents: async () => [
        makeEvent({ statusCode: 0 }),
        makeEvent({ error: "timed out" }),
        makeEvent({ statusCode: 301 }),
        makeEvent(),
      ],
      getNetworkEventById: async () => null,
    });
    const content = await ResourceRegistry.getResource("automobile:network/stats")!.handler();
    expect(JSON.parse(content.text!)).toMatchObject({
      totalRequests: 4,
      errorCount: 2,
      errorRate: 0.5,
    });
  });

  it("queries failures before applying the errors resource limit", async () => {
    registerNetworkResources({
      getNetworkEvents: async (query) => {
        expect(query).toEqual({ errorsOnly: true, limit: 20 });
        return [makeEvent({ statusCode: 0, error: "timed out" })];
      },
      getNetworkEventById: async () => null,
    });
    const content = await ResourceRegistry.getResource(
      "automobile:network/traffic/errors",
    )!.handler();
    expect(JSON.parse(content.text!).errors).toHaveLength(1);
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
    NetworkState.resetInstance();
  });

  it("lists every device's mock rules tagged with the device they apply to (#10061)", async () => {
    registerNetworkResources();
    const state = NetworkState.getInstance();
    const rule = {
      path: "/x",
      method: "*",
      limit: null,
      statusCode: 500,
      responseHeaders: {},
      responseBody: "",
      contentType: "application/json",
    };
    state.addMock("emulator-5554", { ...rule, host: "a.com" });
    state.addMock("emulator-5556", { ...rule, host: "b.com" });

    const content = await ResourceRegistry.getResource("automobile:network/mocks")!.handler();
    const payload = JSON.parse(content.text!);

    expect(payload.count).toBe(2);
    expect(payload.mocks.map((mock: { deviceId: string }) => mock.deviceId)).toEqual([
      "emulator-5554",
      "emulator-5556",
    ]);
    state.clearAllMocks("emulator-5556");
    const after = JSON.parse(
      (await ResourceRegistry.getResource("automobile:network/mocks")!.handler()).text!,
    );
    expect(after.count).toBe(1);
  });

  it("uses the canonical automobile:path form for every network resource", () => {
    registerNetworkResources();
    const uris = ResourceRegistry.getResourceDefinitions().map((resource) => resource.uri);
    expect(uris).toContain("automobile:network/traffic/live");
    expect(uris).toContain("automobile:network/stats");
    expect(uris.some((uri) => uri.startsWith("automobile://"))).toBe(false);
  });

  it("registers one RFC 6570 query template for traffic filters", () => {
    registerNetworkResources();

    const templates = ResourceRegistry.getAllTemplates().filter((template) =>
      template.uriTemplate.startsWith("automobile:network/traffic"),
    );

    expect(templates.map((template) => template.uriTemplate)).toEqual([
      "automobile:network/traffic{?host,method,statusCode,since,limit,deviceId,bucketSeconds}",
    ]);
  });
});

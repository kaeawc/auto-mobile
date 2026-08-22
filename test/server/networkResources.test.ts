import { afterEach, describe, it, expect } from "bun:test";
import { aggregateStatsByHost, bucketEvents } from "../../src/server/networkResources";
import { registerNetworkResources } from "../../src/server/networkResources";
import type { NetworkEventWithId } from "../../src/db/networkEventRepository";
import { ResourceRegistry } from "../../src/server/resourceRegistry";

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
      makeEvent({ timestamp: 0, durationMs: i + 1 })
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
    const events = [
      makeEvent({ timestamp: 0 }),
      makeEvent({ timestamp: 10_000_000_000 }),
    ];

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
  const PROTOTYPE_HOSTS = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  it.each([...PROTOTYPE_HOSTS, "api.example.com"])("aggregates the %s host", host => {
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
  afterEach(() => {
    ResourceRegistry.clearResources();
  });

  it("registers one RFC 6570 query template for traffic filters", () => {
    registerNetworkResources();

    const templates = ResourceRegistry.getAllTemplates()
      .filter(template => template.uriTemplate.startsWith("automobile:network/traffic"));

    expect(templates.map(template => template.uriTemplate)).toEqual([
      "automobile:network/traffic{?host,method,statusCode,since,limit,deviceId,bucketSeconds}"
    ]);
  });
});

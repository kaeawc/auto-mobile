import { describe, expect, test } from "bun:test";
import {
  PerformanceStreamSocketServer,
  type PerformanceStreamRepository,
} from "../../src/daemon/performanceStreamSocketServer";
import type {
  PerformanceStreamSocketRequest,
  PerformanceStreamSocketResponse,
} from "../../src/daemon/performanceStreamSocketTypes";
import { FakeTimer } from "../fakes/FakeTimer";

type Query = Parameters<PerformanceStreamRepository["listResultsSince"]>[0];
type Results = Awaited<ReturnType<PerformanceStreamRepository["listResultsSince"]>>;

class FakeRepository implements PerformanceStreamRepository {
  queries: Query[] = [];
  results: Results = [];
  error?: Error;

  async listResultsSince(query: Query): Promise<Results> {
    this.queries.push(query);
    if (this.error) {
      throw this.error;
    }
    return this.results;
  }
}

class TestableServer extends PerformanceStreamSocketServer {
  dispatch(request: PerformanceStreamSocketRequest): Promise<PerformanceStreamSocketResponse> {
    return this.handleRequest(request);
  }
}

function setup() {
  const repository = new FakeRepository();
  const server = new TestableServer("/fake/performance.sock", new FakeTimer(), repository);
  return { repository, server };
}

describe("performance poll query and cursor characterization", () => {
  for (const value of [undefined, "", "   ", " device "]) {
    test(`normalizes optional filters ${JSON.stringify(value)}`, async () => {
      const { repository, server } = setup();
      const response = await server.dispatch({
        command: "poll",
        deviceId: value,
        sessionId: value,
        packageName: value,
        sinceTimestamp: "1000",
        sinceId: 7,
      });
      expect(repository.queries).toEqual([
        {
          startTime: undefined,
          endTime: undefined,
          limit: 200,
          deviceId: value?.trim() || undefined,
          sessionId: value?.trim() || undefined,
          packageName: value?.trim() || undefined,
          sinceTimestamp: "1970-01-01T00:00:01.000Z",
          sinceId: 7,
        },
      ]);
      expect(response).toEqual({
        success: true,
        results: [],
        lastTimestamp: "1970-01-01T00:00:01.000Z",
        lastId: 7,
      });
    });
  }

  test("returns the last result's cursor without sorting or replacing results", async () => {
    const { repository, server } = setup();
    const entry: Results[number] = {
      id: 12,
      timestamp: "2026-01-01T00:00:00.000Z",
      deviceId: "device",
      sessionId: "session",
      packageName: "app",
      passed: true,
      diagnostics: null,
      nodeId: null,
      metrics: {
        p50Ms: null,
        p90Ms: null,
        p95Ms: null,
        p99Ms: null,
        jankCount: null,
        missedVsyncCount: null,
        slowUiThreadCount: null,
        frameDeadlineMissedCount: null,
        cpuUsagePercent: null,
        touchLatencyMs: null,
      },
    };
    repository.results = [{ ...entry, id: 20 }, entry];
    const response = await server.dispatch({ command: "poll", sinceId: 1 });
    expect(response.results).toBe(repository.results);
    expect(response.lastId).toBe(12);
    expect(response.lastTimestamp).toBe(entry.timestamp);
  });

  test("rejects unsupported commands and invalid cursors before querying", async () => {
    const { repository, server } = setup();
    await expect(
      server.dispatch({ command: "unknown" } as unknown as PerformanceStreamSocketRequest),
    ).rejects.toThrow("Unsupported performance stream command: unknown");
    await expect(server.dispatch({ command: "poll", sinceId: -1 })).rejects.toThrow();
    expect(repository.queries).toEqual([]);
  });

  test("propagates repository failure", async () => {
    const { repository, server } = setup();
    repository.error = new Error("query failed");
    await expect(server.dispatch({ command: "poll" })).rejects.toThrow("query failed");
    expect(repository.queries).toHaveLength(1);
  });
});

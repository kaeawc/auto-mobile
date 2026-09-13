import { describe, it, expect } from "bun:test";
import {
  PerformanceStreamSocketServer,
  type PerformanceStreamRepository,
} from "../../src/daemon/performanceStreamSocketServer";
import type { PerformanceAuditStreamQuery } from "../../src/db/performanceAuditRepository";
import type {
  PerformanceStreamSocketRequest,
  PerformanceStreamSocketResponse,
} from "../../src/daemon/performanceStreamSocketTypes";
import { STREAM_LIMIT_MAX } from "../../src/daemon/streamQueryNormalizers";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Records the query the server hands the repository so the normalization of
 * `since`/`until` timestamps and `limit` can be asserted without a real
 * database (issue #6677; the real repository would resolve getDatabase()).
 */
class FakePerformanceAuditRepository implements PerformanceStreamRepository {
  lastQuery: PerformanceAuditStreamQuery | null = null;

  async listResultsSince(query: PerformanceAuditStreamQuery) {
    this.lastQuery = query;
    return [];
  }
}

class TestablePerformanceStreamSocketServer extends PerformanceStreamSocketServer {
  handleRequestForTest(
    request: PerformanceStreamSocketRequest,
  ): Promise<PerformanceStreamSocketResponse> {
    return this.handleRequest(request);
  }
}

function createServer(): {
  server: TestablePerformanceStreamSocketServer;
  repository: FakePerformanceAuditRepository;
} {
  const repository = new FakePerformanceAuditRepository();
  const server = new TestablePerformanceStreamSocketServer(
    "/fake/performance-stream.sock",
    new FakeTimer(),
    repository,
  );
  return { server, repository };
}

describe("PerformanceStreamSocketServer query normalization (#6677)", () => {
  it("is constructible with a fake repository (no real database)", () => {
    const { server } = createServer();
    expect(server).toBeInstanceOf(PerformanceStreamSocketServer);
  });

  it("reads a bare numeric string timestamp as epoch millis, not as a year", async () => {
    const { server, repository } = createServer();

    await server.handleRequestForTest({ command: "poll", startTime: "1000" });

    expect(repository.lastQuery?.startTime).toBe(new Date(1000).toISOString());
  });

  it("reads a numeric epoch-millis cursor consistently whether it arrives as a string or a number", async () => {
    const { server, repository } = createServer();
    const epochMs = 1_760_000_000_000;

    await server.handleRequestForTest({
      command: "poll",
      sinceTimestamp: String(epochMs),
    } as PerformanceStreamSocketRequest);
    const fromString = repository.lastQuery?.sinceTimestamp;

    await server.handleRequestForTest({
      command: "poll",
      sinceTimestamp: epochMs,
    } as unknown as PerformanceStreamSocketRequest);

    expect(fromString).toBe(new Date(epochMs).toISOString());
    expect(repository.lastQuery?.sinceTimestamp).toBe(fromString);
  });

  it("still accepts ISO-8601 timestamps", async () => {
    const { server, repository } = createServer();

    await server.handleRequestForTest({ command: "poll", endTime: "2026-01-02T03:04:05.000Z" });

    expect(repository.lastQuery?.endTime).toBe("2026-01-02T03:04:05.000Z");
  });

  it("rejects a negative numeric timestamp", async () => {
    const { server } = createServer();

    await expect(server.handleRequestForTest({ command: "poll", startTime: "-5" })).rejects.toThrow(
      "Invalid startTime: -5",
    );
  });

  it("rejects a non-date string timestamp", async () => {
    const { server } = createServer();

    await expect(
      server.handleRequestForTest({ command: "poll", startTime: "not-a-date" }),
    ).rejects.toThrow("Invalid startTime: not-a-date");
  });

  it("caps an over-max limit at STREAM_LIMIT_MAX", async () => {
    const { server, repository } = createServer();

    await server.handleRequestForTest({ command: "poll", limit: 1_000_000 });

    expect(repository.lastQuery?.limit).toBe(STREAM_LIMIT_MAX);
  });

  it("passes a limit under the cap through unchanged", async () => {
    const { server, repository } = createServer();

    await server.handleRequestForTest({ command: "poll", limit: 10 });

    expect(repository.lastQuery?.limit).toBe(10);
  });

  it("rejects a non-positive limit", async () => {
    const { server } = createServer();

    await expect(server.handleRequestForTest({ command: "poll", limit: 0 })).rejects.toThrow(
      "Invalid limit: 0",
    );
  });
});

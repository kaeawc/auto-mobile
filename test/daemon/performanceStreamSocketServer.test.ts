import { createTestDatabase } from "../db/testDbHelper";
import { PerformanceAuditRepository } from "../../src/db/performanceAuditRepository";
import { beforeAll, afterAll, describe, it, test, expect } from "bun:test";
import {
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
  type StreamAuthorizeInput,
} from "../../src/daemon/streamSocketAuth";
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

function createServer(authenticator: StreamSocketAuthenticator = { authorize() {} }): {
  server: TestablePerformanceStreamSocketServer;
  repository: FakePerformanceAuditRepository;
} {
  const repository = new FakePerformanceAuditRepository();
  const server = new TestablePerformanceStreamSocketServer(
    "/fake/performance-stream.sock",
    new FakeTimer(),
    repository,
    { authenticator },
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

describe("performance poll authentication", () => {
  test("rejects missing session with push-stream registration guidance", async () => {
    const repository = new FakePerformanceAuditRepository();
    const server = new TestablePerformanceStreamSocketServer(
      "/fake/performance.sock",
      new FakeTimer(),
      repository,
    );
    await expect(server.handleRequestForTest({ command: "poll" })).rejects.toThrow(
      "Register a session with daemon/registerSession",
    );
    expect(repository.lastQuery).toBeNull();
  });

  test("passes the session to the fake authenticator and preserves the poll response", async () => {
    const calls: StreamAuthorizeInput[] = [];
    const authenticator: StreamSocketAuthenticator = {
      authorize(input) {
        calls.push(input);
      },
    };
    const { server } = createServer(authenticator);
    const response = await server.handleRequestForTest({
      command: "poll",
      sessionUuid: "live-session",
    });
    expect(calls).toEqual([{ sessionUuid: "live-session", deviceId: undefined }]);
    expect(response).toEqual({
      success: true,
      results: [],
      lastTimestamp: undefined,
      lastId: undefined,
    });
  });

  test("auth opt-out permits a poll without a session", async () => {
    const previous = process.env.AUTOMOBILE_DAEMON_STREAM_AUTH;
    process.env.AUTOMOBILE_DAEMON_STREAM_AUTH = "0";
    try {
      const { server } = createServer(
        createDefaultStreamSocketAuthenticator("performanceStream", {
          allowObserverSessions: true,
        }),
      );
      expect((await server.handleRequestForTest({ command: "poll" })).success).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_DAEMON_STREAM_AUTH;
      } else {
        process.env.AUTOMOBILE_DAEMON_STREAM_AUTH = previous;
      }
    }
  });
  test("authorizes the normalized device filter before querying", async () => {
    const calls: StreamAuthorizeInput[] = [];
    const { server, repository } = createServer({
      authorize(input) {
        calls.push(input);
        throw new Error("foreign device");
      },
    });
    await expect(
      server.handleRequestForTest({
        command: "poll",
        sessionUuid: "live-session",
        deviceId: " device-1 ",
      }),
    ).rejects.toThrow("foreign device");
    expect(calls).toEqual([{ sessionUuid: "live-session", deviceId: "device-1" }]);
    expect(repository.lastQuery).toBeNull();
  });
});

describe("performance poll in-memory repository", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.destroy();
  });

  test("preserves an empty poll response with an admitting authenticator", async () => {
    const timer = new FakeTimer();
    const server = new TestablePerformanceStreamSocketServer(
      "/fake/performance.sock",
      timer,
      new PerformanceAuditRepository(timer, db),
      { authenticator: { authorize() {} } },
    );
    const response = await server.handleRequestForTest({
      command: "poll",
      sessionUuid: "live-session",
      sinceId: 7,
    });
    expect(response).toEqual({ success: true, results: [], lastTimestamp: undefined, lastId: 7 });
  });
});

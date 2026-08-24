import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  FailuresStreamSocketServer,
  type FailuresStreamRepository,
} from "../../src/daemon/failuresStreamSocketServer";
import type {
  FailuresStreamSocketRequest,
  FailuresStreamSocketResponse,
} from "../../src/daemon/failuresStreamSocketTypes";

/**
 * Fake repository — records the last query each handler forwards so the tests can
 * assert what normalization produced, and never resolves the real file-backed
 * database (issue #3067).
 */
class FakeFailuresRepository implements FailuresStreamRepository {
  lastNotificationsQuery?: Parameters<FailuresStreamRepository["getNotificationsSince"]>[0];
  lastGroupsQuery?: Parameters<FailuresStreamRepository["getAggregatedGroups"]>[0];
  lastTimelineQuery?: Parameters<FailuresStreamRepository["getTimelineData"]>[0];
  acknowledgedIds?: number[];

  async getNotificationsSince(
    query: Parameters<FailuresStreamRepository["getNotificationsSince"]>[0],
  ): ReturnType<FailuresStreamRepository["getNotificationsSince"]> {
    this.lastNotificationsQuery = query;
    return { notifications: [], lastTimestamp: undefined, lastId: undefined };
  }

  async getAggregatedGroups(
    query: Parameters<FailuresStreamRepository["getAggregatedGroups"]>[0],
  ): ReturnType<FailuresStreamRepository["getAggregatedGroups"]> {
    this.lastGroupsQuery = query;
    return { groups: [], totals: { crashes: 0, anrs: 0, toolFailures: 0 } };
  }

  async getTimelineData(
    query: Parameters<FailuresStreamRepository["getTimelineData"]>[0],
  ): ReturnType<FailuresStreamRepository["getTimelineData"]> {
    this.lastTimelineQuery = query;
    return { dataPoints: [], previousPeriodTotals: undefined as never };
  }

  async acknowledgeNotifications(ids: number[]): Promise<void> {
    this.acknowledgedIds = ids;
  }
}

/** Subclass to reach the protected dispatcher without a live socket. */
class TestableServer extends FailuresStreamSocketServer {
  run(request: FailuresStreamSocketRequest): Promise<FailuresStreamSocketResponse> {
    return this.handleRequest(request);
  }
}

function makeServer(): { server: TestableServer; repo: FakeFailuresRepository; timer: FakeTimer } {
  const repo = new FakeFailuresRepository();
  const timer = new FakeTimer();
  const server = new TestableServer("/tmp/failures-stream-test.sock", timer, repo);
  return { server, repo, timer };
}

describe("FailuresStreamSocketServer sinceTimestamp normalization", () => {
  // Table rows are the spec. `expected` is the epoch-ms value the handler must
  // forward to the repository; `throws` marks inputs rejected before any query.
  const rows: Array<{ name: string; input: unknown; expected?: number; throws?: boolean }> = [
    {
      name: "a bare numeric string is an epoch-ms number, not the year 1000",
      input: "1000",
      expected: 1000,
    },
    { name: "a padded numeric string is trimmed then read as a number", input: " 1 ", expected: 1 },
    { name: "a numeric value passes through unchanged", input: 1000, expected: 1000 },
    { name: "zero is a valid cursor", input: 0, expected: 0 },
    {
      name: "an ISO 8601 string is parsed to its epoch ms",
      input: "2020-01-01T00:00:00.000Z",
      expected: Date.parse("2020-01-01T00:00:00.000Z"),
    },
    { name: "undefined leaves the cursor unset", input: undefined, expected: undefined },
    { name: "an empty string leaves the cursor unset", input: "", expected: undefined },
    { name: "a whitespace-only string leaves the cursor unset", input: "   ", expected: undefined },
    {
      name: "a negative numeric string is rejected by the negative guard",
      input: "-5",
      throws: true,
    },
    { name: "a negative number is rejected", input: -5, throws: true },
    { name: "a non-numeric non-date string is rejected", input: "not-a-date", throws: true },
  ];

  for (const row of rows) {
    test(`poll_notifications forwards ${row.name}`, async () => {
      const { server, repo } = makeServer();
      const request = {
        command: "poll_notifications",
        sinceTimestamp: row.input,
      } as unknown as FailuresStreamSocketRequest;

      if (row.throws) {
        await expect(server.run(request)).rejects.toThrow(/Invalid sinceTimestamp/);
        expect(repo.lastNotificationsQuery).toBeUndefined();
        return;
      }

      const response = await server.run(request);
      expect(response.success).toBe(true);
      expect(repo.lastNotificationsQuery?.sinceTimestamp).toBe(row.expected as number | undefined);
    });
  }
});

describe("FailuresStreamSocketServer command validation", () => {
  test("poll_timeline rejects an unknown aggregation before touching the repository", async () => {
    const { server, repo } = makeServer();
    const request = {
      command: "poll_timeline",
      aggregation: "fortnight",
    } as unknown as FailuresStreamSocketRequest;

    await expect(server.run(request)).rejects.toThrow(/Invalid aggregation: fortnight/);
    expect(repo.lastTimelineQuery).toBeUndefined();
  });

  test("poll_timeline forwards a valid aggregation to the repository", async () => {
    const { server, repo } = makeServer();
    const response = await server.run({
      command: "poll_timeline",
      aggregation: "day",
    } as FailuresStreamSocketRequest);

    expect(response.success).toBe(true);
    expect(repo.lastTimelineQuery?.aggregation).toBe("day");
  });

  test("acknowledge rejects a non-integer id before touching the repository", async () => {
    const { server, repo } = makeServer();
    const request = {
      command: "acknowledge",
      notificationIds: [1, 2.5],
    } as unknown as FailuresStreamSocketRequest;

    await expect(server.run(request)).rejects.toThrow(/Invalid notification ID/);
    expect(repo.acknowledgedIds).toBeUndefined();
  });

  test("acknowledge forwards a valid id list and reports the count", async () => {
    const { server, repo } = makeServer();
    const response = await server.run({
      command: "acknowledge",
      notificationIds: [7, 8],
    } as FailuresStreamSocketRequest);

    expect(response).toEqual({ success: true, acknowledgedCount: 2 });
    expect(repo.acknowledgedIds).toEqual([7, 8]);
  });

  test("an unsupported command is rejected", async () => {
    const { server } = makeServer();
    const request = { command: "poll_everything" } as unknown as FailuresStreamSocketRequest;

    await expect(server.run(request)).rejects.toThrow(/Unsupported command: poll_everything/);
  });
});

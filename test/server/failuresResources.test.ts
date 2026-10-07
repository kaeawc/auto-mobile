import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { registerFailuresResources } from "../../src/server/failuresResources";
import type { FailureAnalyticsRepository } from "../../src/db/failureAnalyticsRepository";
import { FakeTimer } from "../fakes/FakeTimer";

type TimelineQuery = Parameters<FailureAnalyticsRepository["getTimelineData"]>[0];

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// A typed fake exposing exactly the two queries the resources issue; it records
// every timeline query so tests can assert the repository was (not) called.
class FakeFailuresRepository {
  timelineQueries: TimelineQuery[] = [];

  async getFailureGroups(): ReturnType<FailureAnalyticsRepository["getFailureGroups"]> {
    return [];
  }

  async getTimelineData(
    query: TimelineQuery,
  ): ReturnType<FailureAnalyticsRepository["getTimelineData"]> {
    this.timelineQueries.push(query);
    return {
      dataPoints: [{ label: "Oct 5", crashes: 1, anrs: 0, toolFailures: 0, nonfatals: 0 }],
      previousPeriodTotals: { crashes: 2, anrs: 0, toolFailures: 0, nonfatals: 0 },
    };
  }
}

describe("failures timeline resource (#10119)", () => {
  let repository: FakeFailuresRepository;

  beforeEach(() => {
    const timer = new FakeTimer();
    timer.setCurrentTime(NOW);
    repository = new FakeFailuresRepository();
    registerFailuresResources(repository, timer);
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
  });

  async function read(uri: string): Promise<Record<string, unknown>> {
    const match = ResourceRegistry.matchTemplate(uri);
    if (!match || !("handler" in match.template)) {
      throw new Error(`No template matched ${uri}`);
    }
    const content = await match.template.handler(match.params);
    return JSON.parse(content.text ?? "{}") as Record<string, unknown>;
  }

  test.each([
    ["the bare URI", "automobile:failures/timeline", "24h", "hour", DAY],
    ["dateRange alone", "automobile:failures/timeline?dateRange=7d", "7d", "hour", 7 * DAY],
    ["aggregation alone", "automobile:failures/timeline?aggregation=day", "24h", "day", DAY],
    [
      "the documented parameter order",
      "automobile:failures/timeline?dateRange=3d&aggregation=minute",
      "3d",
      "minute",
      3 * DAY,
    ],
    [
      "reordered parameters",
      "automobile:failures/timeline?aggregation=week&dateRange=30d",
      "30d",
      "week",
      30 * DAY,
    ],
  ])(
    "%s resolves with defaults and queries the requested window",
    async (_name, uri, dateRange, aggregation, duration) => {
      const body = await read(uri);

      expect(body.dateRange).toBe(dateRange);
      expect(body.aggregation).toBe(aggregation);
      expect(repository.timelineQueries).toEqual([
        { startTime: NOW - duration, endTime: NOW, aggregation },
      ]);
    },
  );

  test("an unknown dateRange returns an error naming the allowed values without querying", async () => {
    for (const dateRange of ["90d", "2h", "1w", "7D", ""]) {
      const body = await read(
        `automobile:failures/timeline?dateRange=${dateRange}&aggregation=day`,
      );
      expect(body.error).toBe(
        `Invalid dateRange: ${dateRange}. Must be one of: 1h, 24h, 3d, 7d, 30d`,
      );
      expect(body.dataPoints).toBeUndefined();
    }
    expect(repository.timelineQueries).toEqual([]);
  });

  test("an unknown aggregation returns an error naming the allowed values without querying", async () => {
    const body = await read("automobile:failures/timeline?dateRange=7d&aggregation=month");

    expect(body.error).toBe("Invalid aggregation: month. Must be one of: minute, hour, day, week");
    expect(repository.timelineQueries).toEqual([]);
  });

  test("an unknown query key is rejected rather than ignored", async () => {
    const body = await read("automobile:failures/timeline?dateRange=7d&aggregaton=day");

    expect(String(body.error)).toContain("Unknown query parameters: aggregaton");
    expect(repository.timelineQueries).toEqual([]);
  });

  test("the response echoes the validated values and previous-period totals", async () => {
    const body = await read("automobile:failures/timeline?aggregation=day&dateRange=7d");

    expect(body).toEqual({
      dataPoints: [{ label: "Oct 5", crashes: 1, anrs: 0, toolFailures: 0, nonfatals: 0 }],
      dateRange: "7d",
      aggregation: "day",
      previousPeriodTotals: { crashes: 2, anrs: 0, toolFailures: 0, nonfatals: 0 },
    });
  });

  test("the base failures resource is not shadowed by the timeline template", () => {
    expect(ResourceRegistry.getResource("automobile:failures")).toBeDefined();
    expect(ResourceRegistry.matchTemplate("automobile:failures")).toBeUndefined();
  });
});

import type { FailureAnalyticsRepository } from "../../src/db/failureAnalyticsRepository";

/** The two analytics queries the failures MCP resources issue. */
export type FailureResourcesRepository = Pick<
  FailureAnalyticsRepository,
  "getFailureGroups" | "getTimelineData"
>;

export type FailureTimelineQuery = Parameters<FailureAnalyticsRepository["getTimelineData"]>[0];
type TimelineResult = Awaited<ReturnType<FailureAnalyticsRepository["getTimelineData"]>>;

const emptyTimeline = (): TimelineResult => ({
  dataPoints: [],
  previousPeriodTotals: { crashes: 0, anrs: 0, toolFailures: 0, nonfatals: 0 },
});

/**
 * Typed fake exposing exactly the two queries the failures resources issue. It
 * records every timeline query so tests can assert the repository was (not)
 * called, returns `timelineResult`, and throws `failure` when one is set.
 */
export class FakeFailureAnalyticsRepository implements FailureResourcesRepository {
  timelineQueries: FailureTimelineQuery[] = [];
  failure: Error | undefined;

  constructor(private readonly timelineResult: TimelineResult = emptyTimeline()) {}

  async getFailureGroups(): ReturnType<FailureAnalyticsRepository["getFailureGroups"]> {
    return [];
  }

  async getTimelineData(
    query: FailureTimelineQuery,
  ): ReturnType<FailureAnalyticsRepository["getTimelineData"]> {
    this.timelineQueries.push(query);
    if (this.failure) {
      throw this.failure;
    }
    return structuredClone(this.timelineResult);
  }
}

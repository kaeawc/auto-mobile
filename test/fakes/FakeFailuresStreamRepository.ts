import type { FailuresStreamRepository } from "../../src/daemon/failuresStreamSocketServer";

type NotificationsQuery = Parameters<FailuresStreamRepository["getNotificationsSince"]>[0];
type GroupsQuery = Parameters<FailuresStreamRepository["getAggregatedGroups"]>[0];
type TimelineQuery = Parameters<FailuresStreamRepository["getTimelineData"]>[0];

/**
 * Empty-result failures repository for the failures stream socket server. It
 * records the last query of each kind and the acknowledged notification ids.
 */
export class FakeFailuresStreamRepository implements FailuresStreamRepository {
  lastNotificationsQuery?: NotificationsQuery;
  lastGroupsQuery?: GroupsQuery;
  lastTimelineQuery?: TimelineQuery;
  acknowledgedIds?: number[];

  async getNotificationsSince(
    query: NotificationsQuery,
  ): ReturnType<FailuresStreamRepository["getNotificationsSince"]> {
    this.lastNotificationsQuery = query;
    return { notifications: [], lastTimestamp: undefined, lastId: undefined };
  }

  async getAggregatedGroups(
    query: GroupsQuery,
  ): ReturnType<FailuresStreamRepository["getAggregatedGroups"]> {
    this.lastGroupsQuery = query;
    return { groups: [], totals: { crashes: 0, anrs: 0, toolFailures: 0 } };
  }

  async getTimelineData(
    query: TimelineQuery,
  ): ReturnType<FailuresStreamRepository["getTimelineData"]> {
    this.lastTimelineQuery = query;
    return { dataPoints: [], previousPeriodTotals: undefined as never };
  }

  async acknowledgeNotifications(ids: number[]): Promise<void> {
    this.acknowledgedIds = ids;
  }
}

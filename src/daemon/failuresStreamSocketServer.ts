import { Timer, defaultTimer } from "../utils/SystemTimer";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import { FailureAnalyticsRepository } from "../db/failureAnalyticsRepository";
import type {
  FailuresStreamSocketRequest,
  FailuresStreamSocketResponse,
} from "./failuresStreamSocketTypes";
import { FAILURES_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import {
  getDateRangeDurationMs as getDateRangeDuration,
  normalizeAggregation,
  normalizeDateRange,
  normalizeStreamLimit,
  normalizeStreamSinceId,
  normalizeStreamTimestampMs,
} from "./streamQueryNormalizers";

const DEFAULT_LIMIT = 100;
const failureAnalyticsRepository = new FailureAnalyticsRepository();

/**
 * Narrow view of {@link FailureAnalyticsRepository} — exactly the four query
 * methods the handlers call. Injected via the constructor so tests can exercise
 * the request handlers with a fake and never resolve the real file-backed
 * database (issue #3067).
 */
export type FailuresStreamRepository = Pick<
  FailureAnalyticsRepository,
  "getNotificationsSince" | "getAggregatedGroups" | "getTimelineData" | "acknowledgeNotifications"
>;

/**
 * Socket server for failures stream.
 * Handles poll_notifications, poll_groups, poll_timeline, and acknowledge commands.
 */
export class FailuresStreamSocketServer extends RequestResponseSocketServer<
  FailuresStreamSocketRequest,
  FailuresStreamSocketResponse
> {
  private readonly repository: FailuresStreamRepository;

  constructor(
    socketPath: string = getSocketPath(FAILURES_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    repository: FailuresStreamRepository = failureAnalyticsRepository,
  ) {
    super(socketPath, timer, "FailuresStream");
    this.repository = repository;
  }

  protected async handleRequest(
    request: FailuresStreamSocketRequest,
  ): Promise<FailuresStreamSocketResponse> {
    switch (request.command) {
      case "poll_notifications":
        return await this.handlePollNotifications(request);
      case "poll_groups":
        return await this.handlePollGroups(request);
      case "poll_timeline":
        return await this.handlePollTimeline(request);
      case "acknowledge":
        return await this.handleAcknowledge(request);
      default:
        throw new Error(`Unsupported command: ${String(request.command)}`);
    }
  }

  protected createErrorResponse(
    _id: string | undefined,
    error: string,
  ): FailuresStreamSocketResponse {
    return {
      success: false,
      error,
    };
  }

  private async handlePollNotifications(
    request: FailuresStreamSocketRequest,
  ): Promise<FailuresStreamSocketResponse> {
    const sinceTimestamp = normalizeStreamTimestampMs(request.sinceTimestamp, "sinceTimestamp");
    const sinceId = normalizeStreamSinceId(request.sinceId);
    const limit = normalizeStreamLimit(request.limit, DEFAULT_LIMIT);

    // Calculate time range if dateRange is provided
    let startTime = normalizeStreamTimestampMs(request.startTime, "startTime");
    let endTime = normalizeStreamTimestampMs(request.endTime, "endTime");

    const dateRange = normalizeDateRange(request.dateRange);
    if (dateRange && !startTime) {
      const now = this.timer.now();
      endTime = endTime ?? now;
      startTime = endTime - getDateRangeDuration(dateRange);
    }

    const result = await this.repository.getNotificationsSince({
      sinceTimestamp,
      sinceId,
      startTime,
      endTime,
      limit,
      type: request.type,
      acknowledged: request.acknowledged,
    });

    return {
      success: true,
      notifications: result.notifications,
      lastTimestamp: result.lastTimestamp,
      lastId: result.lastId,
    };
  }

  private async handlePollGroups(
    request: FailuresStreamSocketRequest,
  ): Promise<FailuresStreamSocketResponse> {
    // Calculate time range if dateRange is provided
    let startTime = normalizeStreamTimestampMs(request.startTime, "startTime");
    let endTime = normalizeStreamTimestampMs(request.endTime, "endTime");

    const dateRange = normalizeDateRange(request.dateRange);
    if (dateRange && !startTime) {
      const now = this.timer.now();
      endTime = endTime ?? now;
      startTime = endTime - getDateRangeDuration(dateRange);
    }

    const result = await this.repository.getAggregatedGroups({
      startTime,
      endTime,
      type: request.type,
      severity: request.severity,
    });

    return {
      success: true,
      groups: result.groups,
      totals: result.totals,
    };
  }

  private async handlePollTimeline(
    request: FailuresStreamSocketRequest,
  ): Promise<FailuresStreamSocketResponse> {
    const aggregation = normalizeAggregation(request.aggregation);

    // Calculate time range
    let startTime = normalizeStreamTimestampMs(request.startTime, "startTime");
    let endTime = normalizeStreamTimestampMs(request.endTime, "endTime");

    const dateRange = normalizeDateRange(request.dateRange);
    const now = this.timer.now();

    if (dateRange) {
      endTime = endTime ?? now;
      startTime = endTime - getDateRangeDuration(dateRange);
    } else {
      // Default to 24h if no range specified
      endTime = endTime ?? now;
      startTime = startTime ?? endTime - 24 * 60 * 60 * 1000;
    }

    const result = await this.repository.getTimelineData({
      startTime,
      endTime,
      aggregation,
    });

    return {
      success: true,
      dataPoints: result.dataPoints,
      previousPeriodTotals: result.previousPeriodTotals,
    };
  }

  private async handleAcknowledge(
    request: FailuresStreamSocketRequest,
  ): Promise<FailuresStreamSocketResponse> {
    const ids = request.notificationIds;
    if (!ids || !Array.isArray(ids)) {
      throw new Error("notificationIds is required for acknowledge command");
    }

    // Validate all IDs are numbers
    for (const id of ids) {
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
        throw new Error(`Invalid notification ID: ${String(id)}`);
      }
    }

    await this.repository.acknowledgeNotifications(ids);

    return {
      success: true,
      acknowledgedCount: ids.length,
    };
  }
}

let socketServer: FailuresStreamSocketServer | null = null;

export function getFailuresStreamSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(FAILURES_STREAM_SOCKET_CONFIG);
}

export async function startFailuresStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    socketServer = new FailuresStreamSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
}

export async function stopFailuresStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}

import type {
  AggregatedToolCallInfo,
  FailureSeverity,
  FailureType,
  ScreenBreakdown,
  StackTraceElement,
} from "../models/failureAnalytics";

export interface FailureScreenCountRow {
  screenName: string;
  failureCount: number;
}

export interface VisitScreenCountRow {
  screenName: string;
  visitCount: number;
}

export function mergeScreenBreakdownRows(
  failureScreens: readonly FailureScreenCountRow[],
  visitedScreens: readonly VisitScreenCountRow[],
): ScreenBreakdown[] {
  const visitMap = new Map(visitedScreens.map((screen) => [screen.screenName, screen.visitCount]));
  const totalVisits = visitedScreens.reduce((sum, screen) => sum + screen.visitCount, 0);

  const result: ScreenBreakdown[] = [];
  const processedScreens = new Set<string>();

  for (const row of failureScreens) {
    const visitCount = visitMap.get(row.screenName) ?? 0;
    result.push({
      screenName: row.screenName,
      visitCount,
      failureCount: row.failureCount,
      visitPercentage: totalVisits > 0 ? (visitCount / totalVisits) * 100 : 0,
    });
    processedScreens.add(row.screenName);
  }

  const visitOnlyScreens = visitedScreens
    .filter((screen) => !processedScreens.has(screen.screenName))
    .sort((a, b) => b.visitCount - a.visitCount || a.screenName.localeCompare(b.screenName))
    .slice(0, 5);

  for (const screen of visitOnlyScreens) {
    result.push({
      screenName: screen.screenName,
      visitCount: screen.visitCount,
      failureCount: 0,
      visitPercentage: totalVisits > 0 ? (screen.visitCount / totalVisits) * 100 : 0,
    });
  }

  return result
    .map((screen, index) => ({ screen, index }))
    .sort((a, b) => b.screen.visitCount - a.screen.visitCount || a.index - b.index)
    .map(({ screen }) => screen);
}

// Types for recording failures

export interface RecordFailureInput {
  type: FailureType;
  signature: string;
  title: string;
  message: string;
  severity: FailureSeverity;
  stackTrace?: StackTraceElement[];
  toolCallInfo?: AggregatedToolCallInfo;
  occurrence: {
    deviceId?: string;
    deviceModel: string;
    os: string;
    appVersion: string;
    sessionId: string;
    screenAtFailure?: string;
    screensVisited?: string[];
    testName?: string;
    testExecutionId?: number;
    errorCode?: string;
    durationMs?: number;
    toolArgs?: Record<string, unknown>;
  };
  capture?: {
    type: "screenshot" | "video";
    path: string;
  };
}

// Types for querying failures

export interface FailuresQuery {
  type?: FailureType;
  severity?: FailureSeverity;
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

export interface TimelineQuery {
  startTime: number;
  endTime: number;
  aggregation: "minute" | "hour" | "day" | "week";
}

export interface FailuresStreamQuery {
  sinceTimestamp?: number;
  sinceId?: number;
  startTime?: number;
  endTime?: number;
  limit?: number;
  type?: FailureType;
  severity?: FailureSeverity;
  acknowledged?: boolean;
}

export interface FailureNotificationEntry {
  id: number;
  occurrenceId: string;
  groupId: string;
  type: FailureType;
  severity: FailureSeverity;
  title: string;
  timestamp: number;
  acknowledged: boolean;
}

export interface FailuresStreamResponse {
  notifications: FailureNotificationEntry[];
  lastTimestamp?: number;
  lastId?: number;
}

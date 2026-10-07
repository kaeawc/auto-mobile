import { ResourceRegistry, ResourceContent, getRequestedResourceUri } from "./resourceRegistry";
import { logger } from "../utils/logger";
import { FailureAnalyticsRepository } from "../db/failureAnalyticsRepository";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { errorMessage } from "../utils/describeUnknownError";
import type { DateRangePreset, TimeAggregation } from "../daemon/failuresStreamSocketTypes";
import {
  getDateRangeDurationMs,
  normalizeAggregation,
  normalizeDateRange,
} from "../daemon/streamQueryNormalizers";

const FAILURES_RESOURCE_URIS = {
  BASE: "automobile:failures",
  TIMELINE: "automobile:failures/timeline",
} as const;

const failureAnalyticsRepository = new FailureAnalyticsRepository();

// Type definitions matching IDE plugin models

export type FailureType = "crash" | "anr" | "tool_failure" | "nonfatal";
export type FailureSeverity = "critical" | "high" | "medium" | "low";
type CaptureType = "screenshot" | "video";

export interface StackTraceElement {
  className: string;
  methodName: string;
  fileName: string | null;
  lineNumber: number | null;
  isAppCode: boolean;
}

export interface DeviceBreakdown {
  deviceModel: string;
  os: string;
  count: number;
  percentage: number;
}

export interface VersionBreakdown {
  version: string;
  count: number;
  percentage: number;
}

export interface ScreenBreakdown {
  screenName: string;
  visitCount: number;
  failureCount: number;
  visitPercentage: number;
}

interface DurationStats {
  minMs: number;
  maxMs: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
}

export interface AggregatedToolCallInfo {
  toolName: string;
  errorCodes: Record<string, number>;
  parameterVariants: Record<string, string[]>;
  durationStats: DurationStats | null;
}

export interface FailureCapture {
  id: string;
  type: CaptureType;
  path: string;
  timestamp: number;
  deviceModel: string;
}

export interface FailureOccurrence {
  id: string;
  timestamp: number;
  deviceModel: string;
  os: string;
  appVersion: string;
  sessionId: string;
  screenAtFailure: string | null;
  screensVisited: string[];
  testName: string | null;
  capturePath: string | null;
  captureType: CaptureType | null;
}

export interface FailureGroup {
  id: string;
  type: FailureType;
  signature: string;
  title: string;
  message: string;
  firstOccurrence: number;
  lastOccurrence: number;
  totalCount: number;
  uniqueSessions: number;
  severity: FailureSeverity;
  deviceBreakdown: DeviceBreakdown[];
  versionBreakdown: VersionBreakdown[];
  screenBreakdown: ScreenBreakdown[];
  failureScreens: Record<string, number>;
  stackTraceElements: StackTraceElement[];
  toolCallInfo: AggregatedToolCallInfo | null;
  affectedTests: Record<string, number>;
  recentCaptures: FailureCapture[];
  sampleOccurrences: FailureOccurrence[];
}

interface FailuresResponse {
  groups: FailureGroup[];
  generatedAt: string;
}

export interface TimelineDataPoint {
  label: string;
  crashes: number;
  anrs: number;
  toolFailures: number;
  nonfatals: number;
}

export interface PeriodTotals {
  crashes: number;
  anrs: number;
  toolFailures: number;
  nonfatals: number;
}

interface TimelineResponse {
  dataPoints: TimelineDataPoint[];
  dateRange: string;
  aggregation: string;
  previousPeriodTotals: PeriodTotals;
}

async function getFailuresResource(
  uri: string,
  repository: FailuresResourceRepository,
): Promise<ResourceContent> {
  try {
    const groups = await repository.getFailureGroups();

    const response: FailuresResponse = {
      groups,
      generatedAt: new Date().toISOString(),
    };

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(response, null, 2),
    };
  } catch (error) {
    logger.error(`[FailuresResources] Failed to get failures: ${error}`);
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to retrieve failures: ${error}` }, null, 2),
    };
  }
}

/** Narrow view of the repository: only the queries these resources issue. */
type FailuresResourceRepository = Pick<
  FailureAnalyticsRepository,
  "getFailureGroups" | "getTimelineData"
>;

const TIMELINE_QUERY_KEYS = ["dateRange", "aggregation"] as const;
// RFC 6570 `{?...}` makes both parameters optional and order-independent, so the
// bare URI, either parameter alone, and `aggregation=...&dateRange=...` all match
// (the ordered `?dateRange={dateRange}&aggregation={aggregation}` form required
// both, in that order — #10119, same shape as #6133).
const TIMELINE_QUERY_TEMPLATE = `${FAILURES_RESOURCE_URIS.TIMELINE}{?${TIMELINE_QUERY_KEYS.join(",")}}`;
const TIMELINE_QUERY_PARAM_KEYS = new Set<string>(TIMELINE_QUERY_KEYS);
const DEFAULT_TIMELINE_DATE_RANGE: DateRangePreset = "24h";

function parseTimelineParams(params: Record<string, string>): {
  dateRange: DateRangePreset;
  aggregation: TimeAggregation;
} {
  const unknownKeys = Object.keys(params).filter((key) => !TIMELINE_QUERY_PARAM_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Unknown query parameters: ${unknownKeys.join(", ")}. Supported: ${TIMELINE_QUERY_KEYS.join(", ")}`,
    );
  }
  // The same validators the `poll_timeline` socket route uses; an absent value
  // takes the documented default, an unknown one is an error rather than a
  // silent fallback to a different range.
  return {
    dateRange: normalizeDateRange(params.dateRange) ?? DEFAULT_TIMELINE_DATE_RANGE,
    aggregation: normalizeAggregation(params.aggregation),
  };
}

function errorContent(uri: string, message: string): ResourceContent {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify({ error: message }, null, 2),
  };
}

async function getTimelineResource(
  params: Record<string, string>,
  repository: FailuresResourceRepository,
  timer: Timer,
): Promise<ResourceContent> {
  let query: ReturnType<typeof parseTimelineParams>;
  try {
    query = parseTimelineParams(params);
  } catch (error) {
    logger.warn(`[FailuresResources] Invalid timeline query: ${errorMessage(error)}`);
    return errorContent(
      getRequestedResourceUri(params) ?? FAILURES_RESOURCE_URIS.TIMELINE,
      errorMessage(error),
    );
  }

  try {
    const { dateRange, aggregation } = query;
    const endTime = timer.now();
    const startTime = endTime - getDateRangeDurationMs(dateRange);

    const result = await repository.getTimelineData({ startTime, endTime, aggregation });

    const response: TimelineResponse = {
      dataPoints: result.dataPoints,
      dateRange,
      aggregation,
      previousPeriodTotals: result.previousPeriodTotals,
    };

    return {
      uri: `${FAILURES_RESOURCE_URIS.TIMELINE}?dateRange=${dateRange}&aggregation=${aggregation}`,
      mimeType: "application/json",
      text: JSON.stringify(response, null, 2),
    };
  } catch (error) {
    logger.error(`[FailuresResources] Failed to get timeline: ${error}`);
    return errorContent(FAILURES_RESOURCE_URIS.TIMELINE, `Failed to retrieve timeline: ${error}`);
  }
}

export function registerFailuresResources(
  repository: FailuresResourceRepository = failureAnalyticsRepository,
  timer: Timer = defaultTimer,
): void {
  // Register base failures resource
  ResourceRegistry.register(
    FAILURES_RESOURCE_URIS.BASE,
    "Failures",
    "List all failure groups (crashes, ANRs, tool failures) with aggregated data.",
    "application/json",
    () => getFailuresResource(FAILURES_RESOURCE_URIS.BASE, repository),
  );

  // Register timeline resource template
  ResourceRegistry.registerTemplate(
    TIMELINE_QUERY_TEMPLATE,
    "Failures Timeline",
    "Get timeline data for failures. Optional dateRange (1h, 24h, 3d, 7d, 30d; default 24h) and aggregation (minute, hour, day, week; default hour). Buckets and labels are UTC; weeks start Monday 00:00 UTC.",
    "application/json",
    (params) => getTimelineResource(params, repository, timer),
  );

  logger.info("[FailuresResources] Registered failures resources");
}

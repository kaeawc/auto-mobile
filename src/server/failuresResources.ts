import { ResourceRegistry, ResourceContent } from "./resourceRegistry";
import { logger } from "../utils/logger";

export const FAILURES_RESOURCE_URIS = {
  BASE: "automobile:failures",
  TIMELINE: "automobile:failures/timeline",
} as const;

// Type definitions matching IDE plugin models

export type FailureType = "crash" | "anr" | "tool_failure";
export type FailureSeverity = "critical" | "high" | "medium" | "low";
export type CaptureType = "screenshot" | "video";

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

export interface DurationStats {
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

export interface FailuresResponse {
  groups: FailureGroup[];
  generatedAt: string;
}

export interface TimelineDataPoint {
  label: string;
  crashes: number;
  anrs: number;
  toolFailures: number;
}

export interface PeriodTotals {
  crashes: number;
  anrs: number;
  toolFailures: number;
}

export interface TimelineResponse {
  dataPoints: TimelineDataPoint[];
  dateRange: string;
  aggregation: string;
  previousPeriodTotals: PeriodTotals;
}

// Date range durations in milliseconds
const DATE_RANGES: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "3d": 3 * 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

// Aggregation durations in milliseconds
const AGGREGATIONS: Record<string, number> = {
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

const MAX_DISPLAYABLE_BUCKETS = 100;

// Seeded random number generator for consistent mock data
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

function createMockFailureGroups(): FailureGroup[] {
  const now = Date.now();

  return [
    {
      id: "crash-1",
      type: "crash",
      signature: "NullPointerException at LoginViewModel.kt:42",
      title: "NullPointerException in LoginViewModel",
      message: "java.lang.NullPointerException: Attempt to invoke virtual method 'String com.example.User.getName()' on a null object reference",
      firstOccurrence: now - 86400000 * 3,
      lastOccurrence: now - 3600000,
      totalCount: 23,
      uniqueSessions: 18,
      severity: "critical",
      deviceBreakdown: [
        { deviceModel: "Pixel 8", os: "Android 15", count: 9, percentage: 39 },
        { deviceModel: "Pixel 7", os: "Android 14", count: 6, percentage: 26 },
        { deviceModel: "Samsung S24", os: "Android 14", count: 5, percentage: 22 },
        { deviceModel: "OnePlus 12", os: "Android 14", count: 3, percentage: 13 },
      ],
      versionBreakdown: [
        { version: "2.4.1-debug", count: 15, percentage: 65 },
        { version: "2.4.0", count: 6, percentage: 26 },
        { version: "2.3.9", count: 2, percentage: 9 },
      ],
      screenBreakdown: [
        { screenName: "Splash", visitCount: 23, failureCount: 0, visitPercentage: 100 },
        { screenName: "Login", visitCount: 23, failureCount: 23, visitPercentage: 100 },
      ],
      failureScreens: { Login: 23 },
      stackTraceElements: [
        { className: "com.example.app.LoginViewModel", methodName: "validateUser", fileName: "LoginViewModel.kt", lineNumber: 42, isAppCode: true },
        { className: "com.example.app.LoginViewModel", methodName: "onLoginClicked", fileName: "LoginViewModel.kt", lineNumber: 28, isAppCode: true },
        { className: "com.example.app.LoginFragment", methodName: "onClick", fileName: "LoginFragment.kt", lineNumber: 67, isAppCode: true },
        { className: "android.view.View", methodName: "performClick", fileName: "View.java", lineNumber: 7448, isAppCode: false },
      ],
      toolCallInfo: null,
      affectedTests: { testLoginFlow: 15, testSignupValidation: 8 },
      recentCaptures: [
        { id: "cap-1", type: "screenshot", path: "/captures/crash-1/1.png", timestamp: now - 3600000, deviceModel: "Pixel 8" },
        { id: "cap-2", type: "screenshot", path: "/captures/crash-1/2.png", timestamp: now - 7200000, deviceModel: "Samsung S24" },
        { id: "cap-3", type: "video", path: "/captures/crash-1/3.mp4", timestamp: now - 10800000, deviceModel: "Pixel 7" },
      ],
      sampleOccurrences: [
        { id: "occ-1", timestamp: now - 3600000, deviceModel: "Pixel 8", os: "Android 15", appVersion: "2.4.1-debug", sessionId: "session-1", screenAtFailure: "Login", screensVisited: ["Splash", "Login"], testName: "testLoginFlow", capturePath: "/captures/crash-1/1.png", captureType: "screenshot" },
        { id: "occ-2", timestamp: now - 7200000, deviceModel: "Samsung S24", os: "Android 14", appVersion: "2.4.1-debug", sessionId: "session-2", screenAtFailure: "Login", screensVisited: ["Splash", "Login"], testName: "testLoginFlow", capturePath: "/captures/crash-1/2.png", captureType: "screenshot" },
        { id: "occ-3", timestamp: now - 10800000, deviceModel: "Pixel 7", os: "Android 14", appVersion: "2.4.0", sessionId: "session-3", screenAtFailure: "Login", screensVisited: ["Splash", "Login"], testName: "testSignupValidation", capturePath: "/captures/crash-1/3.mp4", captureType: "video" },
      ],
    },
    {
      id: "anr-1",
      type: "anr",
      signature: "ANR in HomeFragment.onResume",
      title: "ANR: Main thread blocked during DB query",
      message: "Application Not Responding: Main thread blocked for 5+ seconds during database query",
      firstOccurrence: now - 86400000 * 2,
      lastOccurrence: now - 7200000,
      totalCount: 8,
      uniqueSessions: 7,
      severity: "high",
      deviceBreakdown: [
        { deviceModel: "Pixel 7", os: "Android 14", count: 4, percentage: 50 },
        { deviceModel: "Pixel 6", os: "Android 13", count: 3, percentage: 37 },
        { deviceModel: "Samsung A54", os: "Android 13", count: 1, percentage: 13 },
      ],
      versionBreakdown: [
        { version: "2.4.1-debug", count: 6, percentage: 75 },
        { version: "2.4.0", count: 2, percentage: 25 },
      ],
      screenBreakdown: [
        { screenName: "Splash", visitCount: 8, failureCount: 0, visitPercentage: 100 },
        { screenName: "Login", visitCount: 8, failureCount: 0, visitPercentage: 100 },
        { screenName: "Home", visitCount: 8, failureCount: 8, visitPercentage: 100 },
      ],
      failureScreens: { Home: 8 },
      stackTraceElements: [
        { className: "com.example.app.data.UserDao", methodName: "getAllUsers", fileName: "UserDao.kt", lineNumber: 23, isAppCode: true },
        { className: "com.example.app.HomeViewModel", methodName: "loadUsers", fileName: "HomeViewModel.kt", lineNumber: 45, isAppCode: true },
        { className: "com.example.app.HomeFragment", methodName: "onResume", fileName: "HomeFragment.kt", lineNumber: 31, isAppCode: true },
        { className: "androidx.fragment.app.Fragment", methodName: "performResume", fileName: "Fragment.java", lineNumber: 3135, isAppCode: false },
      ],
      toolCallInfo: null,
      affectedTests: { testHomeLoad: 5, testProfileEdit: 3 },
      recentCaptures: [
        { id: "cap-4", type: "video", path: "/captures/anr-1/1.mp4", timestamp: now - 7200000, deviceModel: "Pixel 7" },
        { id: "cap-5", type: "video", path: "/captures/anr-1/2.mp4", timestamp: now - 14400000, deviceModel: "Pixel 6" },
      ],
      sampleOccurrences: [
        { id: "occ-7", timestamp: now - 7200000, deviceModel: "Pixel 7", os: "Android 14", appVersion: "2.4.1-debug", sessionId: "session-7", screenAtFailure: "Home", screensVisited: ["Splash", "Login", "Home"], testName: "testHomeLoad", capturePath: "/captures/anr-1/1.mp4", captureType: "video" },
        { id: "occ-8", timestamp: now - 14400000, deviceModel: "Pixel 6", os: "Android 13", appVersion: "2.4.1-debug", sessionId: "session-8", screenAtFailure: "Home", screensVisited: ["Splash", "Login", "Home"], testName: "testProfileEdit", capturePath: "/captures/anr-1/2.mp4", captureType: "video" },
      ],
    },
    {
      id: "tool-1",
      type: "tool_failure",
      signature: "tapOn failed: Element not found",
      title: "tapOn: Element not found",
      message: "Element with text not found within timeout. Check element visibility and timing.",
      firstOccurrence: now - 86400000,
      lastOccurrence: now - 1800000,
      totalCount: 12,
      uniqueSessions: 10,
      severity: "medium",
      deviceBreakdown: [
        { deviceModel: "iPhone 15 Pro", os: "iOS 17.2", count: 5, percentage: 42 },
        { deviceModel: "iPhone 14", os: "iOS 17.1", count: 4, percentage: 33 },
        { deviceModel: "Pixel 8", os: "Android 15", count: 3, percentage: 25 },
      ],
      versionBreakdown: [
        { version: "2.4.0", count: 8, percentage: 67 },
        { version: "2.4.1-debug", count: 4, percentage: 33 },
      ],
      screenBreakdown: [
        { screenName: "Home", visitCount: 12, failureCount: 0, visitPercentage: 100 },
        { screenName: "Cart", visitCount: 12, failureCount: 0, visitPercentage: 100 },
        { screenName: "Checkout", visitCount: 12, failureCount: 12, visitPercentage: 100 },
      ],
      failureScreens: { Checkout: 12 },
      stackTraceElements: [],
      toolCallInfo: {
        toolName: "tapOn",
        errorCodes: { ELEMENT_NOT_FOUND: 10, TIMEOUT: 2 },
        parameterVariants: {
          text: ["Submit", "Complete Order", "Place Order"],
          timeout: ["5000", "10000"],
        },
        durationStats: {
          minMs: 5001,
          maxMs: 10234,
          avgMs: 6543,
          medianMs: 5500,
          p95Ms: 9800,
        },
      },
      affectedTests: { testFormSubmission: 7, testCheckout: 5 },
      recentCaptures: [
        { id: "cap-6", type: "screenshot", path: "/captures/tool-1/1.png", timestamp: now - 1800000, deviceModel: "iPhone 15 Pro" },
        { id: "cap-7", type: "screenshot", path: "/captures/tool-1/2.png", timestamp: now - 3600000, deviceModel: "Pixel 8" },
        { id: "cap-8", type: "screenshot", path: "/captures/tool-1/3.png", timestamp: now - 7200000, deviceModel: "iPhone 14" },
      ],
      sampleOccurrences: [
        { id: "occ-10", timestamp: now - 1800000, deviceModel: "iPhone 15 Pro", os: "iOS 17.2", appVersion: "2.4.0", sessionId: "session-10", screenAtFailure: "Checkout", screensVisited: ["Home", "Cart", "Checkout"], testName: "testCheckout", capturePath: "/captures/tool-1/1.png", captureType: "screenshot" },
        { id: "occ-11", timestamp: now - 3600000, deviceModel: "Pixel 8", os: "Android 15", appVersion: "2.4.1-debug", sessionId: "session-11", screenAtFailure: "Checkout", screensVisited: ["Home", "Cart", "Checkout"], testName: "testFormSubmission", capturePath: "/captures/tool-1/2.png", captureType: "screenshot" },
      ],
    },
    {
      id: "crash-2",
      type: "crash",
      signature: "IndexOutOfBoundsException at RecyclerView",
      title: "IndexOutOfBoundsException in MessageList",
      message: "java.lang.IndexOutOfBoundsException: Inconsistency detected. Invalid view holder adapter position",
      firstOccurrence: now - 86400000 * 5,
      lastOccurrence: now - 86400000,
      totalCount: 5,
      uniqueSessions: 5,
      severity: "low",
      deviceBreakdown: [
        { deviceModel: "Pixel 8", os: "Android 15", count: 3, percentage: 60 },
        { deviceModel: "Pixel 7", os: "Android 14", count: 2, percentage: 40 },
      ],
      versionBreakdown: [
        { version: "2.4.1-debug", count: 5, percentage: 100 },
      ],
      screenBreakdown: [
        { screenName: "Home", visitCount: 5, failureCount: 0, visitPercentage: 100 },
        { screenName: "Messages", visitCount: 5, failureCount: 5, visitPercentage: 100 },
      ],
      failureScreens: { Messages: 5 },
      stackTraceElements: [
        { className: "androidx.recyclerview.widget.RecyclerView", methodName: "findViewHolderForPosition", fileName: "RecyclerView.java", lineNumber: 1345, isAppCode: false },
        { className: "com.example.app.MessageListAdapter", methodName: "onBindViewHolder", fileName: "MessageListAdapter.kt", lineNumber: 67, isAppCode: true },
      ],
      toolCallInfo: null,
      affectedTests: { testSendMessage: 5 },
      recentCaptures: [],
      sampleOccurrences: [
        { id: "occ-13", timestamp: now - 86400000, deviceModel: "Pixel 8", os: "Android 15", appVersion: "2.4.1-debug", sessionId: "session-13", screenAtFailure: "Messages", screensVisited: ["Home", "Messages"], testName: "testSendMessage", capturePath: null, captureType: null },
      ],
    },
  ];
}

function generateMockTimelineData(dateRange: string, aggregation: string): TimelineDataPoint[] {
  const rangeDurationMs = DATE_RANGES[dateRange] || DATE_RANGES["24h"];
  const aggDurationMs = AGGREGATIONS[aggregation] || AGGREGATIONS["hour"];

  const buckets = Math.min(Math.floor(rangeDurationMs / aggDurationMs), MAX_DISPLAYABLE_BUCKETS);
  const random = seededRandom(42);

  const now = Date.now();
  const dataPoints: TimelineDataPoint[] = [];

  for (let i = 0; i < buckets; i++) {
    const bucketIndex = buckets - 1 - i;
    const timeAgoMs = bucketIndex * aggDurationMs;
    const timestamp = now - timeAgoMs;

    const label = formatRelativeTimeLabel(timestamp, aggregation);

    // Generate realistic-looking failure data
    let baseCrashes: number;
    switch (aggregation) {
      case "minute":
        baseCrashes = Math.floor(random() * 5);
        break;
      case "hour":
        baseCrashes = 2 + Math.floor(random() * 13);
        break;
      case "day":
        baseCrashes = 10 + Math.floor(random() * 40);
        break;
      case "week":
        baseCrashes = 30 + Math.floor(random() * 120);
        break;
      default:
        baseCrashes = 5;
    }

    dataPoints.push({
      label,
      crashes: baseCrashes,
      anrs: Math.floor(baseCrashes / 3),
      toolFailures: Math.floor(baseCrashes / 2),
    });
  }

  return dataPoints;
}

function formatRelativeTimeLabel(timestamp: number, aggregation: string): string {
  const date = new Date(timestamp);

  switch (aggregation) {
    case "minute": {
      const hours = date.getHours();
      const minutes = date.getMinutes();
      const amPm = hours >= 12 ? "PM" : "AM";
      const displayHour = hours % 12 || 12;
      return `${displayHour}:${minutes.toString().padStart(2, "0")} ${amPm}`;
    }
    case "hour": {
      const hours = date.getHours();
      const amPm = hours >= 12 ? "PM" : "AM";
      const displayHour = hours % 12 || 12;
      return `${displayHour} ${amPm}`;
    }
    case "day": {
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${monthNames[date.getMonth()]} ${date.getDate()}`;
    }
    case "week": {
      // Get the Monday of the week
      const dayOfWeek = date.getDay();
      const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(timestamp);
      monday.setDate(date.getDate() + daysToMonday);
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return `${monthNames[monday.getMonth()]} ${monday.getDate()}`;
    }
    default:
      return date.toISOString();
  }
}

function generateMockPreviousPeriodTotals(dateRange: string): PeriodTotals {
  const dateRangeIndex = Object.keys(DATE_RANGES).indexOf(dateRange);
  const random = seededRandom(dateRangeIndex + 100);

  let baseCrashes: number;
  switch (dateRange) {
    case "1h":
      baseCrashes = 50 + Math.floor(random() * 100);
      break;
    case "24h":
      baseCrashes = 200 + Math.floor(random() * 400);
      break;
    case "3d":
      baseCrashes = 500 + Math.floor(random() * 1000);
      break;
    case "7d":
      baseCrashes = 1000 + Math.floor(random() * 2000);
      break;
    case "30d":
      baseCrashes = 3000 + Math.floor(random() * 5000);
      break;
    default:
      baseCrashes = 100;
  }

  return {
    crashes: baseCrashes,
    anrs: Math.floor(baseCrashes / 3),
    toolFailures: Math.floor(baseCrashes / 2),
  };
}

async function getFailuresResource(uri: string): Promise<ResourceContent> {
  try {
    const response: FailuresResponse = {
      groups: createMockFailureGroups(),
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

async function getTimelineResource(params: Record<string, string>): Promise<ResourceContent> {
  try {
    const dateRange = params.dateRange || "24h";
    const aggregation = params.aggregation || "hour";

    const response: TimelineResponse = {
      dataPoints: generateMockTimelineData(dateRange, aggregation),
      dateRange,
      aggregation,
      previousPeriodTotals: generateMockPreviousPeriodTotals(dateRange),
    };

    const uri = `${FAILURES_RESOURCE_URIS.TIMELINE}?dateRange=${dateRange}&aggregation=${aggregation}`;

    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(response, null, 2),
    };
  } catch (error) {
    logger.error(`[FailuresResources] Failed to get timeline: ${error}`);
    return {
      uri: FAILURES_RESOURCE_URIS.TIMELINE,
      mimeType: "application/json",
      text: JSON.stringify({ error: `Failed to retrieve timeline: ${error}` }, null, 2),
    };
  }
}

export function registerFailuresResources(): void {
  // Register base failures resource
  ResourceRegistry.register(
    FAILURES_RESOURCE_URIS.BASE,
    "Failures",
    "List all failure groups (crashes, ANRs, tool failures) with aggregated data.",
    "application/json",
    () => getFailuresResource(FAILURES_RESOURCE_URIS.BASE)
  );

  // Register timeline resource template
  ResourceRegistry.registerTemplate(
    `${FAILURES_RESOURCE_URIS.TIMELINE}?dateRange={dateRange}&aggregation={aggregation}`,
    "Failures Timeline",
    "Get timeline data for failures with configurable date range and aggregation.",
    "application/json",
    getTimelineResource
  );

  logger.info("[FailuresResources] Registered failures resources");
}

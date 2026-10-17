// Failure analytics shapes shared by the db tier and the failures MCP resources (#11789).

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

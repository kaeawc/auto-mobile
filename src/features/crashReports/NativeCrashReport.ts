import type { StackTraceElement } from "../../models/failureAnalytics";

/**
 * Structured crash report written by the OS on every crash (#14103): an `.ips`
 * file on iOS, a `dumpsys dropbox` entry on Android. Fields are bounded on
 * parse so a summary never carries a raw report.
 */
export interface NativeCrashReport {
  /** Stable per report: the `.ips` incident id, or `<tag>@<entry time>#<pid>` for dropbox. */
  id: string;
  platform: "ios" | "android";
  source: NativeCrashReportSource;
  appId: string;
  appVersion?: string;
  processId?: number;
  /** Epoch milliseconds the OS captured the crash, when the report states it unambiguously. */
  timestampMs?: number;
  /** `EXC_CRASH (SIGABRT)`, `java.lang.IllegalStateException`, `SIGABRT`. */
  exceptionType: string;
  /** Mach exception codes, or the native signal/code line. */
  exceptionCode?: string;
  exceptionMessage?: string;
  terminationReason?: string;
  /** Crashing-thread frames, innermost first, at most {@link NATIVE_CRASH_REPORT_MAX_FRAMES}. */
  frames: StackTraceElement[];
  /** Host file path for `.ips`, or the dropbox tag and entry time on Android. */
  reportPath: string;
  deviceModel?: string;
  osVersion?: string;
}

export type NativeCrashReportSource = "ios_ips" | "android_dropbox";

export const NATIVE_CRASH_REPORT_MAX_FRAMES = 16;
/** Longest string any summary field carries. */
export const NATIVE_CRASH_REPORT_MAX_FIELD_CHARS = 500;

/** What a crash-report lookup found for one query. */
export type NativeCrashReportLookup =
  | { status: "found"; report: NativeCrashReport }
  | { status: "notFound" }
  | { status: "unsupported"; reason: string };

export interface NativeCrashReportQuery {
  appId: string;
  /** When known, only a report for this exact process is attributed. */
  processId?: number;
  /** Epoch milliseconds (device clock); reports captured earlier are ignored. */
  notBeforeTimestampMs: number;
  signal?: AbortSignal;
}

export function boundedField(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > NATIVE_CRASH_REPORT_MAX_FIELD_CHARS
    ? `${trimmed.slice(0, NATIVE_CRASH_REPORT_MAX_FIELD_CHARS - 1)}…`
    : trimmed;
}

/** One-line frame text for tool output: `symbol (image file:line)`. */
export function describeFrame(frame: StackTraceElement): string {
  const location = [
    frame.className,
    frame.fileName && `${frame.fileName}:${frame.lineNumber ?? "?"}`,
  ]
    .filter(Boolean)
    .join(" ");
  return location ? `${frame.methodName} (${location})` : frame.methodName;
}

/** The full text of one report, as the OS wrote it. */
export interface NativeCrashReportBody {
  report: NativeCrashReport;
  text: string;
}

/**
 * Re-reads one report by id from its source on the same device (the host `.ips`
 * for this Simulator, or the device's dropbox). `undefined` when it is gone.
 */
export interface NativeCrashReportReader {
  read(reportId: string, signal?: AbortSignal): Promise<NativeCrashReportBody | undefined>;
}

/** Finds the OS crash report for one crashed process, never one from another device or app. */
export interface NativeCrashReportFinder {
  find(query: NativeCrashReportQuery): Promise<NativeCrashReportLookup>;
}

/** Report clocks are second-granular (dropbox) or written just after capture (`.ips` mtime). */
export const FRESHNESS_SLACK_MS = 1_000;
export function isFreshCrashReport(
  report: NativeCrashReport,
  notBeforeTimestampMs: number,
): boolean {
  return (
    report.timestampMs === undefined ||
    report.timestampMs >= notBeforeTimestampMs - FRESHNESS_SLACK_MS
  );
}

export function matchesCrashQuery(
  report: NativeCrashReport,
  query: NativeCrashReportQuery,
): boolean {
  return (
    report.appId === query.appId &&
    (query.processId === undefined || report.processId === query.processId)
  );
}

/** The host reads an `.ips` lookup needs. */

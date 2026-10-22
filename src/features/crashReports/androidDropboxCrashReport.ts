import type { StackTraceElement } from "../../models/failureAnalytics";
import {
  boundedField,
  NATIVE_CRASH_REPORT_MAX_FRAMES,
  type NativeCrashReport,
} from "./NativeCrashReport";

/** Dropbox tags the OS writes for app crashes without root: Java and native (tombstone). */
export const ANDROID_CRASH_DROPBOX_TAGS = ["data_app_crash", "data_app_native_crash"] as const;
export type AndroidCrashDropboxTag = (typeof ANDROID_CRASH_DROPBOX_TAGS)[number];

export interface ParsedDropboxCrashReport {
  report: NativeCrashReport;
  /** Process name as the entry states it (`com.example.app` or `com.example.app:remote`). */
  processName: string;
  /** The whole dropbox entry, from its header line on, for the full-report resource. */
  rawText: string;
}

const ENTRY_SEPARATOR = /^={20,}\s*$/m;
const ENTRY_HEADER =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (data_app_crash|data_app_native_crash) \(/;

interface DropboxEntry {
  tag: AndroidCrashDropboxTag;
  localTime: string;
  headers: Map<string, string>;
  body: string[];
  rawText: string;
}

function splitEntry(chunk: string): DropboxEntry | undefined {
  const lines = chunk.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => ENTRY_HEADER.test(line));
  const match = start >= 0 ? lines[start]!.match(ENTRY_HEADER) : null;
  if (!match) {
    return undefined;
  }
  const headers = new Map<string, string>();
  let index = start + 1;
  for (; index < lines.length && lines[index]!.trim() !== ""; index += 1) {
    const header = lines[index]!.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (header) {
      headers.set(header[1]!, header[2]!.trim());
    }
  }
  return {
    tag: match[3] as AndroidCrashDropboxTag,
    localTime: `${match[1]} ${match[2]}`,
    headers,
    body: lines.slice(index + 1),
    rawText: lines.slice(start).join("\n").trimEnd(),
  };
}

/**
 * URI-safe report id: `<tag>-<YYYYMMDDTHHMMSS>-<pid>`. It names one entry so the
 * full-report resource can find it again, and survives a URI path segment.
 */
export function dropboxReportId(
  tag: AndroidCrashDropboxTag,
  localTime: string,
  process: number | string,
): string {
  const compactTime = localTime.replace(/-/g, "").replace(" ", "T").replace(/:/g, "");
  return `${tag}-${compactTime}-${String(process).replace(/[^A-Za-z0-9._]/g, "_")}`;
}

/** The dropbox tag a report id was minted for, or `undefined` for a foreign id. */
export function dropboxTagOfReportId(reportId: string): AndroidCrashDropboxTag | undefined {
  // Longest tag first: `data_app_native_crash` also starts with `data_app_`.
  return [...ANDROID_CRASH_DROPBOX_TAGS]
    .sort((left, right) => right.length - left.length)
    .find((tag) => reportId.startsWith(`${tag}-`));
}

/** `2026-10-21 10:00:02` in the device's zone, given its UTC offset in minutes. */
function localTimeToEpochMs(localTime: string, utcOffsetMinutes: number | undefined) {
  if (utcOffsetMinutes === undefined) {
    return undefined;
  }
  const asUtc = Date.parse(`${localTime.replace(" ", "T")}Z`);
  return Number.isNaN(asUtc) ? undefined : asUtc - utcOffsetMinutes * 60_000;
}

/** Tombstone `Timestamp: 2026-10-21 10:00:03.123456789+0000` carries its own zone. */
function tombstoneTimestampMs(body: string[]): number | undefined {
  const match = body
    .map((line) =>
      line.match(
        /^Timestamp: (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?([+-]\d{2})(\d{2})/,
      ),
    )
    .find(Boolean);
  if (!match) {
    return undefined;
  }
  const fraction = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  const parsed = Date.parse(`${match[1]}T${match[2]}.${fraction}${match[4]}:${match[5]}`);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function javaFrame(line: string, appId: string): StackTraceElement | undefined {
  const match = line.match(/^\s*at ([^(]+)\.([^.(]+)\(([^)]*)\)\s*$/);
  if (!match) {
    return undefined;
  }
  const location = match[3]!.match(/^(.+?):(\d+)$/);
  return {
    className: match[1]!,
    methodName: match[2]!,
    fileName: location ? location[1]! : match[3]! || null,
    lineNumber: location ? Number(location[2]) : null,
    isAppCode: match[1]!.startsWith(`${appId}.`),
  };
}

function nativeFrame(line: string, appId: string): StackTraceElement | undefined {
  const match = line.match(/^\s*#\d+ pc ([0-9a-fA-F]+)\s+(\S+)(?: \(([^)]+)\))?/);
  if (!match) {
    return undefined;
  }
  return {
    className: match[2]!,
    methodName: match[3] ?? `pc ${match[1]}`,
    fileName: null,
    lineNumber: null,
    isAppCode: match[2]!.includes(`/${appId}-`),
  };
}

function javaException(entry: DropboxEntry, appId: string) {
  const first = entry.body.find((line) => line.trim() !== "")?.trim() ?? "";
  const separator = first.indexOf(": ");
  return {
    exceptionType: separator >= 0 ? first.slice(0, separator) : first,
    exceptionMessage: separator >= 0 ? first.slice(separator + 2) : undefined,
    exceptionCode: undefined,
    frames: entry.body.flatMap((line) => javaFrame(line, appId) ?? []),
  };
}

function nativeException(entry: DropboxEntry, appId: string) {
  const signalLine = entry.body
    .map((line) => line.trim())
    .find((line) => /^signal \d+ \(\w+\)/.test(line));
  const abortMessage = entry.body
    .map((line) => line.match(/^Abort message: '(.*)'\s*$/)?.[1])
    .find((message) => message !== undefined);
  return {
    exceptionType: signalLine?.match(/^signal \d+ \((\w+)\)/)?.[1] ?? "native crash",
    exceptionMessage: abortMessage,
    exceptionCode: signalLine?.replace(/, fault addr .*$/, ""),
    frames: entry.body.flatMap((line) => nativeFrame(line, appId) ?? []),
  };
}

function buildFingerprint(entry: DropboxEntry): { deviceModel?: string; osVersion?: string } {
  const parts = entry.headers.get("Build")?.split("/");
  const release = parts?.[2]?.split(":")[1];
  return {
    deviceModel: parts?.[1],
    osVersion: release ? `Android ${release}` : undefined,
  };
}

interface EntryIdentity {
  processName: string;
  appId: string;
  appVersion?: string;
  processId?: number;
}

function entryIdentity(entry: DropboxEntry): EntryIdentity | undefined {
  const processName = entry.headers.get("Process");
  const packageHeader = entry.headers.get("Package")?.match(/^(\S+) v\d+(?: \((.*)\))?/);
  const appId = packageHeader?.[1] ?? processName?.split(":")[0];
  if (!processName || !appId) {
    return undefined;
  }
  const pid = Number(entry.headers.get("PID"));
  return {
    processName,
    appId,
    appVersion: packageHeader?.[2],
    processId: Number.isInteger(pid) && pid > 0 ? pid : undefined,
  };
}

function exceptionFields(
  entry: DropboxEntry,
  appId: string,
): Pick<
  NativeCrashReport,
  "exceptionType" | "exceptionCode" | "exceptionMessage" | "terminationReason" | "frames"
> {
  const native = entry.tag === "data_app_native_crash";
  const exception = native ? nativeException(entry, appId) : javaException(entry, appId);
  return {
    exceptionType: boundedField(exception.exceptionType) ?? "unknown",
    exceptionCode: boundedField(exception.exceptionCode),
    exceptionMessage: boundedField(exception.exceptionMessage),
    terminationReason: native ? "native crash" : "uncaught exception",
    frames: exception.frames.slice(0, NATIVE_CRASH_REPORT_MAX_FRAMES),
  };
}

function entryTimestampMs(entry: DropboxEntry, utcOffsetMinutes: number | undefined) {
  const stated =
    entry.tag === "data_app_native_crash" ? tombstoneTimestampMs(entry.body) : undefined;
  return stated ?? localTimeToEpochMs(entry.localTime, utcOffsetMinutes);
}

function toReport(
  entry: DropboxEntry,
  utcOffsetMinutes: number | undefined,
): ParsedDropboxCrashReport | undefined {
  const identity = entryIdentity(entry);
  if (!identity) {
    return undefined;
  }
  const { processName, appId, appVersion, processId } = identity;
  return {
    processName,
    rawText: entry.rawText,
    report: {
      id: dropboxReportId(entry.tag, entry.localTime, processId ?? processName),
      platform: "android",
      source: "android_dropbox",
      appId,
      appVersion,
      processId,
      timestampMs: entryTimestampMs(entry, utcOffsetMinutes),
      ...exceptionFields(entry, appId),
      reportPath: `dumpsys dropbox ${entry.tag} ${entry.localTime}`,
      ...buildFingerprint(entry),
    },
  };
}

/**
 * Parse `dumpsys dropbox --print <tag>` output into crash reports, oldest
 * first. `utcOffsetMinutes` converts the device-local entry times; without it
 * a Java crash carries no `timestampMs` (a tombstone still states its own).
 */
export function parseDropboxCrashReports(
  output: string,
  utcOffsetMinutes?: number,
): ParsedDropboxCrashReport[] {
  return output.split(ENTRY_SEPARATOR).flatMap((chunk) => {
    const entry = splitEntry(chunk);
    const parsed = entry ? toReport(entry, utcOffsetMinutes) : undefined;
    return parsed ? [parsed] : [];
  });
}

/** `date +%z` output (`+0530`, `-0700`) → minutes east of UTC. */
export function parseUtcOffsetMinutes(output: string): number | undefined {
  const match = output.trim().match(/^([+-])(\d{2})(\d{2})$/);
  if (!match) {
    return undefined;
  }
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

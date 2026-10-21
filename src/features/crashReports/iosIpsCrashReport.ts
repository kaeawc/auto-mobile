import type { StackTraceElement } from "../../models/failureAnalytics";
import { logger } from "../../utils/logger";
import {
  boundedField,
  NATIVE_CRASH_REPORT_MAX_FRAMES,
  type NativeCrashReport,
} from "./NativeCrashReport";

/** `bug_type` of an app crash; other `.ips` kinds (hangs, jetsam, stackshots) are skipped. */
const IPS_CRASH_BUG_TYPE = "309";
/** `.ips` `platform` value written for iOS Simulator processes. */
const IPS_PLATFORM_IOS_SIMULATOR = 7;

export interface ParsedIpsCrashReport {
  report: NativeCrashReport;
  /** The Simulator UDID the crashed process ran in; absent for device reports. */
  simulatorDeviceId?: string;
}

interface IpsHeader {
  bug_type?: string;
  bundleID?: string;
  app_version?: string;
  build_version?: string;
  incident_id?: string;
  os_version?: string;
  platform?: number;
}

interface IpsFrame {
  imageIndex?: number;
  imageOffset?: number;
  symbol?: string;
  sourceFile?: string;
  sourceLine?: number;
}

interface IpsBody {
  incident?: string;
  pid?: number;
  procPath?: string;
  modelCode?: string;
  captureTime?: string;
  coalitionName?: string;
  bundleInfo?: { CFBundleIdentifier?: string; CFBundleShortVersionString?: string };
  exception?: { type?: string; signal?: string; codes?: string; subtype?: string };
  termination?: { namespace?: string; code?: number; indicator?: string; byProc?: string };
  asi?: Record<string, unknown>;
  faultingThread?: number;
  threads?: Array<{ triggered?: boolean; frames?: IpsFrame[] }>;
  usedImages?: Array<{ name?: string; path?: string }>;
}

function parseJsonObject<T>(text: string): T | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? (value as T) : undefined;
  } catch (error) {
    // Legacy text-format reports and truncated writes are not JSON; they are skipped, not fatal.
    logger.debug(`[CrashReports] .ips section is not JSON: ${error}`);
    return undefined;
  }
}

/** `2026-10-21 10:00:00.8123 +0000` → epoch ms. */
export function parseIpsTimestamp(value: string | undefined): number | undefined {
  const match = value?.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))? ([+-])(\d{2})(\d{2})$/,
  );
  if (!match) {
    return undefined;
  }
  const fraction = (match[3] ?? "").padEnd(3, "0").slice(0, 3);
  const parsed = Date.parse(
    `${match[1]}T${match[2]}.${fraction}${match[4]}${match[5]}:${match[6]}`,
  );
  return Number.isNaN(parsed) ? undefined : parsed;
}

function simulatorDeviceIdOf(body: IpsBody): string | undefined {
  const fromPath = body.procPath?.match(/\/CoreSimulator\/Devices\/([0-9A-Fa-f-]{36})\//)?.[1];
  const fromCoalition = body.coalitionName?.match(
    /^com\.apple\.CoreSimulator\.SimDevice\.([0-9A-Fa-f-]{36})$/,
  )?.[1];
  return (fromPath ?? fromCoalition)?.toUpperCase();
}

function appBundleDirectory(procPath: string | undefined): string | undefined {
  const index = procPath?.indexOf(".app/") ?? -1;
  return index >= 0 ? procPath!.slice(0, index + ".app/".length) : undefined;
}

function crashingFrames(body: IpsBody): StackTraceElement[] {
  const threads = body.threads ?? [];
  const thread =
    (body.faultingThread !== undefined ? threads[body.faultingThread] : undefined) ??
    threads.find((candidate) => candidate.triggered);
  const bundle = appBundleDirectory(body.procPath);
  return (thread?.frames ?? [])
    .slice(0, NATIVE_CRASH_REPORT_MAX_FRAMES)
    .map((frame) => toStackElement(frame, body, bundle));
}

function frameSymbol(frame: IpsFrame): string {
  const symbol = boundedField(frame.symbol);
  if (symbol) {
    return symbol;
  }
  return frame.imageOffset !== undefined ? `0x${frame.imageOffset.toString(16)}` : "???";
}

function toStackElement(
  frame: IpsFrame,
  body: IpsBody,
  bundle: string | undefined,
): StackTraceElement {
  const image = frame.imageIndex !== undefined ? body.usedImages?.[frame.imageIndex] : undefined;
  const imagePath = image?.path ?? "";
  return {
    className: image?.name ?? "",
    methodName: frameSymbol(frame),
    fileName: frame.sourceFile ?? null,
    lineNumber: frame.sourceLine ?? null,
    isAppCode: bundle !== undefined && imagePath.startsWith(bundle),
  };
}

function applicationSpecificInfo(body: IpsBody): string | undefined {
  const lines = Object.values(body.asi ?? {}).flatMap((value) =>
    Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : [],
  );
  return boundedField(lines.join("\n"));
}

function terminationReason(body: IpsBody): string | undefined {
  const termination = body.termination;
  if (!termination) {
    return undefined;
  }
  const head = [termination.namespace, termination.code].filter((part) => part !== undefined);
  const reason = [head.join(" "), termination.indicator].filter(Boolean).join(": ");
  return boundedField(termination.byProc ? `${reason} (by ${termination.byProc})` : reason);
}

function exceptionFields(
  body: IpsBody,
): Pick<
  NativeCrashReport,
  "exceptionType" | "exceptionCode" | "exceptionMessage" | "terminationReason"
> {
  const exception = body.exception ?? {};
  const exceptionType = [exception.type, exception.signal && `(${exception.signal})`]
    .filter(Boolean)
    .join(" ");
  return {
    exceptionType: boundedField(exceptionType) ?? "unknown",
    exceptionCode: boundedField([exception.codes, exception.subtype].filter(Boolean).join(" ")),
    exceptionMessage: applicationSpecificInfo(body),
    terminationReason: terminationReason(body),
  };
}

function parseSections(text: string): { header: IpsHeader; body: IpsBody } | undefined {
  const newline = text.indexOf("\n");
  if (newline < 0) {
    return undefined;
  }
  const header = parseJsonObject<IpsHeader>(text.slice(0, newline));
  if (header?.bug_type !== IPS_CRASH_BUG_TYPE) {
    return undefined;
  }
  const body = parseJsonObject<IpsBody>(text.slice(newline + 1));
  return body ? { header, body } : undefined;
}

/**
 * Parse one JSON-format `.ips` crash report (iOS 15+ and every current
 * Simulator): a one-line JSON header followed by a JSON body. Returns
 * `undefined` for non-crash `.ips` kinds and anything unparseable.
 */
export function parseIpsCrashReport(
  text: string,
  reportPath: string,
): ParsedIpsCrashReport | undefined {
  const sections = parseSections(text);
  const appId = sections?.body.bundleInfo?.CFBundleIdentifier ?? sections?.header.bundleID;
  if (!sections || !appId) {
    return undefined;
  }
  const { header, body } = sections;
  const simulatorDeviceId = simulatorDeviceIdOf(body);
  return {
    report: {
      id: body.incident ?? header.incident_id ?? reportPath,
      platform: "ios",
      source: "ios_ips",
      appId,
      appVersion: body.bundleInfo?.CFBundleShortVersionString ?? header.app_version,
      processId: body.pid,
      timestampMs: parseIpsTimestamp(body.captureTime),
      ...exceptionFields(body),
      frames: crashingFrames(body),
      reportPath,
      ...deviceFields(header, body, simulatorDeviceId),
    },
    ...(simulatorDeviceId ? { simulatorDeviceId } : {}),
  };
}

function deviceFields(
  header: IpsHeader,
  body: IpsBody,
  simulatorDeviceId: string | undefined,
): Pick<NativeCrashReport, "deviceModel" | "osVersion"> {
  const isSimulator =
    header.platform === IPS_PLATFORM_IOS_SIMULATOR || simulatorDeviceId !== undefined;
  return {
    deviceModel: isSimulator ? "iOS Simulator" : body.modelCode,
    osVersion: boundedField(header.os_version),
  };
}

import { defaultAdbClientFactory } from "../utils/android-cmdline-tools/AdbClientFactory";
import { errorMessage } from "../utils/describeUnknownError";
import { logger } from "../utils/logger";
import type { BootedDevice } from "../models";
import {
  createNativeCrashReportReader,
  nodeCrashReportFileSystem,
} from "../features/crashReports/NativeCrashReportFinder";
import type { NativeCrashReportReader } from "../features/crashReports/NativeCrashReport";
import { resolveActiveSessionDevice, type ActiveSessionResolver } from "./activeSessionDevice";
import {
  getRequestedResourceUri,
  ResourceRegistry,
  type ResourceContent,
  type ResourceReadContext,
} from "./resourceRegistry";
import { SESSION_LOG_MAX_BYTES_LIMIT, normalizeSessionLogAppId } from "./sessionLogContract";

export const CRASH_REPORT_RESOURCE_TEMPLATE =
  "automobile:device-session/{sessionUuid}/apps/{appId}/crash-reports/{reportId}{?maxBytes}";

/** Largest report body returned; the first `maxBytes` bytes with the full size reported. */
export const CRASH_REPORT_DEFAULT_MAX_BYTES = 256 * 1024;

/** Report ids are URI-safe by construction (`.ips` incident UUIDs, dropbox `<tag>-<time>-<pid>`). */
const REPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CrashReportResourceDependencies {
  resolveActiveSession: ActiveSessionResolver;
  /** The device's report reader, or `undefined` when the platform has none. */
  readerFor(device: BootedDevice): NativeCrashReportReader | undefined;
}

const defaultDependencies: CrashReportResourceDependencies = {
  resolveActiveSession: resolveActiveSessionDevice,
  readerFor: (device) =>
    createNativeCrashReportReader(device, {
      adb: defaultAdbClientFactory.create(device),
      fileSystem: nodeCrashReportFileSystem,
    }),
};

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    logger.debug(`[CrashReportResources] undecodable segment ${value}: ${error}`);
    return value;
  }
}

function jsonResponse(uri: string, body: object): ResourceContent {
  return { uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) };
}

function jsonError(uri: string, code: string, error: string): ResourceContent {
  return jsonResponse(uri, { code, error });
}

function parseMaxBytes(raw: string | undefined): number | string {
  if (raw === undefined || raw === "") {
    return CRASH_REPORT_DEFAULT_MAX_BYTES;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > SESSION_LOG_MAX_BYTES_LIMIT) {
    return `maxBytes must be an integer from 1 to ${SESSION_LOG_MAX_BYTES_LIMIT}.`;
  }
  return parsed;
}

function isOwnSession(context: ResourceReadContext, sessionUuid: string): boolean {
  return context.sessionUuid === sessionUuid || context.ownsSession?.(sessionUuid) === true;
}

function createCrashReportHandler(deps: CrashReportResourceDependencies) {
  return async (
    params: Record<string, string>,
    context: ResourceReadContext,
  ): Promise<ResourceContent> => {
    const { sessionUuid: rawSessionUuid, appId: rawAppId, reportId: rawReportId } = params;
    const sessionUuid = safeDecode(rawSessionUuid);
    const requestedUri =
      getRequestedResourceUri(params) ??
      `automobile:device-session/${rawSessionUuid}/apps/${rawAppId}/crash-reports/${rawReportId}`;

    // Binding first, before any parsing or device access. An earlier session this connection
    // acquired still counts as its own, as for observation resources.
    if (!isOwnSession(context, sessionUuid)) {
      return jsonError(
        requestedUri,
        "SESSION_NOT_BOUND",
        "This resource can only be read by its bound device session.",
      );
    }
    const activeSession = deps.resolveActiveSession(sessionUuid);
    if (!activeSession) {
      return jsonError(
        requestedUri,
        "SESSION_NOT_ACTIVE",
        `No active device session found for sessionUuid ${sessionUuid}.`,
      );
    }

    const reportId = safeDecode(rawReportId);
    const maxBytes = parseMaxBytes(params.maxBytes);
    if (typeof maxBytes === "string" || !REPORT_ID_PATTERN.test(reportId)) {
      return jsonError(
        requestedUri,
        "INVALID_REQUEST",
        typeof maxBytes === "string" ? maxBytes : "reportId is not a valid crash report id.",
      );
    }
    let appId: string;
    try {
      appId = normalizeSessionLogAppId(safeDecode(rawAppId));
    } catch (error) {
      return jsonError(requestedUri, "INVALID_REQUEST", errorMessage(error));
    }
    return readReport(deps, {
      device: activeSession.device,
      uri: requestedUri,
      appId,
      reportId,
      maxBytes,
      context,
    });
  };
}

interface CrashReportReadRequest {
  device: BootedDevice;
  uri: string;
  appId: string;
  reportId: string;
  maxBytes: number;
  context: ResourceReadContext;
}

async function readReport(
  deps: CrashReportResourceDependencies,
  request: CrashReportReadRequest,
): Promise<ResourceContent> {
  const { device, uri, appId, reportId, maxBytes, context } = request;
  const reader = deps.readerFor(device);
  if (!reader) {
    return jsonError(
      uri,
      "UNSUPPORTED",
      `Crash reports are not available for ${device.deviceId}: physical iOS retrieval is not implemented yet.`,
    );
  }
  try {
    const body = await reader.read(reportId, context.signal);
    // A report for another app is never served through this app's URI.
    if (!body || body.report.appId !== appId) {
      return jsonError(
        uri,
        "NOT_FOUND",
        `No crash report ${reportId} for ${appId} on this device.`,
      );
    }
    const buffer = Buffer.from(body.text, "utf8");
    const bounded = buffer.byteLength > maxBytes ? buffer.subarray(0, maxBytes) : buffer;
    return jsonResponse(uri, {
      reportId: body.report.id,
      source: body.report.source,
      appId,
      reportPath: body.report.reportPath,
      byteCount: buffer.byteLength,
      truncated: bounded.byteLength < buffer.byteLength,
      // A byte cut can split a character; the lenient decode keeps the head readable.
      text: bounded.toString("utf8"),
    });
  } catch (error) {
    context.signal?.throwIfAborted();
    logger.warn(`[CrashReportResources] read ${reportId} failed: ${errorMessage(error)}`, error);
    return jsonError(uri, "READ_FAILED", errorMessage(error));
  }
}

export function registerCrashReportResources(
  overrides: Partial<CrashReportResourceDependencies> = {},
): void {
  const deps = { ...defaultDependencies, ...overrides };
  ResourceRegistry.registerTemplateWithReadContext(
    CRASH_REPORT_RESOURCE_TEMPLATE,
    "Native Crash Report",
    {
      description:
        "The full OS crash report (an `.ips` on iOS Simulator, a dropbox entry on Android) named by " +
        "`crashApp`'s `crashReport.reportId`, for the device owned by the caller's session. " +
        "`maxBytes` bounds the returned text.",
      mimeType: "application/json",
      handler: createCrashReportHandler(deps),
    },
  );
}

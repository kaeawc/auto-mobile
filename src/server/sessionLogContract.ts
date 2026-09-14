import { z } from "zod/v4";
import {
  APP_FILE_CONTAINERS,
  normalizeAppFileRelativePath,
  type AppFileContainer,
} from "./appFileContract";
import { addDeviceTargetingToSchema, withAppIdAliases } from "./toolSchemaHelpers";
import { optionalEnum, optionalInteger, optionalString } from "./queryParamValidation";
import type { Platform } from "../models";
import type { LocalFileListEntry } from "./appFileService";

/**
 * Session-scoped execution-log contract (#7006).
 *
 * One resource family collects the diagnostic sources a test consumer would
 * otherwise reach with raw `adb shell run-as`, `xcrun simctl get_app_container`
 * and `log show`, and one tool resets app-private rotated logs. Every read is
 * bound to the caller's device session: the URI names the session, the read
 * context must carry the same session, and the device comes from the session's
 * ownership record rather than from a caller-supplied serial.
 */
export const SESSION_LOG_RESOURCE_TEMPLATE =
  "automobile:device-session/{sessionUuid}/apps/{appId}/logs" +
  "{?container,paths,groupId,groupPaths,lastSeconds,level,maxBytes}";

export const SESSION_LOG_QUERY_PARAMS = [
  "container",
  "paths",
  "groupId",
  "groupPaths",
  "lastSeconds",
  "level",
  "maxBytes",
] as const;

export const UNIFIED_LOG_LEVELS = ["default", "info", "debug"] as const;
export type UnifiedLogLevel = (typeof UNIFIED_LOG_LEVELS)[number];

/** Every read is bounded: the wire never carries more than this many bytes per entry. */
export const SESSION_LOG_DEFAULT_MAX_BYTES = 256 * 1024;
export const SESSION_LOG_MAX_BYTES_LIMIT = 4 * 1024 * 1024;
/** Named paths per source, so one URI cannot fan out into an unbounded device scan. */
export const SESSION_LOG_MAX_PATHS = 32;
/** Longest unified-log window, in seconds (one hour). */
export const UNIFIED_LOG_MAX_WINDOW_SECONDS = 3600;

export interface SessionLogFilesRequest {
  container: AppFileContainer;
  paths: string[];
}

export interface SessionLogAppGroupRequest {
  groupId: string;
  /** Files inside the group container to read in the same collection; may be empty. */
  paths: string[];
}

export interface UnifiedLogWindowRequest {
  lastSeconds: number;
  level: UnifiedLogLevel;
}

export interface SessionLogCollectionRequest {
  appId: string;
  maxBytes: number;
  files?: SessionLogFilesRequest;
  appGroup?: SessionLogAppGroupRequest;
  unifiedLog?: UnifiedLogWindowRequest;
}

export interface SessionLogFileOutcome {
  path: string;
  status: "read" | "missing" | "failed";
  byteCount?: number;
  truncated?: boolean;
  /** UTF-8 content, bounded by `maxBytes`. */
  text?: string;
  /** Base64 content when the bytes are not UTF-8 text, bounded by `maxBytes`. */
  blob?: string;
  reason?: string;
}

export type SessionLogSourceFailure = {
  status: "unavailable" | "failed" | "timedOut";
  reason: string;
};

export type SessionLogSourceOutcome<T> = ({ status: "ok" } & T) | SessionLogSourceFailure;

export interface SessionLogFilesResult {
  container: AppFileContainer;
  entries: SessionLogFileOutcome[];
}

export interface SessionLogAppGroupResult {
  groupId: string;
  files: LocalFileListEntry[];
  entries: SessionLogFileOutcome[];
}

export interface UnifiedLogWindowResult {
  lastSeconds: number;
  level: UnifiedLogLevel;
  predicate: string;
  timeoutMs: number;
  byteCount: number;
  truncated: boolean;
  text: string;
}

export interface SessionLogCollectionResult {
  sessionUuid: string;
  deviceId: string;
  platform: Platform;
  appId: string;
  maxBytes: number;
  files?: SessionLogSourceOutcome<SessionLogFilesResult>;
  appGroup?: SessionLogSourceOutcome<SessionLogAppGroupResult>;
  unifiedLog?: SessionLogSourceOutcome<UnifiedLogWindowResult>;
}

export interface ResetAppLogsPathOutcome {
  path: string;
  status: "reset" | "missing" | "failed";
  reason?: string;
}

export interface ResetAppLogsResult {
  success: true;
  deviceId: string;
  platform: Platform;
  appId: string;
  container: AppFileContainer;
  entries: ResetAppLogsPathOutcome[];
}

export interface ResetAppLogsArgs {
  appId: string;
  container: AppFileContainer;
  paths: string[];
  platform?: Platform;
  deviceId?: string;
  device?: string;
  sessionUuid?: string;
}

/** An app id that is safe both as a path segment and inside a unified-log predicate. */
export function normalizeSessionLogAppId(appId: string): string {
  const normalized = appId.trim();
  if (
    normalized.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized) ||
    normalized.split(".").some((segment) => segment.length === 0)
  ) {
    throw new Error(
      "appId must be a non-empty app identifier made of letters, digits, '.', '_' or '-'.",
    );
  }
  return normalized;
}

/** App Group identifiers (`group.com.example.shared`) are one path segment, never a path. */
export function normalizeAppGroupId(groupId: string): string {
  const normalized = groupId.trim();
  if (
    normalized.length === 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized) ||
    normalized.split(".").some((segment) => segment.length === 0)
  ) {
    throw new Error(
      "groupId must be a non-empty App Group identifier made of letters, digits, '.', '_' or '-'.",
    );
  }
  return normalized;
}

/**
 * Normalize a caller-named log path list: relative, traversal-free, de-duplicated
 * and bounded in count. Order is preserved so per-path outcomes line up with the
 * request.
 */
export function normalizeSessionLogPaths(paths: readonly string[]): string[] {
  if (paths.length === 0) {
    throw new Error("paths must name at least one log file.");
  }
  if (paths.length > SESSION_LOG_MAX_PATHS) {
    throw new Error(`paths must name at most ${SESSION_LOG_MAX_PATHS} log files.`);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths) {
    const safe = normalizeAppFileRelativePath(path.trim());
    if (!seen.has(safe)) {
      seen.add(safe);
      normalized.push(safe);
    }
  }
  return normalized;
}

function splitPathList(value: string): string[] {
  return value
    .split(",")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => {
      try {
        return decodeURIComponent(path);
      } catch (error) {
        throw new Error(`paths contains an invalid percent-escape: ${path}`, { cause: error });
      }
    });
}

function parseFilesSource(query: Record<string, string>): SessionLogFilesRequest | undefined {
  const container = optionalEnum(query.container, "container", APP_FILE_CONTAINERS);
  const paths = optionalString(query.paths);
  if (paths === undefined) {
    if (container !== undefined) {
      throw new Error("container requires paths.");
    }
    return undefined;
  }
  return {
    container: container ?? "documents",
    paths: normalizeSessionLogPaths(splitPathList(paths)),
  };
}

function parseAppGroupSource(query: Record<string, string>): SessionLogAppGroupRequest | undefined {
  const groupId = optionalString(query.groupId);
  const groupPaths = optionalString(query.groupPaths);
  if (groupId === undefined) {
    if (groupPaths !== undefined) {
      throw new Error("groupPaths requires groupId.");
    }
    return undefined;
  }
  return {
    groupId: normalizeAppGroupId(groupId),
    paths: groupPaths === undefined ? [] : normalizeSessionLogPaths(splitPathList(groupPaths)),
  };
}

function parseUnifiedLogSource(query: Record<string, string>): UnifiedLogWindowRequest | undefined {
  const lastSeconds = optionalInteger(query.lastSeconds, "lastSeconds", {
    min: 1,
    max: UNIFIED_LOG_MAX_WINDOW_SECONDS,
  });
  const level = optionalEnum(query.level, "level", UNIFIED_LOG_LEVELS);
  if (lastSeconds === undefined) {
    if (level !== undefined) {
      throw new Error("level requires lastSeconds.");
    }
    return undefined;
  }
  return { lastSeconds, level: level ?? "default" };
}

/**
 * Parse the query half of a session-log URI into a bounded collection request.
 * Fail-closed: unknown keys, an empty request, and every out-of-range bound are
 * rejected here, before any device is touched.
 */
export function parseSessionLogQuery(
  appIdParam: string,
  query: Record<string, string>,
): SessionLogCollectionRequest {
  const allowed = new Set<string>(SESSION_LOG_QUERY_PARAMS);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      throw new Error(`Unknown session log query parameter: ${key}`);
    }
  }

  const appId = normalizeSessionLogAppId(decodeURIComponent(appIdParam));
  const maxBytes =
    optionalInteger(query.maxBytes, "maxBytes", { min: 1, max: SESSION_LOG_MAX_BYTES_LIMIT }) ??
    SESSION_LOG_DEFAULT_MAX_BYTES;
  const files = parseFilesSource(query);
  const appGroup = parseAppGroupSource(query);
  const unifiedLog = parseUnifiedLogSource(query);
  if (!files && !appGroup && !unifiedLog) {
    throw new Error(
      "Session log collection needs at least one source: paths, groupId, or lastSeconds.",
    );
  }
  return {
    appId,
    maxBytes,
    ...(files ? { files } : {}),
    ...(appGroup ? { appGroup } : {}),
    ...(unifiedLog ? { unifiedLog } : {}),
  };
}

export function buildSessionLogResourceUri(
  sessionUuid: string,
  request: SessionLogCollectionRequest,
): string {
  const query = new URLSearchParams();
  if (request.files) {
    query.set("container", request.files.container);
    query.set("paths", request.files.paths.map(encodeURIComponent).join(","));
  }
  if (request.appGroup) {
    query.set("groupId", request.appGroup.groupId);
    if (request.appGroup.paths.length > 0) {
      query.set("groupPaths", request.appGroup.paths.map(encodeURIComponent).join(","));
    }
  }
  if (request.unifiedLog) {
    query.set("lastSeconds", String(request.unifiedLog.lastSeconds));
    query.set("level", request.unifiedLog.level);
  }
  query.set("maxBytes", String(request.maxBytes));
  return (
    `automobile:device-session/${encodeURIComponent(sessionUuid)}` +
    `/apps/${encodeURIComponent(request.appId)}/logs?${query.toString()}`
  );
}

const resetAppLogsPathSchema = z
  .string()
  .describe("Log file path relative to the container; rotated siblings (`<path>.N`) are reset too");

export const resetAppLogsSchema = withAppIdAliases(
  addDeviceTargetingToSchema(
    z
      .object({
        appId: z.string().min(1).describe("App package name or bundle identifier"),
        container: z
          .enum(APP_FILE_CONTAINERS)
          .default("documents")
          .describe("Logical app container that holds the log files"),
        paths: z
          .array(resetAppLogsPathSchema)
          .min(1)
          .max(SESSION_LOG_MAX_PATHS)
          .describe("Explicitly named log files to reset"),
      })
      .strict(),
  ).superRefine((args, ctx) => {
    try {
      normalizeSessionLogAppId(args.appId);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "appId must be safe",
        path: ["appId"],
      });
    }
    for (const [index, path] of args.paths.entries()) {
      try {
        normalizeAppFileRelativePath(path);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "path must be a safe relative path",
          path: ["paths", index],
        });
      }
    }
  }),
);

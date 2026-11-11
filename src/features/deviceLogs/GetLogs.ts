import type { BootedDevice } from "../../models";
import { PLATFORM_LABELS } from "../../models/Platform";
import { ActionableError } from "../../models/ActionableError";
import { AndroidLogReader } from "./AndroidLogReader";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import {
  compileGrep,
  LOGCAT_PRIORITIES,
  type LogcatBuffer,
  type LogcatPriority,
  type LogLine,
} from "./logcatQuery";

/** Default and largest look-back windows, in seconds (the resource's one-hour cap). */
export const GET_LOGS_DEFAULT_SECONDS = 300;
export const GET_LOGS_MAX_SECONDS = 3600;
export const GET_LOGS_DEFAULT_MAX_LINES = 1000;
export const GET_LOGS_MAX_LINES = 5000;
/** Same per-read byte bound as the session log resource's default. */
export const GET_LOGS_MAX_BYTES = 256 * 1024;

/** The unified-log levels `log show` accepts (same as the session log resource). */
export type UnifiedLogLevel = "default" | "info" | "debug";

export type GetLogsSince = "lastAction" | "sessionStart" | "run-start" | { seconds: number };

export interface GetLogsRequest {
  appId?: string;
  since?: GetLogsSince;
  tags?: readonly string[];
  minPriority?: LogcatPriority;
  grep?: string;
  buffers?: readonly LogcatBuffer[];
  includeSystem?: boolean;
  maxLines?: number;
}

/** A returned line; Apple unified-log lines carry only a timestamp and the text. */
export type GetLogsLine = Partial<Omit<LogLine, "message" | "timestamp">> & {
  timestamp: string;
  message: string;
};

export interface GetLogsResult {
  platform: BootedDevice["platform"];
  appId?: string;
  sinceSeconds: number;
  lines: GetLogsLine[];
  /** Lines were dropped to stay within `maxLines` or the byte bound; the newest are kept. */
  truncated: boolean;
  pids: number[];
  attribution: "uid" | "pid" | "subsystem" | "process" | "none";
  warnings: string[];
}

/** Clock sources `since` resolves against, injected so tests need no daemon. */
export interface GetLogsClock {
  now(): number;
  /** Current plan execution start; absent outside executePlan. */
  planStartMs?(): number | undefined;
  /** Host-clock start of the device's latest control call, if any. */
  lastActionStartMs(deviceId: string): number | undefined;
  /** Host-clock creation of the caller's session, if it has one. */
  sessionStartMs(): number | undefined;
}

export interface AndroidLogSource {
  read: AndroidLogReader["read"];
}

export interface IosUnifiedLogSource {
  /** `log show --last <seconds>` for the app's subsystem; physical devices throw. */
  collect(
    appId: string,
    lastSeconds: number,
    level: UnifiedLogLevel,
    options?: { signal?: AbortSignal; processName?: string },
  ): Promise<{ text: string; truncated: boolean }>;
  /** The app's executable name (CFBundleExecutable), or undefined when it cannot be resolved. */
  resolveProcessName?(appId: string, signal?: AbortSignal): Promise<string | undefined>;
}

export interface GetLogsDependencies {
  clock: GetLogsClock;
  android: () => AndroidLogSource;
  ios: () => IosUnifiedLogSource;
}

function secondsSince(startMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((nowMs - startMs) / 1000));
}

/**
 * A `since` that is an absolute host-clock instant rather than a duration. The device-relative
 * window must be recomputed when the log is actually read, after any awaited probes.
 */
function sinceAnchorMs(
  since: GetLogsSince | undefined,
  deviceId: string,
  clock: GetLogsClock,
): number | undefined {
  if (since === "run-start") {
    return clock.planStartMs?.();
  }
  if (since === "lastAction") {
    return clock.lastActionStartMs(deviceId);
  }
  return since === "sessionStart" ? clock.sessionStartMs() : undefined;
}

/** Re-derives an anchored look-back at read time, or undefined when `since` is not anchored. */
function sinceRefresher(
  since: GetLogsSince | undefined,
  deviceId: string,
  clock: GetLogsClock,
): (() => number) | undefined {
  const anchor = sinceAnchorMs(since, deviceId, clock);
  return anchor === undefined
    ? undefined
    : () => Math.min(secondsSince(anchor, clock.now()), GET_LOGS_MAX_SECONDS);
}

/** Resolve `since` into a device-relative window; run-start requires an executing plan. */
export function resolveSinceSeconds(
  since: GetLogsSince | undefined,
  deviceId: string,
  clock: GetLogsClock,
  warnings: string[],
): number {
  let seconds = GET_LOGS_DEFAULT_SECONDS;
  if (since === "run-start") {
    const anchor = clock.planStartMs?.();
    if (anchor === undefined) {
      throw new ActionableError('getLogs since: "run-start" requires an executing plan.');
    }
    seconds = secondsSince(anchor, clock.now());
  } else if (typeof since === "object") {
    seconds = since.seconds;
  } else if (since === "lastAction" || since === "sessionStart") {
    const anchor =
      since === "lastAction" ? clock.lastActionStartMs(deviceId) : clock.sessionStartMs();
    if (anchor === undefined) {
      warnings.push(
        since === "lastAction"
          ? `No earlier action on ${deviceId} is known; showing the last ${GET_LOGS_DEFAULT_SECONDS}s.`
          : `No session is bound to this call; showing the last ${GET_LOGS_DEFAULT_SECONDS}s.`,
      );
    } else {
      seconds = secondsSince(anchor, clock.now());
    }
  }
  if (seconds > GET_LOGS_MAX_SECONDS) {
    warnings.push(`The window is capped at ${GET_LOGS_MAX_SECONDS}s.`);
  }
  return Math.min(seconds, GET_LOGS_MAX_SECONDS);
}

/** Keep the newest lines within the line and byte bounds. */
export function boundLines<T extends { message: string }>(
  lines: readonly T[],
  maxLines: number,
  maxBytes: number = GET_LOGS_MAX_BYTES,
): { lines: T[]; truncated: boolean } {
  const kept: T[] = [];
  let bytes = 0;
  for (let index = lines.length - 1; index >= 0 && kept.length < maxLines; index--) {
    const line = lines[index]!;
    bytes += Buffer.byteLength(line.message, "utf8") + 64;
    if (bytes > maxBytes) {
      break;
    }
    kept.push(line);
  }
  return { lines: kept.reverse(), truncated: kept.length < lines.length };
}

function unifiedLogLevel(priority: LogcatPriority): UnifiedLogLevel {
  if (priority === "V" || priority === "D") {
    return "debug";
  }
  return priority === "I" ? "info" : "default";
}

/**
 * The `minPriority` each compact-style type column ranks as (#17963): `Db` debug, `In` info,
 * `Df` default, `E` error, `Fa` fault, `A` activity. The unified log has no warning level, so
 * `W` admits `Df` and up; activity and any unrecognized column rank as `Df`.
 */
export const UNIFIED_TYPE_PRIORITY: Readonly<Record<string, LogcatPriority>> = {
  Db: "D",
  In: "I",
  Df: "W",
  A: "W",
  E: "E",
  Fa: "F",
};

/** The priority a parsed compact line ranks as, from its leading type column. */
export function unifiedLinePriority(message: string): LogcatPriority {
  const type = /^(\S+)\s/.exec(message)?.[1] ?? "";
  return Object.hasOwn(UNIFIED_TYPE_PRIORITY, type) ? UNIFIED_TYPE_PRIORITY[type]! : "W";
}

/** Whether a compact line ranks at or above `minPriority`. */
export function meetsUnifiedPriority(message: string, minPriority: LogcatPriority): boolean {
  return (
    LOGCAT_PRIORITIES.indexOf(unifiedLinePriority(message)) >=
    LOGCAT_PRIORITIES.indexOf(minPriority)
  );
}

// 2026-10-21 08:15:30.123 Df MyApp[123:4567] [com.example:net] message
const COMPACT = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(.*)$/;

export function parseUnifiedCompact(text: string): GetLogsLine[] {
  return text.split("\n").flatMap((raw) => {
    const match = COMPACT.exec(raw.trimEnd());
    return match ? [{ timestamp: match[1]!, message: match[2]! }] : [];
  });
}

/** The resolved read window shared by the per-platform `getLogs` paths. */
interface GetLogsWindow {
  sinceSeconds: number;
  /** Re-derives an anchored look-back right before the read, after any awaited probes. */
  refreshSinceSeconds?: () => number;
  maxLines: number;
  minPriority: LogcatPriority;
}

/** One bounded, filtered log read for `getLogs` (#14082). */
export class GetLogs {
  constructor(private readonly deps: GetLogsDependencies) {}

  async execute(
    device: BootedDevice,
    request: GetLogsRequest,
    signal?: AbortSignal,
  ): Promise<GetLogsResult> {
    const warnings: string[] = [];
    const sinceSeconds = resolveSinceSeconds(
      request.since,
      device.deviceId,
      this.deps.clock,
      warnings,
    );
    const maxLines = Math.min(request.maxLines ?? GET_LOGS_DEFAULT_MAX_LINES, GET_LOGS_MAX_LINES);
    const minPriority = request.minPriority ?? "V";
    const refreshSinceSeconds = sinceRefresher(request.since, device.deviceId, this.deps.clock);
    const refresh = refreshSinceSeconds ? { refreshSinceSeconds } : {};
    if (device.platform !== "android") {
      // Every Apple simulator reads its unified log; none falls through to logcat.
      const window = { platform: device.platform, sinceSeconds, maxLines, minPriority, ...refresh };
      return this.ios(request, window, warnings, signal);
    }
    const result = await this.deps.android().read(
      {
        appId: request.appId,
        sinceSeconds,
        ...refresh,
        tags: request.tags,
        minPriority,
        grep: request.grep,
        buffers: request.buffers ?? ["main", "crash"],
        includeSystem: request.includeSystem ?? false,
      },
      signal,
    );
    const bounded = boundLines(result.lines, maxLines);
    return {
      platform: device.platform,
      ...(request.appId ? { appId: request.appId } : {}),
      sinceSeconds,
      lines: bounded.lines,
      truncated: bounded.truncated,
      pids: [...new Set(bounded.lines.map((line) => line.pid))].sort((a, b) => a - b),
      attribution: result.attribution,
      warnings: [...warnings, ...result.warnings],
    };
  }

  private async ios(
    request: GetLogsRequest,
    window: GetLogsWindow & { platform: Exclude<BootedDevice["platform"], "android"> },
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<GetLogsResult> {
    const { platform, sinceSeconds, refreshSinceSeconds, maxLines, minPriority } = window;
    const label = PLATFORM_LABELS[platform];
    if (!request.appId) {
      throw new ActionableError(
        `getLogs on ${label} needs appId: the unified log is read per app subsystem.`,
      );
    }
    const ignored = [
      ...(request.tags?.length ? ["tags"] : []),
      ...(request.buffers ? ["buffers"] : []),
      ...(request.includeSystem ? ["includeSystem"] : []),
    ];
    if (ignored.length > 0) {
      warnings.push(`Android-only filters ignored on ${label}: ${ignored.join(", ")}.`);
    }
    const grep = compileGrep(request.grep);
    const source = this.deps.ios();
    const processName = await resolveProcessName(source, request.appId, warnings, signal);
    const collected = await source.collect(
      request.appId,
      refreshSinceSeconds?.() ?? sinceSeconds,
      unifiedLogLevel(minPriority),
      { signal, processName },
    );
    if (collected.truncated) {
      warnings.push(
        "The unified log window exceeded the byte bound; only the newest lines were read.",
      );
    }
    // `log show --level` is only a floor (default/info/debug), so error and fault are ranked here.
    const lines = parseUnifiedCompact(collected.text).filter(
      (line) =>
        meetsUnifiedPriority(line.message, minPriority) &&
        (grep === undefined || grep.test(line.message)),
    );
    const bounded = boundLines(lines, maxLines);
    return {
      platform,
      appId: request.appId,
      sinceSeconds,
      lines: bounded.lines,
      truncated: collected.truncated || bounded.truncated,
      pids: [],
      attribution: processName ? "process" : "subsystem",
      warnings:
        lines.length === 0 ? [...warnings, emptyIosWarning(request.appId, processName)] : warnings,
    };
  }
}

async function resolveProcessName(
  source: IosUnifiedLogSource,
  appId: string,
  warnings: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    return await source.resolveProcessName?.(appId, signal);
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn(
      `[getLogs] could not resolve the executable of ${appId}: ${errorMessage(error)}`,
      error,
    );
    warnings.push(
      `Could not resolve ${appId}'s process name, so only its subsystem was matched: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

function emptyIosWarning(appId: string, processName: string | undefined): string {
  return processName
    ? `No unified-log lines matched subsystem ${appId} or process ${processName} in this window.`
    : `No unified-log lines matched subsystem ${appId}; the app's process name could not be resolved, ` +
        "and apps that log under other subsystems are not attributed.";
}

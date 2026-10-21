import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { shellQuote } from "../../utils/shellQuote";
import {
  compileGrep,
  logcatFilterSpecs,
  logcatShellCommand,
  matchesGrep,
  parseThreadtime,
  type LogcatBuffer,
  type LogcatPriority,
  type LogLine,
} from "./logcatQuery";

/** `logcat --uid` arrived in Android 11 (API 30). */
export const LOGCAT_UID_MIN_API = 30;

const LOGCAT_TIMEOUT_MS = 20_000;
const LOGCAT_MAX_BUFFER = 16 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

/** System tags whose lines about the app explain process death, ANRs and launches. */
const SYSTEM_TAG_SPECS = [
  "ActivityManager:I",
  "ActivityTaskManager:I",
  "AndroidRuntime:E",
  "libprocessgroup:I",
  "*:S",
];

export interface AndroidLogRequest {
  appId?: string;
  sinceSeconds: number;
  tags?: readonly string[];
  minPriority: LogcatPriority;
  grep?: string;
  buffers: readonly LogcatBuffer[];
  includeSystem: boolean;
}

export interface AndroidLogResult {
  lines: LogLine[];
  /** Every pid that logged a returned line. */
  pids: number[];
  /**
   * How lines were attributed to `appId`: `uid` covers dead and restarted processes; `pid` (before
   * Android 11) covers only the processes running now.
   */
  attribution: "uid" | "pid" | "none";
  warnings: string[];
}

type Adb = Pick<AdbExecutor, "executeCommand">;

/** Reads logcat for `getLogs` (#14082). Filters are applied on the device where logcat can. */
export class AndroidLogReader {
  constructor(private readonly adb: Adb) {}

  private async shell(command: string, signal?: AbortSignal, timeoutMs = PROBE_TIMEOUT_MS) {
    const result = await this.adb.executeCommand(`shell ${command}`, {
      timeoutMs,
      maxBuffer: timeoutMs === LOGCAT_TIMEOUT_MS ? LOGCAT_MAX_BUFFER : 64 * 1024,
      noRetry: true,
      signal,
    });
    return result.stdout;
  }

  private async apiLevel(signal?: AbortSignal): Promise<number | null> {
    const level = Number((await this.shell("getprop ro.build.version.sdk", signal)).trim());
    return Number.isSafeInteger(level) && level > 0 ? level : null;
  }

  /** `pm list packages -U <id>` prints `package:<id> uid:<uid>` for every substring match. */
  private async uid(appId: string, signal?: AbortSignal): Promise<number | null> {
    const stdout = await this.shell(`pm list packages -U ${shellQuote(appId)}`, signal);
    for (const line of stdout.split("\n")) {
      const match = /^package:(\S+)\s+uid:(\d+)/.exec(line.trim());
      if (match && match[1] === appId) {
        return Number(match[2]);
      }
    }
    return null;
  }

  private async runningPids(appId: string, signal?: AbortSignal): Promise<Set<number>> {
    const stdout = await this.shell(`pidof ${shellQuote(appId)}`, signal);
    return new Set(
      stdout
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0),
    );
  }

  private async logcat(
    query: Parameters<typeof logcatShellCommand>[0],
    signal?: AbortSignal,
  ): Promise<LogLine[]> {
    return parseThreadtime(await this.shell(logcatShellCommand(query), signal, LOGCAT_TIMEOUT_MS));
  }

  async read(request: AndroidLogRequest, signal?: AbortSignal): Promise<AndroidLogResult> {
    const grep = compileGrep(request.grep);
    const filterSpecs = logcatFilterSpecs(request.tags, request.minPriority);
    const warnings: string[] = [];
    const scope = request.appId
      ? await this.appScope(request.appId, warnings, signal)
      : { attribution: "none" as const };
    const appLines = await this.logcat(
      {
        buffers: request.buffers,
        sinceSeconds: request.sinceSeconds,
        filterSpecs,
        ...(scope.attribution === "uid" ? { uid: scope.uid } : {}),
      },
      signal,
    );
    const scoped =
      scope.attribution === "pid" ? appLines.filter((line) => scope.pids.has(line.pid)) : appLines;
    const system =
      request.includeSystem && request.appId
        ? await this.systemLines(request.appId, request.sinceSeconds, signal)
        : [];
    const lines = mergeByTimestamp(scoped, system).filter((line) => matchesGrep(line, grep));
    return {
      lines,
      pids: [...new Set(lines.map((line) => line.pid))].sort((a, b) => a - b),
      attribution: scope.attribution,
      warnings,
    };
  }

  private async appScope(
    appId: string,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<{ attribution: "uid"; uid: number } | { attribution: "pid"; pids: Set<number> }> {
    const [apiLevel, uid] = await Promise.all([this.apiLevel(signal), this.uid(appId, signal)]);
    if (uid !== null && apiLevel !== null && apiLevel >= LOGCAT_UID_MIN_API) {
      return { attribution: "uid", uid };
    }
    warnings.push(
      uid === null
        ? `${appId} is not installed; no app lines can be attributed.`
        : `Android API ${apiLevel ?? "unknown"} has no logcat --uid; only processes of ${appId} running now are covered, so a crashed process's lines are missing.`,
    );
    return {
      attribution: "pid",
      pids: uid === null ? new Set() : await this.runningPids(appId, signal),
    };
  }

  /** ActivityManager/system_server lines that name the app: launches, deaths, ANRs. */
  private async systemLines(
    appId: string,
    sinceSeconds: number,
    signal?: AbortSignal,
  ): Promise<LogLine[]> {
    const lines = await this.logcat(
      { buffers: ["main", "system", "crash"], sinceSeconds, filterSpecs: SYSTEM_TAG_SPECS },
      signal,
    );
    return lines.filter((line) => line.message.includes(appId));
  }
}

/** Both inputs are already in logcat order; a stable merge keeps that order on equal stamps. */
export function mergeByTimestamp(a: readonly LogLine[], b: readonly LogLine[]): LogLine[] {
  const seen = new Set<string>();
  const key = (line: LogLine) =>
    `${line.timestamp}|${line.pid}|${line.tid}|${line.tag}|${line.message}`;
  return [...a, ...b]
    .map((line, index) => ({ line, index }))
    .sort((x, y) => x.line.timestamp.localeCompare(y.line.timestamp) || x.index - y.index)
    .map((entry) => entry.line)
    .filter((line) => {
      const k = key(line);
      if (seen.has(k)) {
        return false;
      }
      seen.add(k);
      return true;
    });
}

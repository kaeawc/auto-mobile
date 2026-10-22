import { parseDumpDurationMs } from "./dumpDuration";
import type { AlarmDumpParser, AlarmInfo } from "./BackgroundWorkTypes";

/**
 * Parses `dumpsys alarm` across API 29-35.
 *
 * Pending alarms print as `<TYPE> #<n>: Alarm{<hash> type <t> [origWhen|when <ms>] [whenElapsed
 * <ms>] <package>}`, each followed by deeper-indented `tag=`, `type=... window=... repeatInterval=...
 * flags=...`, `whenElapsed=<duration>` and `operation=` / `listener=` lines. Android 12+ adds
 * `origWhen`/`whenElapsed` to the header; older releases print `when`. Sections other than the
 * pending list (alarm stats, history) carry no `Alarm{` lines and are ignored.
 */

const ALARM_LINE =
  /\b([A-Z_]+)\s+#\d+:\s+Alarm\{([0-9a-f]+)\s+type\s+(\d+)\s+(?:(?:origWhen|when)\s+-?\d+\s+)?(?:whenElapsed\s+(-?\d+)\s+)?(\S+)\}/;
const NOW_ELAPSED = /\bnowELAPSED=(\d+)/;
const TYPE_NAMES = ["RTC_WAKEUP", "RTC", "ELAPSED_WAKEUP", "ELAPSED"] as const;
const OPERATION_MAX_LENGTH = 200;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function field(body: readonly string[], pattern: RegExp): RegExpExecArray | null {
  for (const line of body) {
    const match = pattern.exec(line);
    if (match) {
      return match;
    }
  }
  return null;
}

function numberOrUndefined(text: string | undefined): number | undefined {
  return text === undefined ? undefined : Number(text);
}

function triggerInMs(
  body: readonly string[],
  headerWhenElapsed: string | undefined,
  nowElapsed: number | undefined,
): number | undefined {
  const relative = parseDumpDurationMs(field(body, /\bwhenElapsed=(\S+)/)?.[1]);
  if (relative !== undefined) {
    return relative;
  }
  return headerWhenElapsed !== undefined && nowElapsed !== undefined
    ? Number(headerWhenElapsed) - nowElapsed
    : undefined;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function buildAlarm(
  match: RegExpExecArray,
  body: readonly string[],
  nowElapsed: number | undefined,
): AlarmInfo {
  const typeCode = Number(match[3]);
  const alarmType = TYPE_NAMES[typeCode] ?? match[1];
  const detail = field(body, /\btype=\d+\b.*?\bwindow=(-?\d+)\b.*?\brepeatInterval=(\d+)/);
  const flags = field(body, /\bflags=0x([0-9a-f]+)/i)?.[1];
  const operation = field(body, /^\s*(?:operation|listener)=(.+)$/)?.[1]?.trim();
  return {
    packageName: match[5],
    alarmType,
    wakeup: alarmType.endsWith("_WAKEUP"),
    ...optional("tag", field(body, /^\s*tag=(.+)$/)?.[1]?.trim()),
    ...optional("triggerInMs", triggerInMs(body, match[4], nowElapsed)),
    ...optional("windowMs", numberOrUndefined(detail?.[1])),
    ...optional("repeatIntervalMs", numberOrUndefined(detail?.[2])),
    ...optional("flags", flags === undefined ? undefined : Number.parseInt(flags, 16)),
    ...optional("operation", operation?.slice(0, OPERATION_MAX_LENGTH)),
  };
}

export class AospAlarmDumpParser implements AlarmDumpParser {
  parse(output: string, appId: string): AlarmInfo[] {
    const lines = output.split(/\r?\n/);
    const nowElapsed = numberOrUndefined(NOW_ELAPSED.exec(output)?.[1]);
    const alarms = new Map<string, AlarmInfo>();
    for (let index = 0; index < lines.length; index++) {
      const match = ALARM_LINE.exec(lines[index]);
      if (!match || match[5] !== appId) {
        continue;
      }
      const indent = indentOf(lines[index]);
      const body: string[] = [];
      for (let next = index + 1; next < lines.length; next++) {
        if (lines[next].trim() !== "" && indentOf(lines[next]) <= indent) {
          break;
        }
        body.push(lines[next]);
      }
      // Batches can list the same alarm twice across sections; its hash identifies it.
      alarms.set(match[2], buildAlarm(match, body, nowElapsed));
    }
    return [...alarms.values()];
  }
}

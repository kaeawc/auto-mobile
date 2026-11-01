import { ActionableError } from "../../models/ActionableError";

/**
 * Pure logcat query building and parsing for `getLogs` (#14082): argv construction, `threadtime`
 * line parsing and host-side filtering, kept apart from adb so captured fixtures test it directly.
 */

export const LOGCAT_PRIORITIES = ["V", "D", "I", "W", "E", "F"] as const;
export type LogcatPriority = (typeof LOGCAT_PRIORITIES)[number];

export const LOGCAT_BUFFERS = ["main", "system", "crash", "events"] as const;
export type LogcatBuffer = (typeof LOGCAT_BUFFERS)[number];

export interface LogLine {
  /** `MM-DD HH:MM:SS.mmm` as logcat prints it, in the device's time zone. */
  timestamp: string;
  pid: number;
  tid: number;
  priority: LogcatPriority;
  tag: string;
  message: string;
}

const TAG_SPEC = /^[A-Za-z0-9_.$\-/]+(?::[VDIWEFS])?$/;

/**
 * Logcat filterspecs: each `tags` entry is `tag` or `tag:P`; with tags, everything else is
 * silenced (`*:S`); without, `*:<minPriority>`.
 */
export function logcatFilterSpecs(
  tags: readonly string[] | undefined,
  minPriority: LogcatPriority,
): string[] {
  if (!tags || tags.length === 0) {
    return [`*:${minPriority}`];
  }
  for (const tag of tags) {
    if (!TAG_SPEC.test(tag)) {
      throw new ActionableError(
        `Invalid logcat tag spec "${tag}": use "Tag" or "Tag:P" with P one of V D I W E F S.`,
      );
    }
  }
  return [...tags.map((tag) => (tag.includes(":") ? tag : `${tag}:${minPriority}`)), "*:S"];
}

export interface LogcatQuery {
  buffers: readonly LogcatBuffer[];
  /** Lines from this many seconds before the device's current time. */
  sinceSeconds: number;
  filterSpecs: readonly string[];
  /** Android 11+: every process of this uid, including ones that have died. */
  uid?: number;
}

/**
 * One `adb shell` command line: `-T` takes the device's own clock (no host skew), `-v threadtime`
 * keeps pid/tid/priority/tag parseable, and every caller-derived token is validated or numeric.
 */
export function logcatShellCommand(query: LogcatQuery): string {
  const since = Math.max(1, Math.ceil(query.sinceSeconds));
  return [
    "logcat",
    "-d",
    "-v",
    "threadtime",
    ...query.buffers.flatMap((buffer) => ["-b", buffer]),
    "-T",
    `"$(( $(date +%s) - ${since} )).000"`,
    ...(query.uid === undefined ? [] : [`--uid=${query.uid}`]),
    ...query.filterSpecs.map((spec) => `'${spec}'`),
  ].join(" ");
}

// 10-21 08:15:30.123  1234  5678 E AndroidRuntime: FATAL EXCEPTION: main
const THREADTIME =
  /^(\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+(.*?)\s*: (.*)$/;

/** Parse `-v threadtime` output; buffer separators and unparseable lines are dropped. */
export function parseThreadtime(text: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split("\n")) {
    const match = THREADTIME.exec(raw.replace(/\r$/, ""));
    if (!match) {
      continue;
    }
    lines.push({
      timestamp: match[1]!,
      pid: Number(match[2]),
      tid: Number(match[3]),
      priority: match[4] as LogcatPriority,
      tag: match[5]!,
      message: match[6]!,
    });
  }
  return lines;
}

export function compileGrep(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) {
    return undefined;
  }
  try {
    return new RegExp(pattern);
  } catch (error) {
    throw new ActionableError(`Invalid grep regular expression: ${(error as Error).message}`);
  }
}

export function matchesGrep(line: LogLine, grep: RegExp | undefined): boolean {
  return grep === undefined || grep.test(`${line.tag}: ${line.message}`);
}

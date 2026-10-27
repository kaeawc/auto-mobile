/**
 * Turn a transcript audit plus run metadata into a verdict and baseline comparison.
 *
 * The verdict answers "did the agent do the task?" from hard signals only: the
 * process exit, the stream's `result` event, the MCP server connecting, and the
 * suite's `verify` checks (final-answer text and an independent post-run screen
 * dump). Baselines are comparison data, never gates: metric and tool-sequence
 * deltas are reported but never change the verdict.
 */
import toolDefinitions from "../../schemas/tool-definitions.json";
import type { SuiteBaseline } from "./config";
import type { TranscriptAudit } from "./transcript";

/**
 * Tools the server registers as device-aware (`requiresDevice`). Registration adds the
 * device-targeting `device` label to exactly those schemas, and the committed
 * `schemas/tool-definitions.json` is generated from the live registry. Control and inventory
 * tools (setToolEnabled, listDevices) lack it, so they never count as using the device.
 */
const DEVICE_TOOLS: ReadonlySet<string> = new Set(
  (toolDefinitions as { name: string; inputSchema?: { properties?: object } }[])
    .filter((tool) => "device" in (tool.inputSchema?.properties ?? {}))
    .map((tool) => tool.name),
);

export function isDeviceTool(name: string): boolean {
  return DEVICE_TOOLS.has(name);
}

export type Verdict = "passed" | "failed" | "incomplete";

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface MetricRow {
  name: string;
  actual: number;
  baseline?: number;
  delta?: number;
}

export interface SequenceDiffLine {
  kind: "same" | "missing" | "extra";
  tool: string;
  baselineIndex?: number;
  actualIndex?: number;
}

export interface RunOutcome {
  claudeExitCode: number | null;
  timedOut: boolean;
  wallClockSeconds: number;
  /** Text of the post-run screen dump, when the suite asks for screen checks. */
  screenText?: string;
  /** Why the screen dump could not be taken, when it failed. */
  screenError?: string;
}

export interface Comparison {
  verdict: Verdict;
  checks: CheckResult[];
  metrics: MetricRow[];
  toolRows: MetricRow[];
  sequenceDiff?: { missing: number; extra: number; lines: SequenceDiffLine[] };
  stumbles: number;
  /** Set when the baseline records the app build it was measured against. */
  appBuild?: FingerprintCheck;
  /** Set when the baseline records the AutoMobile server bundle it was measured against. */
  serverBuild?: FingerprintCheck;
  /** Set when the baseline records the suite definition it was measured with. */
  suiteDigest?: FingerprintCheck;
  /** Set when the baseline records the model Claude reported running. */
  observedModel?: FingerprintCheck;
  /** Set when the baseline records the Claude Code version. */
  claudeCodeVersion?: FingerprintCheck;
  /** Set when the baseline records the device environment. */
  deviceFingerprint?: FingerprintCheck;
}

export interface FingerprintCheck {
  baseline: string;
  current: string;
  matches: boolean;
}

/** What this run was measured against, checked against the baseline's record of the same. */
export interface RunFingerprints {
  appBuild?: string;
  serverBuild?: string;
  suiteDigest?: string;
  claudeCodeVersion?: string;
  deviceFingerprint?: string;
}

function fingerprintCheck(
  baseline: string | undefined,
  current: string | undefined,
): FingerprintCheck | undefined {
  // An unreadable fingerprint ("unknown") proves nothing, so it never counts as a match.
  return baseline
    ? {
        baseline,
        current: current ?? "unknown",
        matches: baseline === current && baseline !== "unknown",
      }
    : undefined;
}

export interface VerifySpec {
  answerIncludes: string[];
  screenIncludes: string[];
}

function lcsTable(baseline: string[], actual: string[]): number[][] {
  const table = Array.from({ length: baseline.length + 1 }, () =>
    new Array<number>(actual.length + 1).fill(0),
  );
  for (let i = baseline.length - 1; i >= 0; i--) {
    for (let j = actual.length - 1; j >= 0; j--) {
      table[i][j] =
        baseline[i] === actual[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** Longest-common-subsequence diff; `missing` = baseline-only, `extra` = actual-only. */
export function diffToolSequence(baseline: string[], actual: string[]): SequenceDiffLine[] {
  const table = lcsTable(baseline, actual);
  const lines: SequenceDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < baseline.length || j < actual.length) {
    if (i < baseline.length && j < actual.length && baseline[i] === actual[j]) {
      lines.push({ kind: "same", tool: baseline[i], baselineIndex: i, actualIndex: j });
      i++;
      j++;
    } else if (j < actual.length && (i >= baseline.length || table[i][j + 1] >= table[i + 1][j])) {
      lines.push({ kind: "extra", tool: actual[j], actualIndex: j });
      j++;
    } else {
      lines.push({ kind: "missing", tool: baseline[i], baselineIndex: i });
      i++;
    }
  }
  return lines;
}

function row(name: string, actual: number, baseline: number | undefined): MetricRow {
  return baseline === undefined
    ? { name, actual }
    : // toFixed rounds without multiplying, so a huge finite delta cannot overflow to Infinity.
      { name, actual, baseline, delta: Number((actual - baseline).toFixed(4)) };
}

function buildMetrics(audit: TranscriptAudit, outcome: RunOutcome, baseline?: SuiteBaseline) {
  const metrics: MetricRow[] = [
    row("totalToolCalls", audit.totalToolCalls, baseline?.totalToolCalls),
    row("mcpToolCalls", audit.mcpToolCalls, baseline?.mcpToolCalls),
    row("toolErrors", audit.toolErrors, baseline?.toolErrors),
    row("wallClockSeconds", outcome.wallClockSeconds, baseline?.wallClockSeconds),
  ];
  if (audit.result?.numTurns !== undefined) {
    metrics.push(row("numTurns", audit.result.numTurns, baseline?.numTurns));
  }
  if (audit.result?.costUsd !== undefined) {
    metrics.push(row("costUsd", audit.result.costUsd, baseline?.costUsd));
  }
  const toolNames = [
    ...new Set([...Object.keys(audit.toolCounts), ...Object.keys(baseline?.tools ?? {})]),
  ].sort();
  const toolRows = toolNames.map((name) =>
    row(
      name,
      audit.toolCounts[name] ?? 0,
      baseline?.tools ? (baseline.tools[name] ?? 0) : undefined,
    ),
  );
  return { metrics, toolRows };
}

function processChecks(audit: TranscriptAudit, outcome: RunOutcome): CheckResult[] {
  const result = audit.result;
  return [
    {
      name: "claude exited",
      passed: !outcome.timedOut && outcome.claudeExitCode === 0,
      detail: outcome.timedOut ? "timed out" : `exit ${String(outcome.claudeExitCode)}`,
    },
    {
      name: "mcp server connected",
      passed: audit.mcpServerStatus === "connected",
      detail: audit.mcpServerStatus ?? "no system/init event",
    },
    {
      name: "result event",
      passed: result !== undefined && result.subtype === "success" && !result.isError,
      detail: result ? `${result.subtype}${result.isError ? " (is_error)" : ""}` : "missing",
    },
    {
      name: "transcript parsed",
      passed: audit.parseErrors.length === 0,
      detail: audit.parseErrors.length === 0 ? "ok" : `${audit.parseErrors.length} bad line(s)`,
    },
  ];
}

/**
 * Case-insensitive match that must not continue into a letter or digit on either
 * side, so `EXPECTED_COUNT: 3` does not match `EXPECTED_COUNT: 30`.
 */
/**
 * Characters that join digits into one value: decimal and grouping marks (ASCII and
 * Arabic U+066B/U+066C), fraction slashes (/ and U+2044), and range, subtraction, or ratio
 * marks (-, U+2013 en dash, U+2014 em dash, U+2212 minus, and :), so 3 is not inside 3-4,
 * 3−4, or 3:4.
 */
const NUMBER_JOINERS = "[.,/\u2044\u066B\u066C\\-\u2013\u2014\u2212:]";

/**
 * Locale digit-grouping separators (space, no-break space U+00A0, narrow no-break space
 * U+202F, thin space U+2009, apostrophe, and U+2019) that are a different number only when
 * a three-digit group follows, as in 3 000 or 3'000; 3 items is still 3.
 */
const DIGIT_GROUPING = "[ \u00A0\u202F\u2009'\u2019]";

export function containsBounded(haystack: string, needle: string): boolean {
  // Unicode letters, digits, and combining marks bound a match, so 完了 does not match
  // inside 未完了, COUNT: 3 not inside COUNT: 30, and Cafe not inside a decomposed Café.
  // A decimal, grouped, or fractional continuation (3.5, 3,000, 3/4) is a different number,
  // so a joiner next to a digit does not bound a match on either side (3 items is not
  // inside 0.3 items or 1,300 items). A needle that starts with a digit also rejects a leading sign, which
  // would make it the opposite number (-3 items).
  const signed = /^\p{N}/u.test(needle) ? "|[+\\-\u2212]" : "";
  // A needle that ends in a digit continues into a grouped number when a grouping mark and
  // a whole three-digit group follow (COUNT: 3 000), so that does not bound it either.
  const trailingGroup = /\p{N}$/u.test(needle) ? `|${DIGIT_GROUPING}\\p{N}{3}(?!\\p{N})` : "";
  // A needle that starts with a three-digit group can be the tail of a grouped number
  // (300 users inside 1 300 users), so a digit and grouping mark before it does not bound it.
  const grouped = /^\p{N}{3}(?!\p{N})/u.test(needle) ? `|\\p{N}${DIGIT_GROUPING}` : "";
  // Canonically equivalent text (precomposed é vs e + U+0301) must compare equal, so both
  // sides use NFC before matching.
  return new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}]|\\p{N}${NUMBER_JOINERS}${signed}${grouped})${RegExp.escape(needle.normalize("NFC"))}(?![\\p{L}\\p{N}\\p{M}]|${NUMBER_JOINERS}\\p{N}${trailingGroup})`,
    "iu",
  ).test(haystack.normalize("NFC"));
}

function missingFrom(haystack: string, needles: string[]): string[] {
  return needles.filter((needle) => !containsBounded(haystack, needle));
}

/**
 * A `KEY: value` report line, as the prompts ask the agent to end with. Matching is
 * case-insensitive like the rest of the answer check, so `count: 3` is a report line too.
 */
const KEYED_NEEDLE = /^[A-Z][A-Z0-9_]*:/i;

/** A Markdown code fence line (```, ```text), which frames the report lines. */
const FENCE_LINE = /^(`{3,}|~{3,})[\w-]*$/;

/**
 * One report line compared loosely: NFC, case, runs of whitespace, inline backticks, and one
 * trailing period (the UX flow's screen text ends with one) do not matter.
 */
function normalizeReportLine(line: string): string {
  return (
    line
      .normalize("NFC")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.$/, "")
      .replace(/^`+|`+$/g, "")
      .trim()
      // Again, for a period inside the backticks (`COUNT: 3.`); outside them it went above.
      .replace(/\.$/, "")
      .toLowerCase()
  );
}

/**
 * Expected answer text the final answer lacks. The prompts ask the agent to finish with exactly
 * the `KEY: value` lines, so those needles must be the reply's last nonblank lines (fences
 * aside), in the suite's order, each equal to its needle: an echoed value followed by a
 * different one, extra text on the line (`EXPECTED_COUNT: 3 or 99`), or a disclaimer after the
 * lines all fail. Other needles search the whole answer.
 */
export function missingFromAnswer(answer: string, needles: string[]): string[] {
  const keyed = needles.filter((needle) => KEYED_NEEDLE.test(needle));
  const lines = answer
    .split(/\r?\n/)
    .map(normalizeReportLine)
    .filter((line) => line !== "" && !FENCE_LINE.test(line));
  const tail = keyed.length === 0 ? [] : lines.slice(-keyed.length);
  // Matched by position, so a repeated key (DISPLAYED_COUNT: 2 then DISPLAYED_COUNT: 3) fails
  // and a needle listed twice must appear on two lines.
  const offset = tail.length - keyed.length;
  let position = offset;
  return needles.filter((needle) => {
    if (!KEYED_NEEDLE.test(needle)) {
      return !containsBounded(answer, needle);
    }
    const line = tail[position];
    position += 1;
    return line !== normalizeReportLine(needle);
  });
}

function verifyChecks(audit: TranscriptAudit, outcome: RunOutcome, verify: VerifySpec) {
  // A UI benchmark that never touched the device proved nothing, whatever it answered; a
  // call that errored (bad arguments, refused) did not touch it either, and neither does a
  // tool that is not device-aware (listDevices, setToolEnabled).
  const succeeded = audit.toolCalls.filter(
    (call) => call.isMcp && call.hasResult && !call.isError && isDeviceTool(call.shortName),
  ).length;
  const checks: CheckResult[] = [
    {
      name: "used the device",
      passed: succeeded > 0,
      detail:
        succeeded > 0
          ? `${succeeded} successful auto-mobile tool call(s)`
          : "no successful auto-mobile tool calls",
    },
  ];
  if (verify.answerIncludes.length > 0) {
    const missing = missingFromAnswer(audit.result?.finalText ?? "", verify.answerIncludes);
    checks.push({
      name: "final answer",
      passed: missing.length === 0,
      detail: missing.length === 0 ? "all expected text present" : `missing: ${missing.join(", ")}`,
    });
  }
  if (verify.screenIncludes.length > 0) {
    const missing = missingFrom(outcome.screenText ?? "", verify.screenIncludes);
    const passed = outcome.screenText !== undefined && missing.length === 0;
    checks.push({
      name: "device screen",
      passed,
      detail:
        outcome.screenText === undefined
          ? `no screen dump (${outcome.screenError ?? "not captured"})`
          : passed
            ? "all expected text on screen"
            : `missing: ${missing.join(", ")}`,
    });
  }
  return checks;
}

export function compareRun(
  audit: TranscriptAudit,
  outcome: RunOutcome,
  verify: VerifySpec,
  baseline?: SuiteBaseline,
  baselineToolSequence?: string[],
  fingerprints: RunFingerprints = {},
): Comparison {
  const lifecycle = processChecks(audit, outcome);
  const verification = verifyChecks(audit, outcome, verify);
  const verdict: Verdict = lifecycle.some((check) => !check.passed)
    ? "incomplete"
    : verification.some((check) => !check.passed)
      ? "failed"
      : "passed";
  const { metrics, toolRows } = buildMetrics(audit, outcome, baseline);
  const actualSequence = audit.toolCalls.filter((call) => !call.isSubagent).map((c) => c.shortName);
  const lines = baselineToolSequence
    ? diffToolSequence(baselineToolSequence, actualSequence)
    : undefined;
  return {
    verdict,
    checks: [...lifecycle, ...verification],
    metrics,
    toolRows,
    sequenceDiff: lines && {
      missing: lines.filter((line) => line.kind === "missing").length,
      extra: lines.filter((line) => line.kind === "extra").length,
      lines,
    },
    // A call that never got a result is unaccounted for (a damaged stream or wrapper), so it
    // counts as a stumble rather than letting the run look clean.
    stumbles:
      audit.toolErrors +
      audit.patternMatches.length +
      audit.permissionDenials.length +
      audit.toolCalls.filter((call) => !call.hasResult).length,
    appBuild: fingerprintCheck(baseline?.appBuild, fingerprints.appBuild),
    serverBuild: fingerprintCheck(baseline?.serverBuild, fingerprints.serverBuild),
    suiteDigest: fingerprintCheck(baseline?.suiteDigest, fingerprints.suiteDigest),
    observedModel: fingerprintCheck(baseline?.observedModel, audit.observedModel),
    claudeCodeVersion: fingerprintCheck(
      baseline?.claudeCodeVersion,
      fingerprints.claudeCodeVersion,
    ),
    deviceFingerprint: fingerprintCheck(
      baseline?.deviceFingerprint,
      fingerprints.deviceFingerprint,
    ),
  };
}

/**
 * Turn a transcript audit plus run metadata into a verdict and baseline comparison.
 *
 * The verdict answers "did the agent do the task?" from hard signals only: the
 * process exit, the stream's `result` event, the MCP server connecting, and the
 * suite's `verify` checks (final-answer text and an independent post-run screen
 * dump). Baselines are comparison data, never gates: metric and tool-sequence
 * deltas are reported but never change the verdict.
 */
import type { SuiteBaseline } from "./config";
import type { TranscriptAudit } from "./transcript";

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
  /** Set when the baseline records the suite definition it was measured with. */
  suiteDigest?: FingerprintCheck;
  /** Set when the baseline records the model Claude reported running. */
  observedModel?: FingerprintCheck;
  /** Set when the baseline records the Claude Code version. */
  claudeCodeVersion?: FingerprintCheck;
}

export interface FingerprintCheck {
  baseline: string;
  current: string;
  matches: boolean;
}

/** What this run was measured against, checked against the baseline's record of the same. */
export interface RunFingerprints {
  appBuild?: string;
  suiteDigest?: string;
  claudeCodeVersion?: string;
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
    : { name, actual, baseline, delta: Math.round((actual - baseline) * 10_000) / 10_000 };
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
export function containsBounded(haystack: string, needle: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${RegExp.escape(needle)}(?![A-Za-z0-9])`, "i").test(haystack);
}

function missingFrom(haystack: string, needles: string[]): string[] {
  return needles.filter((needle) => !containsBounded(haystack, needle));
}

function verifyChecks(audit: TranscriptAudit, outcome: RunOutcome, verify: VerifySpec) {
  const checks: CheckResult[] = [];
  if (verify.answerIncludes.length > 0) {
    const missing = missingFrom(audit.result?.finalText ?? "", verify.answerIncludes);
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
    stumbles: audit.toolErrors + audit.patternMatches.length + audit.permissionDenials.length,
    appBuild: fingerprintCheck(baseline?.appBuild, fingerprints.appBuild),
    suiteDigest: fingerprintCheck(baseline?.suiteDigest, fingerprints.suiteDigest),
    observedModel: fingerprintCheck(baseline?.observedModel, audit.observedModel),
    claudeCodeVersion: fingerprintCheck(
      baseline?.claudeCodeVersion,
      fingerprints.claudeCodeVersion,
    ),
  };
}

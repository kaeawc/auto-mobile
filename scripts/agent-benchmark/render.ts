/**
 * Plain-text rendering for agent benchmark results. Output is the same with or
 * without a TTY so it pastes cleanly into issues and PRs; `--json` is the
 * machine-readable form.
 */
import { dump } from "js-yaml";
import type { MetricRow, SequenceDiffLine } from "./compare";
import type { BenchmarkResult } from "./result";

const RULE = "─".repeat(72);
const DOUBLE_RULE = "═".repeat(72);
const MAX_LISTED_STUMBLES = 5;
const SEQUENCE_CONTEXT = 1;

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds - minutes * 60).toFixed(1);
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/** Dollar amounts are often fractions of a cent, so they keep four decimals. */
const FOUR_DECIMAL_METRICS = new Set(["costUsd"]);

function formatNumber(value: number | undefined, digits = 2): string {
  if (value === undefined) {
    return "-";
  }
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function formatDelta(value: number | undefined, digits = 2): string {
  if (value === undefined) {
    return "-";
  }
  return value > 0 ? `+${formatNumber(value, digits)}` : formatNumber(value, digits);
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((cells) => cells[index].length)),
  );
  const render = (cells: string[]) =>
    `  ${cells
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
      )
      .join("  ")}`;
  return [render(header), ...rows.map(render)];
}

function metricTable(title: string, rows: MetricRow[]): string[] {
  if (rows.length === 0) {
    return [];
  }
  return [
    "",
    title,
    ...table(
      ["NAME", "ACTUAL", "BASELINE", "DELTA"],
      rows.map((metric) => {
        const digits = FOUR_DECIMAL_METRICS.has(metric.name) ? 4 : 2;
        return [
          metric.name,
          formatNumber(metric.actual, digits),
          formatNumber(metric.baseline, digits),
          formatDelta(metric.delta, digits),
        ];
      }),
    ),
  ];
}

/** Keep changed lines plus a little context; collapse long unchanged runs. */
export function visibleSequenceLines(lines: SequenceDiffLine[]): SequenceDiffLine[] {
  const changed = lines.map((line) => line.kind !== "same");
  return lines.filter((_, index) =>
    changed
      .slice(Math.max(0, index - SEQUENCE_CONTEXT), index + SEQUENCE_CONTEXT + 1)
      .some(Boolean),
  );
}

function sequenceSection(result: BenchmarkResult): string[] {
  const diff = result.comparison.sequenceDiff;
  if (!diff) {
    return [];
  }
  if (diff.missing === 0 && diff.extra === 0) {
    return ["", "Tool sequence matches baseline"];
  }
  const marker = { same: " ", missing: "−", extra: "+" } as const;
  return [
    "",
    `Tool sequence: ${diff.missing} missing from baseline, ${diff.extra} additional`,
    ...visibleSequenceLines(diff.lines).map(
      (line) =>
        `  ${String(line.baselineIndex ?? "").padStart(4)} ${String(line.actualIndex ?? "").padStart(4)} ${marker[line.kind]} ${line.tool}`,
    ),
  ];
}

function stumbleSection(result: BenchmarkResult): string[] {
  const { audit, comparison } = result;
  if (comparison.stumbles === 0) {
    return ["", "Stumbles: 0"];
  }
  const errors = audit.toolCalls
    .filter((call) => call.isError && !call.errorIgnored)
    .slice(0, MAX_LISTED_STUMBLES)
    .map((call) => `  • ${call.shortName} @ line ${call.line}: ${call.resultText.split("\n")[0]}`);
  const patterns = audit.patternMatches
    .slice(0, MAX_LISTED_STUMBLES)
    .map((match) => `  • pattern ${match.pattern} in ${match.tool} @ line ${match.line}`);
  const denials = audit.permissionDenials.map((tool) => `  • permission denied: ${tool}`);
  const unfinished = audit.toolCalls
    .filter((call) => !call.hasResult)
    .slice(0, MAX_LISTED_STUMBLES)
    .map((call) => `  • ${call.shortName} @ line ${call.line}: no result`);
  return [
    "",
    `Stumbles: ${comparison.stumbles}`,
    ...errors,
    ...patterns,
    ...denials,
    ...unfinished,
  ];
}

function baselineWarnings(comparison: BenchmarkResult["comparison"]): string[] {
  const {
    appBuild,
    serverBuild,
    suiteDigest,
    observedModel,
    claudeCodeVersion,
    deviceFingerprint,
  } = comparison;
  return [
    ...(appBuild && !appBuild.matches
      ? [`  ! baseline was recorded on ${appBuild.baseline}; deltas compare different app builds`]
      : []),
    ...(serverBuild && !serverBuild.matches
      ? [
          `  ! baseline was recorded with AutoMobile server ${serverBuild.baseline}; this run used ${serverBuild.current}`,
        ]
      : []),
    ...(suiteDigest && !suiteDigest.matches
      ? [
          "  ! baseline was recorded with a different prompt or suite settings; deltas may not be comparable",
        ]
      : []),
    ...(deviceFingerprint && !deviceFingerprint.matches
      ? [
          `  ! baseline was recorded on a different device (${deviceFingerprint.baseline}); deltas may not be comparable`,
        ]
      : []),
    ...(claudeCodeVersion && !claudeCodeVersion.matches
      ? [
          `  ! baseline was recorded with Claude Code ${claudeCodeVersion.baseline}; this run used ${claudeCodeVersion.current}`,
        ]
      : []),
    ...(observedModel && !observedModel.matches
      ? [
          `  ! baseline was recorded on model ${observedModel.baseline}; this run used ${observedModel.current}`,
        ]
      : []),
  ];
}

export function renderReport(result: BenchmarkResult): string {
  const { comparison, outcome } = result;
  const model = result.claude.observedModel ?? result.claude.requestedModel ?? "default";
  const lines = [
    RULE,
    `${comparison.verdict.toUpperCase()}  ${result.suite}  ${formatDuration(outcome.wallClockSeconds)}`,
    `  device    ${result.deviceSerial} (preflight ${formatDuration(result.preflight.durationSeconds)}, not measured)`,
    `  app       ${result.preflight.appBuild ?? "unknown"}`,
    `  server    ${result.serverBuild ?? "unknown"}`,
    `  env       ${result.preflight.device ?? "unknown"}`,
    ...baselineWarnings(comparison),
    `  claude    model=${model} version=${result.claude.version ?? "unknown"}`,
    `  artifacts ${result.runDirectory}`,
    "",
    "Checks",
    ...comparison.checks.map(
      (check) => `  ${check.passed ? "✓" : "✗"} ${check.name.padEnd(22)} ${check.detail}`,
    ),
    ...metricTable("Metrics", comparison.metrics),
    ...metricTable("Tool calls", comparison.toolRows),
    ...sequenceSection(result),
    ...stumbleSection(result),
  ];
  if (comparison.verdict !== "passed") {
    lines.push(
      "",
      "Inspect",
      `  transcript ${result.runDirectory}/claude.jsonl`,
      `  stderr     ${result.runDirectory}/claude.stderr`,
      `  logs       ${result.runDirectory}/logs`,
    );
  }
  return lines.join("\n");
}

export function renderSummary(results: BenchmarkResult[]): string {
  const passed = results.filter((result) => result.comparison.verdict === "passed").length;
  const total = results.reduce((sum, result) => sum + result.outcome.wallClockSeconds, 0);
  return [
    DOUBLE_RULE,
    `  Agent benchmarks: ${results.length} run · ${passed} passed · ${results.length - passed} not passed`,
    `  Measured time: ${formatDuration(total)}`,
    ...results.map((result) => {
      const diff = result.comparison.sequenceDiff;
      const sequence = diff ? ` · sequence ${diff.missing}m/${diff.extra}a` : "";
      return `  ${result.comparison.verdict.padEnd(10)} ${result.suite.padEnd(24)} ${formatDuration(result.outcome.wallClockSeconds).padStart(9)} · ${result.comparison.stumbles} stumble(s)${sequence}`;
    }),
    DOUBLE_RULE,
  ].join("\n");
}

/**
 * YAML for the suite's `baseline` and `baselineToolSequence` blocks from this run.
 * Only meaningful for a clean passing run; the harness writes it only then.
 */
export function renderBaselineSnippet(result: BenchmarkResult): string {
  const { audit, outcome } = result;
  const baseline: Record<string, unknown> = {
    totalToolCalls: audit.totalToolCalls,
    mcpToolCalls: audit.mcpToolCalls,
    toolErrors: audit.toolErrors,
    wallClockSeconds: Math.round(outcome.wallClockSeconds * 100) / 100,
  };
  if (audit.result?.numTurns !== undefined) {
    baseline.numTurns = audit.result.numTurns;
  }
  if (audit.result?.costUsd !== undefined) {
    // toFixed rounds without multiplying, so a huge finite cost cannot overflow to Infinity.
    baseline.costUsd = Number(audit.result.costUsd.toFixed(4));
  }
  baseline.tools = audit.toolCounts;
  // An unreadable build fingerprint would make every later "unknown" look like a match.
  if (result.preflight.appBuild !== "unknown") {
    baseline.appBuild = result.preflight.appBuild;
  }
  baseline.serverBuild = result.serverBuild;
  baseline.suiteDigest = result.suiteDigest;
  if (audit.observedModel) {
    baseline.observedModel = audit.observedModel;
  }
  if (result.claude.version) {
    baseline.claudeCodeVersion = result.claude.version;
  }
  if (result.preflight.device !== "unknown") {
    baseline.deviceFingerprint = result.preflight.device;
  }
  return dump(
    {
      baseline,
      baselineToolSequence: audit.toolCalls
        .filter((call) => !call.isSubagent)
        .map((call) => call.shortName),
    },
    { lineWidth: 100 },
  );
}

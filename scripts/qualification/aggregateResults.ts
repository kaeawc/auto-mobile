#!/usr/bin/env bun
/** Usage: bun run qualify:aggregate --results <dir> [--identity <file>] [--markdown <out>] [--require-pass] */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod/v4";
import { shellQuoteUnlessSafe } from "../../src/utils/shellQuote";
import { UsageError, type ArtifactIdentityRecord } from "./artifactIdentity";
import { parseCaseResult, type CaseResult } from "./caseResult";

export interface AggregateInput {
  files: Array<{ name: string; text: string }>;
  identity: ArtifactIdentityRecord | null;
}
export interface AggregateReport {
  results: CaseResult[];
  errors: Array<{ file: string; message: string }>;
  warnings: string[];
  counts: Record<"android" | "ios" | "host", Record<CaseResult["outcome"], number>>;
  markdown: string;
}
const platforms = ["android", "host", "ios"] as const;
const outcomes = ["pass", "fail", "blocked", "not-exercised"] as const;
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function cell(value: string | number | null): string {
  return String(value ?? "—")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, "<br>");
}
function code(value: string): string {
  const delimiter = "`".repeat(
    Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length)) + 1,
  );
  return `${delimiter} ${value} ${delimiter}`;
}
function table(headers: string[], rows: Array<Array<string | number | null>>): string {
  return [headers, headers.map(() => "---"), ...rows]
    .map((row) => `| ${row.map(cell).join(" | ")} |`)
    .join("\n");
}
function caseSection(title: string, results: CaseResult[], boundary = false): string {
  const headers = [
    "Case",
    "Matrix item",
    "Outcome",
    "Duration (ms)",
    "Failure code",
    "Command",
    "Evidence count",
    ...(boundary ? ["Boundary"] : []),
  ];
  const rows = results.map((result) => [
    `${result.platform}.${result.caseId}`,
    result.matrixItem,
    result.outcome,
    result.timings.durationMs,
    result.failureCode,
    code(result.command.argv.map(shellQuoteUnlessSafe).join(" ")),
    result.evidence.length,
    ...(boundary ? [result.boundary] : []),
  ]);
  return `## ${title}\n\n${rows.length ? table(headers, rows) : "None."}`;
}
function render(report: AggregateReport, identity: ArtifactIdentityRecord | null): string {
  const artifact = identity
    ? `## Artifact\n\n${table(
        ["Field", "Value"],
        [
          ["Version", identity.package.version],
          ["Source SHA", identity.source.sha],
          ["Source evidence", identity.source.evidence],
          ["Integrity", identity.tarball?.integrity ?? null],
          ["Proof level", identity.proofLevel],
          ["Identity verdict", identity.verdict],
        ],
      )}`
    : "No artifact identity supplied — results are not bound to an artifact.";
  const exercised = report.results.filter(
    (result) => result.outcome !== "blocked" && result.outcome !== "not-exercised",
  );
  const sections = [
    "# Managed-slot qualification summary",
    artifact,
    `## Totals\n\n${table(
      ["Platform", ...outcomes],
      platforms.map((platform) => [
        platform,
        ...outcomes.map((outcome) => report.counts[platform][outcome]),
      ]),
    )}`,
    caseSection(
      "Native observations",
      exercised.filter((result) => result.observation.kind === "native"),
    ),
    caseSection(
      "Injected faults (not native observations)",
      exercised.filter((result) => result.observation.kind === "injected-fault"),
    ),
    caseSection(
      "Deterministic tests",
      exercised.filter((result) => result.observation.kind === "deterministic-test"),
    ),
    caseSection(
      "Not exercised and blocked",
      report.results.filter(
        (result) => result.outcome === "blocked" || result.outcome === "not-exercised",
      ),
      true,
    ),
  ];
  if (report.errors.length) {
    sections.push(
      `## Validation errors\n\n${table(
        ["File", "Error"],
        report.errors.map((error) => [error.file, error.message]),
      )}`,
    );
  }
  if (report.warnings.length) {
    sections.push(
      `## Warnings\n\n${report.warnings.map((warning) => `- ${cell(warning)}`).join("\n")}`,
    );
  }
  return `${sections.join("\n\n")}\n`;
}

function checkIdentity(
  result: CaseResult,
  file: string,
  identity: ArtifactIdentityRecord,
  report: AggregateReport,
): void {
  const expected = {
    packageVersion: identity.package.version,
    sourceSha: identity.source.sha,
    integrity: identity.tarball?.integrity ?? null,
  };
  for (const key of ["packageVersion", "sourceSha", "integrity"] as const) {
    if (result.artifact[key] === null) {
      report.warnings.push(`${file}: artifact.${key} is null; artifact binding is incomplete`);
    } else if (result.artifact[key] !== expected[key]) {
      report.errors.push({
        file,
        message: `Mixed artifacts: artifact.${key} differs from identity`,
      });
    }
  }
  if (result.proofLevel === "published-package" && identity.proofLevel !== "published-package") {
    report.errors.push({
      file,
      message: "published-package result requires a published-package identity",
    });
  }
}
export function aggregateResults(input: AggregateInput): AggregateReport {
  const empty = () => ({ pass: 0, fail: 0, blocked: 0, "not-exercised": 0 });
  const report: AggregateReport = {
    results: [],
    errors: [],
    warnings: [],
    counts: { android: empty(), ios: empty(), host: empty() },
    markdown: "",
  };
  if (input.identity?.verdict === "refused") {
    report.errors.push({ file: "identity", message: "Artifact identity verdict is refused" });
  }
  const seen = new Set<string>();
  for (const file of [...input.files].sort((a, b) => compare(a.name, b.name))) {
    let result: CaseResult;
    try {
      result = parseCaseResult(JSON.parse(file.text));
    } catch (error) {
      const message =
        error instanceof z.ZodError
          ? error.issues
              .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
              .join("; ")
          : error instanceof Error
            ? error.message
            : String(error);
      report.errors.push({ file: file.name, message });
      continue;
    }
    const key = `${result.platform}:${result.caseId}`;
    if (seen.has(key)) {
      report.errors.push({
        file: file.name,
        message: `Duplicate case (${result.platform}, ${result.caseId})`,
      });
      continue;
    }
    seen.add(key);
    if (input.identity) {
      checkIdentity(result, file.name, input.identity, report);
    }
    for (const operation of result.timings.operations) {
      if (operation.budgetMs !== null && operation.durationMs > operation.budgetMs) {
        report.warnings.push(
          `${file.name}: ${operation.name} over budget (${operation.durationMs}ms > ${operation.budgetMs}ms)`,
        );
      }
    }
    report.results.push(result);
    report.counts[result.platform][result.outcome]++;
  }
  report.results.sort((a, b) => compare(a.platform, b.platform) || compare(a.caseId, b.caseId));
  report.markdown = render(report, input.identity);
  return report;
}

export function aggregateExitCode(report: AggregateReport, requirePass: boolean): number {
  return report.errors.length ||
    (requirePass &&
      report.results.some((result) => result.outcome === "fail" || result.outcome === "blocked"))
    ? 1
    : 0;
}
export function parseAggregateArgs(argv: readonly string[]) {
  try {
    const { values } = parseArgs({
      args: [...argv],
      allowPositionals: false,
      options: {
        results: { type: "string" },
        identity: { type: "string" },
        markdown: { type: "string" },
        "require-pass": { type: "boolean" },
      },
    });
    if (!values.results) {
      throw new UsageError("--results is required");
    }
    return {
      results: values.results,
      identity: values.identity,
      markdown: values.markdown,
      requirePass: values["require-pass"] ?? false,
    };
  } catch (error) {
    throw new UsageError(
      `Invalid aggregate arguments: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
if (import.meta.main) {
  try {
    const options = parseAggregateArgs(process.argv.slice(2));
    const report = aggregateResults({
      files: readdirSync(options.results, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .sort((a, b) => compare(a.name, b.name))
        .map((entry) => ({
          name: entry.name,
          text: readFileSync(join(options.results, entry.name), "utf8"),
        })),
      identity: options.identity
        ? (JSON.parse(readFileSync(options.identity, "utf8")) as ArtifactIdentityRecord)
        : null,
    });
    if (options.markdown) {
      writeFileSync(options.markdown, report.markdown);
    } else {
      process.stdout.write(report.markdown);
    }
    process.exitCode = aggregateExitCode(report, options.requirePass);
  } catch (error) {
    console.error("Aggregate results failed:", error);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

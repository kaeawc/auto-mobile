/**
 * Markdown rendering for the persona robustness report (#14061). The JSON report is the record;
 * this is the human summary.
 */
import { OEM_PERSONAS } from "../../src/features/utility/OemPersonas";
import { isOemPersonaId } from "./matrix";
import { countOutcomes, describeAttribution, firstFailedStep } from "./score";
import type { PerturbationResult, RobustnessReport } from "./harness";

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function runs(result: PerturbationResult): string {
  const counts = countOutcomes(result.runs);
  return (["pass", "recovered", "failed", "error"] as const)
    .filter((outcome) => counts[outcome] > 0)
    .map((outcome) => `${counts[outcome]} ${outcome}`)
    .join(", ");
}

function failingStep(result: PerturbationResult): string {
  const step = firstFailedStep(result.runs);
  if (step) {
    return `#${step.stepIndex} ${step.tool}: ${step.error}`;
  }
  return result.runs.find((run) => run.error)?.error ?? "";
}

function row(result: PerturbationResult): string {
  return `| ${[
    result.id,
    result.facets.join("<br>") || "—",
    `**${result.verdict}**`,
    runs(result),
    failingStep(result),
    describeAttribution(result.attribution),
  ]
    .map(cell)
    .join(" | ")} |`;
}

const HEADER = [
  "| Perturbation | Facets | Verdict | Runs | Failing step | Cause |",
  "| --- | --- | --- | --- | --- | --- |",
];

/** One line per persona facet with its evidence status, so a result is never read as measured. */
function evidenceLines(results: readonly PerturbationResult[]): string[] {
  return results.flatMap(({ id }) =>
    isOemPersonaId(id)
      ? Object.entries(OEM_PERSONAS[id].evidence).map(
          ([facet, evidence]) => `- ${id} ${facet}: ${evidence?.status}`,
        )
      : [],
  );
}

export function renderMarkdown(report: RobustnessReport): string {
  const all = [report.baseline, ...report.results];
  const lines = [
    `# Persona robustness: ${report.planName}`,
    "",
    `App \`${report.appId}\`, persona catalog v${report.personaCatalogVersion}, ` +
      `${report.repeats} replay(s) per perturbation. Baseline: \`${report.baseline.id}\`.`,
    "",
    ...(report.aborted ? [`**Aborted:** ${report.aborted}`, ""] : []),
    ...HEADER,
    ...all.map(row),
  ];
  if (report.ablations.length > 0) {
    lines.push("", "## Facet ablations", "", ...HEADER, ...report.ablations.map(row));
  }
  const evidence = evidenceLines(all);
  if (evidence.length > 0) {
    lines.push(
      "",
      "## Facet evidence",
      "",
      "Personas simulate effects on a stock device; a result is evidence about the app's handling " +
        "of those effects, not about the OEM device.",
      "",
      ...evidence,
    );
  }
  return `${lines.join("\n")}\n`;
}

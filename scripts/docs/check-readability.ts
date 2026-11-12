#!/usr/bin/env bun
//
// Report docs pages that exceed their section's readability budgets (#18145).
//
// Usage: bun scripts/docs/check-readability.ts [--config <file>] [--github] [--strict]
//
// Budgets live in scripts/docs/readability-budgets.json, one entry per docs
// section (using, how-it-works, devlog). Every `.md` file under a section path
// is checked; pages outside every section are skipped. Prints one
// `file:line: rule: message [section]` row per finding and a per-section
// summary. `--github` also emits workflow warning annotations. The check is
// advisory: it exits 0 unless `--strict` is passed and there are findings.
// See scripts/docs/readability.ts for what each rule measures.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import {
  checkPage,
  formatFinding,
  parseConfig,
  sectionFor,
  type Finding,
  type ReadabilityConfig,
} from "./readability";

const ROOT = join(import.meta.dir, "..", "..");
const DEFAULT_CONFIG = join(import.meta.dir, "readability-budgets.json");

export function checkRepository(root: string, config: ReadabilityConfig): Finding[] {
  const files = Array.from(new Glob("docs/**/*.md").scanSync({ cwd: root }))
    .map((file) => file.split("\\").join("/"))
    .sort();
  return files.flatMap((file) => {
    const budget = sectionFor(config, file);
    return budget ? checkPage(file, readFileSync(join(root, file), "utf8"), budget) : [];
  });
}

export function summarize(config: ReadabilityConfig, findings: Finding[]): string[] {
  return config.sections.map((section) => {
    const own = findings.filter((finding) => finding.section === section.name);
    const byRule = Object.entries(Object.groupBy(own, (finding) => finding.rule))
      .map(([rule, list]) => `${rule}=${list?.length ?? 0}`)
      .join(", ");
    return `${section.name}: ${own.length} finding(s)${byRule ? ` (${byRule})` : ""}`;
  });
}

function githubAnnotation(finding: Finding): string {
  const message = `${finding.rule}: ${finding.message}`.replaceAll("%", "%25");
  return `::warning file=${finding.file},line=${finding.line},title=Docs readability::${message}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : DEFAULT_CONFIG;
  if (!configPath) {
    console.error("usage: check-readability.ts [--config <file>] [--github] [--strict]");
    process.exit(2);
  }
  const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const findings = checkRepository(ROOT, config);
  for (const finding of findings) {
    console.log(formatFinding(finding));
  }
  if (args.includes("--github")) {
    for (const finding of findings) {
      console.log(githubAnnotation(finding));
    }
  }
  console.log(`\nDocs readability summary (${findings.length} finding(s)):`);
  for (const row of summarize(config, findings)) {
    console.log(`  ${row}`);
  }
  if (args.includes("--strict") && findings.length > 0) {
    process.exit(1);
  }
}

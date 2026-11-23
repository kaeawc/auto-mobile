#!/usr/bin/env bun
//
// Report docs pages that exceed their section's readability budgets (#18145).
//
// Usage: bun scripts/docs/check-readability.ts [--config <file>] [--github] [--strict]
//        [--files <path>...]
//
// Budgets live in scripts/docs/readability-budgets.json, one entry per docs
// section (using, how-it-works, devlog). Every `.md` file under a section path
// is checked, or only the listed pages with `--files` (every argument after it
// is a repository-relative path; scripts/docs/check-readability-changed.sh
// passes the docs pages a branch changed). Pages outside every section are
// skipped. Prints one
// `file:line: rule: message [section]` row per finding and a per-section
// summary. `--github` also emits workflow annotations: errors for findings in
// a section marked `"enforced": true` (already clean on main), warnings for the
// rest. It exits 1 when an enforced section has findings, or on any finding
// with `--strict`; findings in other sections are advisory.
// See scripts/docs/readability.ts for what each rule measures.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { dropGitIgnored } from "../lib/gitIgnored";
import {
  checkPage,
  failingFindings,
  formatFinding,
  parseConfig,
  sectionFor,
  type Finding,
  type ReadabilityConfig,
} from "./readability";

const ROOT = join(import.meta.dir, "..", "..");
const DEFAULT_CONFIG = join(import.meta.dir, "readability-budgets.json");

/** Normalizes a `--files` list to the unique, sorted Markdown pages under docs/ that exist. */
export function selectDocsPages(
  files: readonly string[],
  exists: (file: string) => boolean,
): string[] {
  const pages = files
    .map((file) => file.split("\\").join("/").replace(/^\.\//, ""))
    .filter((file) => file.startsWith("docs/") && file.endsWith(".md") && exists(file));
  return [...new Set(pages)].sort();
}

export function checkRepository(
  root: string,
  config: ReadabilityConfig,
  only?: readonly string[],
): Finding[] {
  const candidates =
    only ??
    Array.from(new Glob("docs/**/*.md").scanSync({ cwd: root })).map((file) =>
      file.split("\\").join("/"),
    );
  const files = dropGitIgnored(root, [...candidates]).sort();
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

export function githubAnnotation(finding: Finding, failing: boolean): string {
  const message = `${finding.rule}: ${finding.message}`.replaceAll("%", "%25");
  const level = failing ? "error" : "warning";
  return `::${level} file=${finding.file},line=${finding.line},title=Docs readability::${message}`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");
  const configPath = configIndex >= 0 ? args[configIndex + 1] : DEFAULT_CONFIG;
  if (!configPath) {
    console.error(
      "usage: check-readability.ts [--config <file>] [--github] [--strict] [--files <path>...]",
    );
    process.exit(2);
  }
  const config = parseConfig(JSON.parse(readFileSync(configPath, "utf8")));
  const filesIndex = args.indexOf("--files");
  const only =
    filesIndex >= 0
      ? selectDocsPages(args.slice(filesIndex + 1), (file) => existsSync(join(ROOT, file)))
      : undefined;
  if (only) {
    console.log(`Checking ${only.length} docs page(s):`);
    for (const file of only) {
      console.log(`  ${file}`);
    }
  }
  const findings = checkRepository(ROOT, config, only);
  const failing = new Set(failingFindings(config, findings, args.includes("--strict")));
  for (const finding of findings) {
    console.log(formatFinding(finding));
  }
  if (args.includes("--github")) {
    for (const finding of findings) {
      console.log(githubAnnotation(finding, failing.has(finding)));
    }
  }
  console.log(`\nDocs readability summary (${findings.length} finding(s)):`);
  for (const row of summarize(config, findings)) {
    console.log(`  ${row}`);
  }
  if (failing.size > 0) {
    console.log(`${failing.size} finding(s) fail the check (enforced section or --strict).`);
    process.exit(1);
  }
}

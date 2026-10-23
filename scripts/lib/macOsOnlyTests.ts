#!/usr/bin/env bun
/**
 * Classification of test files that only make sense on a macOS host.
 *
 * Owner rule (2026-10-23): iOS tests never run on Linux or Windows. Rather than
 * guarding hundreds of files one by one, `scripts/test-ts.sh` asks this module
 * which test files to leave out on a non-macOS host. The classification is:
 *
 *   1. The first matching rule in `test/macos-only-tests.txt` wins (`macos` or
 *      `portable`, each with a reason).
 *   2. Otherwise a test whose path has an iOS token (`ios`, `simctl`,
 *      `devicectl`, `simulator`, `xcode*`, as a directory or camelCase word)
 *      is macOS-only.
 *   3. Everything else runs everywhere. When unsure, a test keeps running.
 *
 * The runtime decision only reads the path and the manifest; the import-based
 * guard in `test/lint/macOsOnlyTestClassification.integration.test.ts` keeps
 * the manifest honest (see `scripts/lib/iosTestImportSignal.ts`).
 *
 * CLI (all read/write repo-relative POSIX paths):
 *   list                         every macOS-only test file under test/
 *   write-bunfig <out>           bunfig.toml copy that also ignores them
 *   report [--markdown]          count line on stderr; step-summary markdown on stdout
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type Verdict = "macos" | "portable";

export interface ManifestRule {
  verdict: Verdict;
  pattern: string;
  reason: string;
  /** 1-based line in the manifest, for diagnostics. */
  line: number;
}

export type ClassificationSource = "manifest-macos" | "manifest-portable" | "path-token" | "none";

export interface Classification {
  macosOnly: boolean;
  source: ClassificationSource;
  rule?: ManifestRule;
}

/** Words that mark a test (or the source it exercises) as iOS/Apple-host only. */
export const IOS_PATH_TOKENS: ReadonlySet<string> = new Set([
  "ios",
  "simctl",
  "devicectl",
  "simulator",
  "simulators",
  "xcode",
  "xcodegen",
  "xcodebuild",
  "xcrun",
  "xctestrunner",
]);

/** Splits a path into lower-case words on separators and camelCase/acronym boundaries. */
export function pathTokens(filePath: string): string[] {
  return filePath
    .replace(/iOS/g, "ios")
    .split(/[^A-Za-z0-9]+/)
    .flatMap((segment) => segment.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? [])
    .map((token) => token.toLowerCase());
}

export function hasIosPathToken(filePath: string): boolean {
  return pathTokens(filePath).some((token) => IOS_PATH_TOKENS.has(token));
}

/** Parses `verdict pattern # reason` lines. Every rule needs a reason. */
export function parseManifest(text: string): ManifestRule[] {
  const rules: ManifestRule[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      return;
    }
    const separator = line.indexOf(" # ");
    const body = separator === -1 ? line : line.slice(0, separator).trim();
    const reason = separator === -1 ? "" : line.slice(separator + 3).trim();
    const [verdict, pattern, ...extra] = body.split(/\s+/);
    const where = `macos-only-tests manifest line ${index + 1}`;
    if (verdict !== "macos" && verdict !== "portable") {
      throw new Error(`${where}: verdict must be "macos" or "portable", got "${verdict}"`);
    }
    if (!pattern || extra.length > 0) {
      throw new Error(`${where}: expected "${verdict} <path-or-glob> # <reason>"`);
    }
    if (reason === "") {
      throw new Error(`${where}: "${pattern}" needs a "# <reason>" explaining the verdict`);
    }
    rules.push({ verdict, pattern, reason, line: index + 1 });
  });
  return rules;
}

const globCache = new Map<string, Bun.Glob>();

export function patternMatches(pattern: string, filePath: string): boolean {
  let glob = globCache.get(pattern);
  if (!glob) {
    glob = new Bun.Glob(pattern);
    globCache.set(pattern, glob);
  }
  return glob.match(filePath);
}

/** Repo-relative POSIX form: no leading `./`, forward slashes. */
export function normalizeTestPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

export function classifyTestPath(rawPath: string, rules: readonly ManifestRule[]): Classification {
  const filePath = normalizeTestPath(rawPath);
  const rule = rules.find((candidate) => patternMatches(candidate.pattern, filePath));
  if (rule) {
    return {
      macosOnly: rule.verdict === "macos",
      source: rule.verdict === "macos" ? "manifest-macos" : "manifest-portable",
      rule,
    };
  }
  return hasIosPathToken(filePath)
    ? { macosOnly: true, source: "path-token" }
    : { macosOnly: false, source: "none" };
}

export function partitionTestPaths(
  paths: readonly string[],
  rules: readonly ManifestRule[],
): { run: string[]; skipped: string[] } {
  const run: string[] = [];
  const skipped: string[] = [];
  for (const filePath of paths) {
    (classifyTestPath(filePath, rules).macosOnly ? skipped : run).push(filePath);
  }
  return { run, skipped };
}

/** Pure bunfig rewrite: the repo bunfig plus extra `pathIgnorePatterns`. */
export function renderSkipBunfig(bunfigText: string, extraIgnores: readonly string[]): string {
  const config: unknown = Bun.TOML.parse(bunfigText);
  if (typeof config !== "object" || config === null || !("test" in config)) {
    throw new Error("Expected a [test] section in bunfig.toml");
  }
  const test: unknown = config.test;
  const expected = ["coverageDir", "coverageReporter", "pathIgnorePatterns", "preload"];
  if (
    Object.keys(config).some((key) => key !== "test") ||
    typeof test !== "object" ||
    test === null ||
    Object.keys(test).some((key) => !expected.includes(key))
  ) {
    throw new Error("Unsupported bunfig.toml settings; update the macOS-only skip config writer");
  }
  const lists = new Map<string, string[]>();
  for (const [key, value] of Object.entries(test)) {
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
      lists.set(key, value);
    } else if (typeof value !== "string") {
      throw new Error(`Unsupported bunfig.toml [test] ${key} value; expected string or list`);
    }
  }
  lists.set("pathIgnorePatterns", [...(lists.get("pathIgnorePatterns") ?? []), ...extraIgnores]);
  const scalars = Object.entries(test)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`);
  const arrays = [...lists].map(([key, value]) => `${key} = ${JSON.stringify(value)}\n`);
  return `[test]\n${[...arrays, ...scalars].join("")}`;
}

/** Every `*.test.ts` under `test/`, repo-relative with forward slashes. */
export function discoverTestFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const match of new Bun.Glob("test/**/*.test.ts").scanSync({ cwd: repoRoot })) {
    files.push(match.split(path.sep).join("/"));
  }
  return files.sort();
}

export function manifestPath(repoRoot: string): string {
  return path.join(repoRoot, "test", "macos-only-tests.txt");
}

export function loadManifest(repoRoot: string): ManifestRule[] {
  return parseManifest(readFileSync(manifestPath(repoRoot), "utf8"));
}

export interface SkipReport {
  total: number;
  integration: number;
  byRule: Map<string, number>;
  pathToken: number;
}

export function buildSkipReport(
  skipped: readonly string[],
  rules: readonly ManifestRule[],
): SkipReport {
  const byRule = new Map<string, number>();
  let pathToken = 0;
  for (const filePath of skipped) {
    const { source, rule } = classifyTestPath(filePath, rules);
    if (source === "path-token") {
      pathToken += 1;
    } else if (rule) {
      byRule.set(rule.pattern, (byRule.get(rule.pattern) ?? 0) + 1);
    }
  }
  return {
    total: skipped.length,
    integration: skipped.filter((filePath) => filePath.endsWith(".integration.test.ts")).length,
    byRule,
    pathToken,
  };
}

export function renderReportLine(report: SkipReport): string {
  return `test-ts: skipping ${report.total} macOS-only (iOS) test files on this host (${report.integration} integration); classification in test/macos-only-tests.txt`;
}

export function renderReportMarkdown(report: SkipReport, hostLabel: string): string {
  const rows = [`| iOS path token | ${report.pathToken} |`];
  for (const [pattern, count] of report.byRule) {
    rows.push(`| manifest \`${pattern}\` | ${count} |`);
  }
  return [
    `### macOS-only (iOS) test files skipped on ${hostLabel}`,
    "",
    `${report.total} files (${report.integration} integration) run only on macOS hosts. See \`test/macos-only-tests.txt\`.`,
    "",
    "| Classified by | Files |",
    "| --- | ---: |",
    ...rows,
    "",
  ].join("\n");
}

function main(argv: readonly string[]): number {
  const repoRoot = path.resolve(import.meta.dir, "../..");
  const [command, ...rest] = argv;
  const rules = loadManifest(repoRoot);
  const skippedAll = (): string[] => partitionTestPaths(discoverTestFiles(repoRoot), rules).skipped;
  switch (command) {
    case "list":
      process.stdout.write(
        skippedAll()
          .map((line) => `${line}\n`)
          .join(""),
      );
      return 0;
    case "write-bunfig": {
      const [output] = rest;
      if (!output) {
        console.error("Usage: macOsOnlyTests.ts write-bunfig <output>");
        return 2;
      }
      const bunfig = readFileSync(path.join(repoRoot, "bunfig.toml"), "utf8");
      writeFileSync(output, renderSkipBunfig(bunfig, skippedAll()));
      return 0;
    }
    case "report": {
      const report = buildSkipReport(skippedAll(), rules);
      console.error(renderReportLine(report));
      if (rest.includes("--markdown")) {
        process.stdout.write(`${renderReportMarkdown(report, process.platform)}\n`);
      }
      return 0;
    }
    default:
      console.error("Usage: macOsOnlyTests.ts {list|write-bunfig <out>|report [--markdown]}");
      return 2;
  }
}

if (import.meta.main) {
  // exitCode, not process.exit: exiting right after a large stdout write truncates piped output.
  process.exitCode = main(process.argv.slice(2));
}

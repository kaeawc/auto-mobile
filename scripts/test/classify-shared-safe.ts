#!/usr/bin/env bun
/**
 * Shared-process allow-list for the Node unit lane (#10583).
 *
 * `scripts/test-ts.sh unit` runs every unit file under `bun test --isolate`,
 * which re-creates a realm and re-imports the module graph per file. The study
 * in docs/design-docs/ci/unit-lane-scaling.md measured that as 83% of the
 * lane's wall time. The owner decision on #10583 is to run "tier C" files, the
 * ones with no static shared-state signal, together in shared (non-isolated)
 * processes, and keep everything else isolated.
 *
 * Tiers, from the static signals documented in the study:
 *
 * - **A (never shared)**: `mock.module`, patched natives or globals
 *   (`fs.x = …`, `globalThis.x = …`, `Object.defineProperty(globalThis …)`),
 *   `process.chdir`. These change the module registry or process-wide state,
 *   and `afterEach` cannot reliably undo them.
 * - **B (isolated)**: `spyOn`, `process.env` writes, singleton access or reset,
 *   the database helpers, `testOverrides`, Bun system time. Safe only when every
 *   test restores, which a static check cannot prove.
 * - **C (shared)**: none of the above.
 *
 * This script writes `test/shared-process-allowlist.txt`, the tier C unit
 * files minus {@link SHARED_PROCESS_EXCLUSIONS}. `--check` fails when a listed
 * file is no longer tier C (it gained a signal), no longer exists or is not a
 * unit-lane file, is excluded, or when the list is unsorted or has duplicates.
 * A new tier C file that is not listed yet is NOT a failure: unlisted files
 * run isolated, so the check only reports them as candidates.
 *
 *   bun scripts/test/classify-shared-safe.ts           # regenerate the list
 *   bun scripts/test/classify-shared-safe.ts --check   # CI gate (Fast Validation)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type Tier = "A" | "B" | "C";

export interface SignalRule {
  readonly name: string;
  readonly tier: "A" | "B";
  readonly pattern: RegExp;
}

/**
 * The study's static signals, matched against the test file's own source.
 * Comments and strings are deliberately not stripped: a false positive only
 * keeps a file isolated, which is the safe direction.
 */
export const SIGNAL_RULES: readonly SignalRule[] = [
  { name: "mockModule", tier: "A", pattern: /\bmock\.module\(/ },
  {
    name: "globalWrite",
    tier: "A",
    pattern:
      /\b(?:globalThis|global)\.[A-Za-z_$][\w$]*\s*=(?!=)|Object\.defineProperty\((?:globalThis|global|process)\b/,
  },
  { name: "chdir", tier: "A", pattern: /process\.chdir/ },
  {
    name: "nativePatch",
    tier: "A",
    pattern: /\b(?:childProcess|Bun|fs|process)\.[A-Za-z]+\s*=(?!=)/,
  },
  { name: "spyOn", tier: "B", pattern: /\bspyOn\(/ },
  {
    name: "db",
    tier: "B",
    pattern:
      /getDatabase|createTestDatabase|navigationTestHarness|inMemorySingletonDatabase|tempFileDatabase|withFileBackedDb/,
  },
  {
    name: "envWrite",
    tier: "B",
    pattern: /process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])\s*=(?!=)|delete process\.env/,
  },
  { name: "testOverrides", tier: "B", pattern: /\btestOverrides\b/ },
  {
    name: "singleton",
    tier: "B",
    pattern:
      /getInstance\(|resetInstance|resetForTesting|\.instance\s*=(?!=)|__reset|setInstance\(|resetSingleton/,
  },
  { name: "setSystemTime", tier: "B", pattern: /setSystemTime|useFakeTimers/ },
  // Added after the study, from randomized shared runs (#10583): module-level
  // setters and resets (`setObserveCacheStore(…)`, `setDeviceToolsDependencies(…)`,
  // `resetAdbClientCaches()`, `X.resetForTests()`) are process-wide state the
  // study's singleton pattern missed. Three such files failed in shared random
  // orders. Only free-function calls match, so `fake.setX()` does not; the
  // timer globals are not state.
  {
    name: "moduleState",
    tier: "B",
    pattern:
      /(?<![.\w$])(?:reset[A-Z]\w*|set(?!Immediate\b|Timeout\b|Interval\b)[A-Z]\w*)\(|\.resetForTests?\(/,
  },
];

/**
 * Tier C files that must stay isolated anyway, keyed by path with the reason.
 * Add an entry when the nightly randomized lane shows a file depends on, or
 * leaks, cross-file state that the static signals miss.
 */
export const SHARED_PROCESS_EXCLUSIONS: Readonly<Record<string, string>> = {
  "test/features/action/ClearAppData.test.ts":
    "its production DefaultDeviceWindowCacheInvalidator marks a pending window resolution " +
    "for device-123 in a module-level map that later files read",
  "test/features/action/BaseVisualChange.uiStability.test.ts":
    "reads the module-level pending window resolution for device-123; failed after " +
    "ClearAppData in a shared random order (seed 8)",
};

export const ALLOWLIST_PATH = "test/shared-process-allowlist.txt";

export interface Classification {
  readonly tier: Tier;
  readonly signals: readonly string[];
}

export function classifySource(source: string): Classification {
  const hits = SIGNAL_RULES.filter((rule) => rule.pattern.test(source));
  const tier: Tier = hits.some((rule) => rule.tier === "A") ? "A" : hits.length > 0 ? "B" : "C";
  return { tier, signals: hits.map((rule) => rule.name) };
}

/** Mirrors discover_unit_test_files in scripts/test-ts.sh. */
export function isUnitTestPath(path: string): boolean {
  return (
    path.startsWith("test/") &&
    path.endsWith(".test.ts") &&
    !path.endsWith(".integration.test.ts") &&
    !path.startsWith("test/stress/")
  );
}

export function parseAllowlist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

const ALLOWLIST_HEADER = [
  "# Unit test files that run together in shared (non-isolated) Bun processes.",
  "# Every other unit file runs under `bun test --isolate` (#10583).",
  "#",
  "# Generated by `bun scripts/test/classify-shared-safe.ts`; do not edit by hand.",
  "# Fast Validation runs it with --check. A listed file that gains a tier A/B",
  "# signal (mock.module, global or native patching, chdir, spyOn, env writes,",
  "# singletons, the DB helpers, testOverrides, system time) fails the check;",
  "# regenerate to move it back to the isolated group. New files run isolated",
  "# until the list is regenerated. See docs/design-docs/ci/unit-lane-scaling.md.",
];

export function renderAllowlist(paths: readonly string[]): string {
  return `${[...ALLOWLIST_HEADER, ...paths].join("\n")}\n`;
}

export interface UnitFile {
  readonly path: string;
  readonly source: string;
}

export function buildAllowlist(
  files: readonly UnitFile[],
  exclusions: Readonly<Record<string, string>> = SHARED_PROCESS_EXCLUSIONS,
): string[] {
  return files
    .filter((file) => isUnitTestPath(file.path) && !(file.path in exclusions))
    .filter((file) => classifySource(file.source).tier === "C")
    .map((file) => file.path)
    .sort();
}

export interface AllowlistCheck {
  /** Each entry fails the check. */
  readonly problems: readonly string[];
  /** Tier C files not listed yet; informational (they run isolated). */
  readonly candidates: readonly string[];
}

export function checkAllowlist(
  listed: readonly string[],
  files: readonly UnitFile[],
  exclusions: Readonly<Record<string, string>> = SHARED_PROCESS_EXCLUSIONS,
): AllowlistCheck {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const problems: string[] = [];
  const seen = new Set<string>();
  listed.forEach((path, index) => {
    if (seen.has(path)) {
      problems.push(`${path}: listed more than once`);
    }
    seen.add(path);
    if (index > 0 && listed[index - 1] > path) {
      problems.push(`${path}: out of order (the list must be sorted)`);
    }
    const file = byPath.get(path);
    if (!isUnitTestPath(path) || !file) {
      problems.push(`${path}: not an existing unit-lane test file (stale entry)`);
      return;
    }
    if (path in exclusions) {
      problems.push(`${path}: excluded from shared processes (${exclusions[path]})`);
      return;
    }
    const { tier, signals } = classifySource(file.source);
    if (tier !== "C") {
      problems.push(
        `${path}: gained tier ${tier} signal(s) ${signals.join(", ")}; it must run isolated`,
      );
    }
  });
  const candidates = buildAllowlist(files, exclusions).filter((path) => !seen.has(path));
  return { problems, candidates };
}

export interface CliIo {
  listUnitFiles(): UnitFile[];
  readAllowlist(): string | undefined;
  writeAllowlist(text: string): void;
  log(message: string): void;
  error(message: string): void;
}

const REGENERATE_HINT = "Run `bun scripts/test/classify-shared-safe.ts` and commit the result.";

export function runCli(argv: readonly string[], io: CliIo): number {
  const unknown = argv.filter((arg) => arg !== "--check");
  if (unknown.length > 0) {
    io.error(`Unknown argument(s): ${unknown.join(" ")}. Usage: classify-shared-safe.ts [--check]`);
    return 2;
  }
  const files = io.listUnitFiles();
  if (!argv.includes("--check")) {
    const paths = buildAllowlist(files);
    io.writeAllowlist(renderAllowlist(paths));
    io.log(`Wrote ${ALLOWLIST_PATH}: ${paths.length} of ${files.length} unit files run shared.`);
    return 0;
  }
  const text = io.readAllowlist();
  if (text === undefined) {
    io.error(`${ALLOWLIST_PATH} is missing. ${REGENERATE_HINT}`);
    return 1;
  }
  const listed = parseAllowlist(text);
  const { problems, candidates } = checkAllowlist(listed, files);
  if (candidates.length > 0) {
    io.log(
      `${candidates.length} tier C unit file(s) are not listed and run isolated; ` +
        `regenerate to share them: ${candidates.slice(0, 10).join(", ")}${candidates.length > 10 ? ", …" : ""}`,
    );
  }
  if (problems.length > 0) {
    io.error(`${ALLOWLIST_PATH} is stale (${problems.length} problem(s)):`);
    for (const problem of problems) {
      io.error(`  ${problem}`);
    }
    io.error(REGENERATE_HINT);
    return 1;
  }
  io.log(`${ALLOWLIST_PATH}: ${listed.length} shared unit files, all tier C.`);
  return 0;
}

function discoverTestFiles(root: string, directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return discoverTestFiles(root, path);
    }
    return entry.isFile() && entry.name.endsWith(".test.ts")
      ? [relative(root, path).split(sep).join("/")]
      : [];
  });
}

export function fileSystemIo(root: string): CliIo {
  const allowlistFile = join(root, ALLOWLIST_PATH);
  return {
    listUnitFiles: () =>
      discoverTestFiles(root, join(root, "test"))
        .filter(isUnitTestPath)
        .sort()
        .map((path) => ({ path, source: readFileSync(join(root, path), "utf8") })),
    readAllowlist: () =>
      existsSync(allowlistFile) ? readFileSync(allowlistFile, "utf8") : undefined,
    writeAllowlist: (text) => writeFileSync(allowlistFile, text),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  };
}

if (import.meta.main) {
  process.exit(runCli(process.argv.slice(2), fileSystemIo(join(import.meta.dir, "../.."))));
}

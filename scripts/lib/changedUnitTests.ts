import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";
import { parseAlwaysRun, selectAffectedTests } from "./affectedTests";
import { relativeModuleSpecifiers } from "./tsImportDeps";

const scanners = {
  ts: new Bun.Transpiler({ loader: "ts", treeShaking: false, trimUnusedImports: false }),
  tsx: new Bun.Transpiler({ loader: "tsx", treeShaking: false, trimUnusedImports: false }),
};

/** Retain lexical relative edges even when Bun's public scanner folds dead code. */
export function scanChangedImports(file: string, source: string): string[] {
  const scanner = /\.[jt]sx$/.test(file) ? scanners.tsx : scanners.ts;
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false);
  return [
    ...new Set([
      ...scanner.scan(source).imports.map((entry) => entry.path),
      ...relativeModuleSpecifiers(ast, { includeNonRelative: true, includeTypeOnly: false }),
    ]),
  ];
}

export interface ChangedGraphReader {
  read(file: string): string;
  imports(file: string, source: string): string[];
  resolve(specifier: string, importer: string): string[];
}

/** Resolve both module conditions without evaluating the target module. */
export function resolveChangedImports(specifier: string, importer: string): string[] {
  if (isBuiltin(specifier) || specifier.startsWith("bun:")) {
    return [];
  }
  return [
    ...new Set(
      [
        // Bun.resolveSync takes a directory; createRequire takes a filename.
        Bun.resolveSync(specifier, path.dirname(importer)),
        createRequire(importer).resolve(specifier),
      ].filter(
        (resolved) =>
          path.isAbsolute(resolved) && !resolved.split(path.sep).includes("node_modules"),
      ),
    ),
  ];
}

/**
 * The graph drops node_modules edges, so nothing links a dependency bump to the
 * code importing that package; like native `--changed`, a manifest or lockfile
 * change selects all units (#14426).
 */
export const DEPENDENCY_MANIFESTS: readonly string[] = ["package.json", "bun.lock"];

/** `[test].preload` entries Bun loads before every test file, as repository-relative paths. */
export function bunfigPreloads(bunfig: string): string[] {
  const config: unknown = Bun.TOML.parse(bunfig);
  const test: unknown =
    typeof config === "object" && config !== null && "test" in config ? config.test : undefined;
  const preload: unknown =
    typeof test === "object" && test !== null && "preload" in test ? test.preload : [];
  const entries: unknown[] = Array.isArray(preload) ? preload : [preload];
  if (!entries.every((entry): entry is string => typeof entry === "string")) {
    throw new Error("bunfig.toml [test].preload must be a string or an array of strings");
  }
  return entries.map((entry) => path.posix.normalize(entry));
}

/** `--preload` paths the shared unit commands add, read by running their own configure function. */
export function unitCommandPreloads(root: string): string[] {
  // Root "." from cwd keeps native Windows paths out of bash and yields ./-relative preloads.
  const argv = execFileSync(
    "bash",
    [
      "-c",
      'source scripts/lib/bun-unit-test.sh && configure_bun_unit_test . Linux && printf "%s\\0" "${BUN_UNIT_TEST_COMMAND[@]}" "${BUN_UNIT_SHARED_TEST_COMMAND[@]}"',
    ],
    { cwd: root, encoding: "utf8" },
  ).split("\0");
  return [
    ...new Set(
      argv
        .filter((_, index) => argv[index - 1] === "--preload")
        .map((file) => path.posix.normalize(file)),
    ),
  ];
}

/**
 * Parse-only reverse closure; an uncertain local edge conservatively selects all units.
 * A changed `fullSuiteTriggers` file (a dependency manifest, or a global preload no test
 * imports) also selects all units.
 */
export function changedGraphTests(
  tests: string[],
  changed: string[],
  reader: ChangedGraphReader,
  fullSuiteTriggers: readonly string[] = DEPENDENCY_MANIFESTS,
): string[] {
  if (changed.length === 0) {
    return [];
  }
  const trigger = changed.find((file) => fullSuiteTriggers.includes(file));
  if (trigger !== undefined) {
    console.error(`${trigger} changed; selecting all unit files.`);
    return tests;
  }
  const reverse = new Map<string, Set<string>>();
  const visited = new Set<string>();
  const visit = (file: string): void => {
    if (visited.has(file)) {
      return;
    }
    visited.add(file);
    if (file.endsWith(".json")) {
      return;
    }
    if (!/\.[cm]?[jt]sx?$/.test(file)) {
      throw new Error(`unsupported graph loader: ${file}`);
    }
    for (const specifier of reader.imports(file, reader.read(file))) {
      for (const dependency of reader.resolve(specifier, file)) {
        const importers = reverse.get(dependency) ?? new Set<string>();
        importers.add(file);
        reverse.set(dependency, importers);
        visit(dependency);
      }
    }
  };
  try {
    for (const test of tests) {
      visit(test);
    }
  } catch (error) {
    console.error(`changed unit graph unavailable; selecting all unit files: ${String(error)}`);
    return tests;
  }
  const affected = new Set(changed);
  const queue = [...changed];
  for (let index = 0; index < queue.length; index++) {
    for (const importer of reverse.get(queue[index]) ?? []) {
      if (affected.has(importer)) {
        continue;
      }
      affected.add(importer);
      queue.push(importer);
    }
  }
  return tests.filter((file) => affected.has(file));
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "../..");
  const relative = (file: string): string => path.relative(root, file).split(path.sep).join("/");
  const canonical = (file: string): string => {
    try {
      return relative(realpathSync(path.resolve(root, file)));
    } catch {
      return relative(path.resolve(root, file));
    }
  };
  const git = (args: string[]): string[] =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map(canonical);
  // Same ref-to-worktree diff and untracked union as Bun 1.3.14 ChangedFilesFilter.zig.
  const changed = [
    ...new Set([
      ...git(["diff", "--name-only", "-z", process.argv[2] ?? "origin/main", "--"]),
      ...git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]),
    ]),
  ];
  const list = (directory: string): string[] =>
    readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const file = `${directory}/${entry.name}`;
      return entry.isDirectory() ? list(file) : [file];
    });
  const files = ["src", "test", "scripts"].flatMap(list);
  const tests = files
    .filter(
      (file) =>
        file.startsWith("test/") &&
        file.endsWith(".test.ts") &&
        !file.endsWith(".integration.test.ts") &&
        !file.startsWith("test/stress/"),
    )
    .sort();
  const read = (file: string): string => readFileSync(path.resolve(root, file), "utf8");
  // Preloads run before every unit file without an import edge (#14425).
  const preloads = [...bunfigPreloads(read("bunfig.toml")), ...unitCommandPreloads(root)];
  const graph = changedGraphTests(
    tests.map(canonical),
    changed,
    {
      read,
      imports: scanChangedImports,
      resolve: (specifier, importer) =>
        resolveChangedImports(specifier, path.resolve(root, importer)).map(canonical),
    },
    [...DEPENDENCY_MANIFESTS, ...preloads.map(canonical)],
  );
  const extras = selectAffectedTests({
    reader: {
      list: () => files.filter((file) => /\.(ts|tsx|mts)$/.test(file)).concat("package.json"),
      read,
    },
    changedFiles: changed,
    tierList: read("test/integration-safe-tier.txt"),
    alwaysRun: changed.length ? parseAlwaysRun(read("test/always-run-tests.txt")) : [],
  });
  const selected = new Set([...graph, ...extras.unit]);
  for (const file of tests) {
    if (selected.has(canonical(file)) || selected.has(file)) {
      console.log(file);
    }
  }
}

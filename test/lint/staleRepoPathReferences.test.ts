import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const root = join(import.meta.dir, "../..");

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

// Keep separators inside simple quotes in the same word (not a new command).
function commandWords(command: string): string[][] {
  const tokens =
    command.match(/(?:[^\s;&|"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+|&&|\|\||[;&|]/g) ?? [];
  const commands: string[][] = [[]];
  for (const token of tokens) {
    if (/^(?:&&|\|\||[;&|])$/.test(token)) {
      commands.push([]);
    } else {
      commands[commands.length - 1].push(
        token.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g, (_match, double, single, escaped) =>
          double !== undefined ? double.replace(/\\(["\\])/g, "$1") : (single ?? escaped),
        ),
      );
    }
  }
  return commands;
}

function invokedPaths(words: readonly string[]): string[] {
  const commandIndex = words.findIndex((word) => !/^[A-Za-z_][\w]*=/.test(word));
  const command = words[commandIndex];
  if (!command) {
    return [];
  }
  const isFile = (word: string): boolean =>
    !word.startsWith("-") &&
    !word.startsWith("/") &&
    !/^[A-Za-z_][\w]*=/.test(word) &&
    !/[$*]|:\/\//.test(word) &&
    /\.(?:sh|ts|mts|js|mjs|cjs)$/.test(word);
  if (command.startsWith("./")) {
    return isFile(command) ? [command.slice(2)] : [];
  }
  if (!["bash", "sh", "bun", "node", "tsx"].includes(command)) {
    return [];
  }
  const args = words.slice(commandIndex + 1);
  // The repository also invokes pipelines via bash -o pipefail -c '...'.
  if (["bash", "sh"].includes(command) && args.includes("-c")) {
    return scriptPaths({ nested: args[args.indexOf("-c") + 1] ?? "" });
  }
  if (args.some((arg) => ["-e", "--eval", "-p", "--print"].includes(arg))) {
    return [];
  }
  const targetIndex = args.findIndex(
    (arg) => !arg.startsWith("-") && !(command === "bun" && arg === "run"),
  );
  const target = args[targetIndex];
  if (command === "bun" && target === "tsx") {
    return invokedPaths(args.slice(targetIndex));
  }
  return target && isFile(target) ? [target.replace(/^\.\//, "")] : [];
}

function scriptPaths(scripts: Record<string, string>): string[] {
  return Object.values(scripts).flatMap((command) => commandWords(command).flatMap(invokedPaths));
}

type FilterReader = (path: string) => string | undefined;

function filterRules(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(filterRules);
  }
  return Object.entries(record(value)).flatMap(([status, rules]) =>
    /^(?:added|modified|deleted)(?:\|(?:added|modified|deleted))*$/.test(status)
      ? typeof rules === "string"
        ? [rules]
        : strings(rules)
      : [],
  );
}

function filterPaths(document: unknown, readFile: FilterReader = () => undefined): string[] {
  const paths: string[] = [];
  for (const event of Object.values(record(record(document).on))) {
    const config = record(event);
    paths.push(...strings(config.paths), ...strings(config["paths-ignore"]));
  }
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const node = record(value);
    const filters = record(node.with).filters;
    if (typeof filters === "string") {
      let parsed = load(filters);
      if (typeof parsed === "string") {
        const path = parsed.replace(/^\.\//, "");
        paths.push(path);
        const content = readFile(path);
        parsed = content === undefined ? undefined : load(content);
      }
      paths.push(...Object.values(record(parsed)).flatMap(filterRules));
    }
    Object.values(node).forEach(visit);
  }
  visit(document);
  return paths;
}

interface FileListing {
  files: readonly string[];
  paths: ReadonlySet<string>;
}

function missingPaths(references: readonly string[], listing: FileListing): string[] {
  return [...new Set(references)].filter((path) => {
    if (path.startsWith("!")) {
      return false;
    }
    const segments = path.split("/");
    const globIndex = segments.findIndex((segment) => /[*?{[]/.test(segment));
    if (globIndex === -1) {
      return !listing.paths.has(path);
    }
    const prefix = segments.slice(0, globIndex).join("/");
    return prefix !== "" && !listing.paths.has(prefix);
  });
}

// Scan once outside timed tests. Exclude generated output and checkout/cache trees
// so a local build cannot make a stale literal or fixed glob prefix appear valid.
function listRepositoryFiles(): FileListing {
  const excluded = new Set([
    "node_modules",
    ".git",
    ".jj",
    "dist",
    "scratch",
    ".claude",
    ".gradle",
    ".build",
    "build",
    ".cache",
    ".turbo",
    ".intellijPlatform",
  ]);
  const files: string[] = [];
  const paths = new Set<string>();
  function walk(directory: string): void {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (excluded.has(entry.name) || (!directory && ["coverage", "site"].includes(entry.name))) {
        continue;
      }
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      paths.add(path);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        files.push(path);
      }
    }
  }
  walk("");
  return { files, paths };
}

let missingScripts: string[];
let missingFilters: string[];
beforeAll(() => {
  const listing = listRepositoryFiles();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  missingScripts = missingPaths(scriptPaths(pkg.scripts), listing);
  const yamlFiles = listing.files.filter(
    (path) =>
      /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path) ||
      /^\.github\/actions\/.*\.ya?ml$/.test(path),
  );
  missingFilters = yamlFiles.flatMap((path) =>
    missingPaths(
      filterPaths(load(readFileSync(join(root, path), "utf8")), (filterPath) =>
        listing.files.includes(filterPath)
          ? readFileSync(join(root, filterPath), "utf8")
          : undefined,
      ),
      listing,
    ).map((missing) => `${path}: ${missing}`),
  );
});

describe("repository path references", () => {
  test("package scripts reference existing files", () => {
    expect(missingScripts).toEqual([]);
  });
  test("workflow and composite-action filters reference existing paths", () => {
    expect(missingFilters).toEqual([]);
  });
  test("extracts script tokens from command strings", () => {
    expect(
      scriptPaths({
        run: 'bash scripts/local-dev/watch.sh && bun "scripts/check.ts"; node scripts/tool.mjs',
      }),
    ).toEqual(["scripts/local-dev/watch.sh", "scripts/check.ts", "scripts/tool.mjs"]);
  });
  test("extracts invoked files across runners, quotes, and command separators", () => {
    expect(
      scriptPaths({
        lifecycle: "node scripts/npm/transform-readme.js",
        runners: "bun run scripts/x.ts || tsx tools/x.mts | bun --bun tsx tools/y.cjs",
        direct: "./scripts/foo.sh; FOO=bar bash 'scripts/quoted path.sh'",
        flags: "bun --watch src/index.ts && bun --expose-gc scripts/memory.ts",
        nested: "bash -o pipefail -c 'bun tools/a.ts | bash scripts/b.sh'",
        root: "bun build.ts && sh ./tools/test.sh",
      }),
    ).toEqual([
      "scripts/npm/transform-readme.js",
      "scripts/x.ts",
      "tools/x.mts",
      "tools/y.cjs",
      "scripts/foo.sh",
      "scripts/quoted path.sh",
      "src/index.ts",
      "scripts/memory.ts",
      "tools/a.ts",
      "scripts/b.sh",
      "build.ts",
      "tools/test.sh",
    ]);
  });
  test("ignores binaries, script names, flags, expansions, URLs, and ordinary arguments", () => {
    expect(
      scriptPaths({
        names: "bun run lint && turbo run build && oxlint",
        args: "echo scripts/foo.ts && node --foo.ts && node FOO=bar.ts && node run scripts/not-invoked.ts && chmod +x dist/src/index.js",
        dynamic: 'bun "$SCRIPT.ts"; bash scripts/*.sh; node https://example.com/x.js',
        quoted: "echo 'ignored.sh && ./ignored.sh'",
        eval: "node -e 'scripts/foo.js'",
      }),
    ).toEqual([]);
  });
  test("reads file-backed filters through an injected reader and rejects stale rules", () => {
    const files = [".github/filters.yaml", "src/current.ts"];
    const references = filterPaths(
      load("jobs: {check: {steps: [{with: {filters: .github/filters.yaml}}]}}"),
      (path) =>
        path === ".github/filters.yaml" ? "code: [src/removed.ts, src/current.ts]" : undefined,
    );
    expect(references).toEqual([".github/filters.yaml", "src/removed.ts", "src/current.ts"]);
    expect(missingPaths(references, { files, paths: new Set(files) })).toEqual(["src/removed.ts"]);
  });
  test("reports a missing filter file through the same missing-path flow", () => {
    const references = filterPaths(
      load("jobs: {check: {steps: [{with: {filters: .github/missing.yaml}}]}}"),
      () => undefined,
    );
    expect(missingPaths(references, { files: [], paths: new Set() })).toEqual([
      ".github/missing.yaml",
    ]);
  });
  test("extracts change-status values and ignores unrelated mapping shapes", () => {
    const references = filterPaths(
      load(`
jobs:
  check:
    steps:
      - with:
          filters: |
            code:
              - added|modified: 'src/x.ts'
              - modified: ['src/y.ts', 'gone/**', '!ignored/**']
              - deleted: 'src/deleted.ts'
              - unrelated: 'src/ignored.ts'
              - added|unknown: 'src/ignored.ts'
              - added: {nested: 'src/ignored.ts'}
`),
    );
    expect(references).toEqual([
      "src/x.ts",
      "src/y.ts",
      "gone/**",
      "!ignored/**",
      "src/deleted.ts",
    ]);
    expect(missingPaths(references, { files: [], paths: new Set(["src"]) })).toEqual([
      "src/x.ts",
      "src/y.ts",
      "gone/**",
      "src/deleted.ts",
    ]);
  });
  test("parses event filters and embedded YAML structurally", () => {
    expect(
      filterPaths(
        load(`
on:
  push:
    paths: [src/**]
  pull_request:
    paths-ignore: [docs/**]
jobs:
  check:
    steps:
      - with:
          filters: |
            native:
              - 'ios/**'
              - '!ios/generated/**'
`),
      ),
    ).toEqual(["src/**", "docs/**", "ios/**", "!ios/generated/**"]);
  });
  test("rejects missing literals and fixed glob prefixes with an injected file listing", () => {
    const files = ["src/current.ts", ".github/workflows/ci.yml"];
    expect(
      missingPaths(
        [
          "src/current.ts",
          "src/removed.ts",
          "src/**",
          "src/*.nomatch",
          "gone/**",
          "!ignored/**",
          "src/{current,other}.ts",
          "src/curren?.ts",
          "src/[c]urrent.ts",
          ".github/**/*.yml",
          "**/*.nomatch",
          "*.nomatch",
          "{src,gone}/**",
          "src/missing/**",
        ],
        { files, paths: new Set([...files, "src", ".github", ".github/workflows"]) },
      ),
    ).toEqual(["src/removed.ts", "gone/**", "src/missing/**"]);
  });
});

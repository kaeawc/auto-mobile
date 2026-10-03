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

function scriptPaths(scripts: Record<string, string>): string[] {
  return Object.values(scripts).flatMap((command) =>
    [...command.matchAll(/\bscripts\/[\w./-]+\.(?:sh|ts|mjs)\b/g)].map((match) => match[0]),
  );
}

function filterPaths(document: unknown): string[] {
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
      for (const entries of Object.values(record(load(filters)))) {
        paths.push(...strings(entries));
      }
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
    missingPaths(filterPaths(load(readFileSync(join(root, path), "utf8"))), listing).map(
      (missing) => `${path}: ${missing}`,
    ),
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

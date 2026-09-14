import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  gitKnownPathLookup,
  resolveRelativeImportPaths,
  type KnownPathLookup,
} from "../../scripts/lib/tsImportDeps";

function fakeKnownPaths(...paths: string[]): KnownPathLookup {
  const known = new Set(paths);
  return { has: (candidate) => known.has(candidate) };
}

describe("resolveRelativeImportPaths", () => {
  let repoRoot: string;

  beforeEach(() => {
    mkdirSync(path.join(process.cwd(), "scratch"), { recursive: true });
    repoRoot = mkdtempSync(path.join(process.cwd(), "scratch/ts-import-deps-"));
    mkdirSync(path.join(repoRoot, "scripts/release/lib"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, "scripts/release/pin-runtime-deps.ts"),
      [
        'import { roots } from "./lib/runtime-roots";',
        'import { pins } from "./lib/runtime-pins.ts";',
        'import "./lib/cycle-a";',
        'import packageName from "typescript";',
        'import { readFileSync } from "node:fs";',
        "void roots; void pins; void packageName; void readFileSync;",
      ].join("\n"),
    );
    writeFileSync(
      path.join(repoRoot, "scripts/release/lib/runtime-roots.ts"),
      'export { nested } from "./nested";\n',
    );
    writeFileSync(
      path.join(repoRoot, "scripts/release/lib/runtime-pins.ts"),
      "export const pins = [];\n",
    );
    writeFileSync(path.join(repoRoot, "scripts/release/lib/nested.ts"), 'import "./cycle-a";\n');
    writeFileSync(path.join(repoRoot, "scripts/release/lib/cycle-a.ts"), 'import "./cycle-b";\n');
    writeFileSync(path.join(repoRoot, "scripts/release/lib/cycle-b.ts"), 'import "./cycle-a";\n');
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test("resolves relative imports through two levels without following packages or cycles", () => {
    expect(
      resolveRelativeImportPaths(path.join(repoRoot, "scripts/release/pin-runtime-deps.ts"), {
        repoRoot,
      }),
    ).toEqual([
      "scripts/release/lib/cycle-a.ts",
      "scripts/release/lib/cycle-b.ts",
      "scripts/release/lib/nested.ts",
      "scripts/release/lib/runtime-pins.ts",
      "scripts/release/lib/runtime-roots.ts",
    ]);
  });

  test("keeps a missing relative import in the dependency graph", () => {
    const entryFile = path.join(repoRoot, "scripts/release/missing-consumer.ts");
    writeFileSync(entryFile, 'import "./lib/deleted-helper";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/lib/deleted-helper.ts",
    ]);
  });

  test("preserves an existing explicit non-TypeScript extension", () => {
    writeFileSync(path.join(repoRoot, "scripts/release/config.json"), "{}\n");
    writeFileSync(path.join(repoRoot, "scripts/release/config.json.ts"), "export {};");
    const entryFile = path.join(repoRoot, "scripts/release/config-consumer.ts");
    writeFileSync(entryFile, 'import "./config.json";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/config.json",
    ]);
  });

  test("preserves a missing explicit TypeScript extension", () => {
    const entryFile = path.join(repoRoot, "scripts/release/deleted-consumer.ts");
    writeFileSync(entryFile, 'import "./helper.ts";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/helper.ts",
    ]);
  });

  test("resolves extensionless dotted imports to an existing TypeScript file", () => {
    writeFileSync(
      path.join(repoRoot, "scripts/release/lib/foo.test.ts"),
      "export const value = 1;\n",
    );
    const entryFile = path.join(repoRoot, "scripts/release/dotted-consumer.ts");
    writeFileSync(entryFile, 'import "./lib/foo.test";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/lib/foo.test.ts",
    ]);
  });

  test("resolves a directory import to its TypeScript index", () => {
    mkdirSync(path.join(repoRoot, "scripts/release/lib/nested-dir"), { recursive: true });
    writeFileSync(
      path.join(repoRoot, "scripts/release/lib/nested-dir/index.ts"),
      "export const value = 1;\n",
    );
    const entryFile = path.join(repoRoot, "scripts/release/directory-consumer.ts");
    writeFileSync(entryFile, 'import "./lib/nested-dir";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/lib/nested-dir/index.ts",
    ]);
  });

  test("prefers a TypeScript file over a directory index", () => {
    writeFileSync(path.join(repoRoot, "scripts/release/lib.ts"), "export const value = 1;\n");
    const entryFile = path.join(repoRoot, "scripts/release/lib-consumer.ts");
    writeFileSync(entryFile, 'import "./lib";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual(["scripts/release/lib.ts"]);
  });

  test("records import equals relative dependencies", () => {
    writeFileSync(path.join(repoRoot, "scripts/release/dep.ts"), "export const value = 1;\n");
    const entryFile = path.join(repoRoot, "scripts/release/import-equals-consumer.ts");
    writeFileSync(entryFile, 'import dep = require("./dep");\nvoid dep;\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual(["scripts/release/dep.ts"]);
  });

  test("records ordinary CommonJS require relative dependencies", () => {
    writeFileSync(path.join(repoRoot, "scripts/release/dep.ts"), "export const value = 1;\n");
    const entryFile = path.join(repoRoot, "scripts/release/require-consumer.ts");
    writeFileSync(entryFile, 'const dep = require("./dep");\nvoid dep;\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual(["scripts/release/dep.ts"]);
  });

  test("expands a diamond through the shallower path", () => {
    writeFileSync(
      path.join(repoRoot, "scripts/release/check.ts"),
      'import "./a";\nimport "./b";\n',
    );
    writeFileSync(path.join(repoRoot, "scripts/release/a.ts"), 'import "./b";\n');
    writeFileSync(path.join(repoRoot, "scripts/release/b.ts"), 'import "./c";\n');
    writeFileSync(path.join(repoRoot, "scripts/release/c.ts"), "export const value = 1;\n");

    expect(
      resolveRelativeImportPaths(path.join(repoRoot, "scripts/release/check.ts"), {
        repoRoot,
        maxDepth: 2,
      }),
    ).toEqual(["scripts/release/a.ts", "scripts/release/b.ts", "scripts/release/c.ts"]);
  });

  test("records dynamic relative imports", () => {
    writeFileSync(
      path.join(repoRoot, "scripts/release/dynamic-dep.ts"),
      "export const value = 1;\n",
    );
    const entryFile = path.join(repoRoot, "scripts/release/dynamic-consumer.ts");
    writeFileSync(entryFile, 'void import("./dynamic-dep");\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/dynamic-dep.ts",
    ]);
  });
  test("resolves a Node-style .js specifier to its TypeScript source", () => {
    writeFileSync(path.join(repoRoot, "scripts/release/dep.ts"), "export const value = 1;\n");
    const entryFile = path.join(repoRoot, "scripts/release/js-consumer.ts");
    writeFileSync(entryFile, 'import "./dep.js";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual(["scripts/release/dep.ts"]);
  });

  test("resolves .jsx, .mjs, and .cjs specifiers to their TypeScript sources", () => {
    writeFileSync(path.join(repoRoot, "scripts/release/view.tsx"), "export const value = 1;\n");
    writeFileSync(path.join(repoRoot, "scripts/release/esm.mts"), "export const value = 1;\n");
    writeFileSync(path.join(repoRoot, "scripts/release/cjs.cts"), "export const value = 1;\n");
    const entryFile = path.join(repoRoot, "scripts/release/variant-consumer.ts");
    writeFileSync(entryFile, 'import "./view.jsx";\nimport "./esm.mjs";\nimport "./cjs.cjs";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/cjs.cts",
      "scripts/release/esm.mts",
      "scripts/release/view.tsx",
    ]);
  });

  test("keeps an existing .js file when a .js specifier names one", () => {
    writeFileSync(path.join(repoRoot, "scripts/release/dep.js"), "module.exports = {};\n");
    writeFileSync(path.join(repoRoot, "scripts/release/dep.ts"), "export const value = 1;\n");
    const entryFile = path.join(repoRoot, "scripts/release/js-literal-consumer.ts");
    writeFileSync(entryFile, 'import "./dep.js";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual(["scripts/release/dep.js"]);
  });

  test("keeps a missing .js specifier literally when no source substitute exists", () => {
    const entryFile = path.join(repoRoot, "scripts/release/js-missing-consumer.ts");
    writeFileSync(entryFile, 'import "./gone.js";\n');

    expect(resolveRelativeImportPaths(entryFile, { repoRoot })).toEqual([
      "scripts/release/gone.js",
    ]);
  });

  test("records a deleted .ts source behind a .js specifier when git knew it", () => {
    const entryFile = path.join(repoRoot, "scripts/release/js-deleted-consumer.ts");
    writeFileSync(entryFile, 'import "./gone.js";\n');

    expect(
      resolveRelativeImportPaths(entryFile, {
        repoRoot,
        knownPaths: fakeKnownPaths("scripts/release/gone.ts"),
      }),
    ).toEqual(["scripts/release/gone.ts"]);
  });

  test("keeps a deleted .tsx target of an extensionless import when git knew it", () => {
    const entryFile = path.join(repoRoot, "scripts/release/deleted-tsx-consumer.ts");
    writeFileSync(entryFile, 'import "./view";\n');

    expect(
      resolveRelativeImportPaths(entryFile, {
        repoRoot,
        knownPaths: fakeKnownPaths("scripts/release/view.tsx"),
      }),
    ).toEqual(["scripts/release/view.tsx"]);
  });

  test("keeps a deleted directory index target of an extensionless import when git knew it", () => {
    const entryFile = path.join(repoRoot, "scripts/release/deleted-index-consumer.ts");
    writeFileSync(entryFile, 'import "./lib/nested-dir";\n');

    expect(
      resolveRelativeImportPaths(entryFile, {
        repoRoot,
        knownPaths: fakeKnownPaths("scripts/release/lib/nested-dir/index.ts"),
      }),
    ).toEqual(["scripts/release/lib/nested-dir/index.ts"]);
  });

  test("retains every git-known candidate when an extensionless target is deleted", () => {
    const entryFile = path.join(repoRoot, "scripts/release/ambiguous-consumer.ts");
    writeFileSync(entryFile, 'import "./helper";\n');

    expect(
      resolveRelativeImportPaths(entryFile, {
        repoRoot,
        knownPaths: fakeKnownPaths("scripts/release/helper.ts", "scripts/release/helper.tsx"),
      }),
    ).toEqual(["scripts/release/helper.ts", "scripts/release/helper.tsx"]);
  });

  test("prefers an existing file over git-known deleted candidates", () => {
    writeFileSync(path.join(repoRoot, "scripts/release/helper.ts"), "export const value = 1;\n");
    const entryFile = path.join(repoRoot, "scripts/release/existing-consumer.ts");
    writeFileSync(entryFile, 'import "./helper";\n');

    expect(
      resolveRelativeImportPaths(entryFile, {
        repoRoot,
        knownPaths: fakeKnownPaths("scripts/release/helper.tsx"),
      }),
    ).toEqual(["scripts/release/helper.ts"]);
  });

  test("git-known path lookup unions the index with the merge-base tree and tolerates git failures", () => {
    const calls: string[][] = [];
    const runner = (file: string, args: string[]): string => {
      calls.push([file, ...args]);
      const subcommand = args[2];
      if (subcommand === "ls-files") {
        return "a.ts\0b/index.ts\0";
      }
      if (subcommand === "merge-base") {
        return "abc123\n";
      }
      if (subcommand === "ls-tree") {
        return "c.tsx\0";
      }
      throw new Error(`unexpected git call ${args.join(" ")}`);
    };
    const lookup = gitKnownPathLookup(repoRoot, "origin/main", runner);

    expect(calls).toEqual([]);
    expect(lookup.has("a.ts")).toBe(true);
    expect(lookup.has("b/index.ts")).toBe(true);
    expect(lookup.has("c.tsx")).toBe(true);
    expect(lookup.has("missing.ts")).toBe(false);
    expect(calls).toEqual([
      ["git", "-C", repoRoot, "ls-files", "-z"],
      ["git", "-C", repoRoot, "merge-base", "origin/main", "HEAD"],
      ["git", "-C", repoRoot, "ls-tree", "-r", "-z", "--name-only", "abc123"],
    ]);

    const failing = gitKnownPathLookup(repoRoot, undefined, () => {
      throw new Error("not a git repository");
    });
    expect(failing.has("a.ts")).toBe(false);
  });
});

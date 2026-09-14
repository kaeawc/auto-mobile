import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveRelativeImportPaths } from "../../scripts/lib/tsImportDeps";

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
});
